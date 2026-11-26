using System.ComponentModel;
using System.Diagnostics;
using System.Text;

namespace Moye;

internal sealed partial class EditorWindow
{
    private static readonly UTF8Encoding GitEncoding = new(false);
    private NoteCommit? pendingCommit;

    private sealed record NoteChange(string Path, string Status)
    {
        public string Kind => Status == "??" || Status.Contains('A') ? "新增" :
            Status.Contains('D') ? "删除" : "修改";
    }

    private sealed record NoteCommit(string Root, string Message, IReadOnlyList<NoteChange> Changes);
    private sealed class NoteGitException(string message) : Exception(message);

    private async Task<Response> PrepareNoteCommit()
    {
        pendingCommit = await ReadNoteChanges();
        return new Response(Commit: pendingCommit);
    }

    private async Task<Response> CommitNotes(string? message)
    {
        if (pendingCommit is not { } reviewed || string.IsNullOrWhiteSpace(message))
            return new Response(Error: "请先检查提交文件并填写提交说明。");

        var current = await ReadNoteChanges();
        if (current.Root != reviewed.Root || !reviewed.Changes.SequenceEqual(current.Changes))
        {
            pendingCommit = current;
            return new Response(Commit: current);
        }
        if (current.Changes.Count == 0)
            return new Response(Error: "没有可提交的笔记变更。");

        string paths = GitPaths(current.Changes);
        var untracked = current.Changes.Where(change => change.Status == "??").ToArray();
        if (untracked.Length > 0)
        {
            await RunGit(current.Root, GitPaths(untracked), "add", "--intent-to-add",
                "--pathspec-from-file=-", "--pathspec-file-nul");
        }
        try
        {
            await RunGit(current.Root, paths, "commit", "--only", "-m", message.Trim(),
                "--pathspec-from-file=-", "--pathspec-file-nul");
        }
        catch (NoteGitException error)
        {
            if (untracked.Length > 0)
            {
                try
                {
                    var remaining = (await ReadNoteChanges()).Changes
                        .Where(change => change.Status == " A" && untracked.Any(file => file.Path == change.Path)).ToArray();
                    if (remaining.Length > 0)
                        await RunGit(current.Root, GitPaths(remaining), "update-index", "--force-remove", "-z", "--stdin");
                }
                catch (NoteGitException cleanup)
                {
                    throw new NoteGitException(error.Message + "\n清理本次新增文件的暂存标记时失败：" + cleanup.Message);
                }
            }
            throw;
        }

        pendingCommit = null;
        string hash;
        try { hash = (await RunGit(current.Root, null, "rev-parse", "--short", "HEAD")).Trim(); }
        catch (NoteGitException) { hash = ""; }
        return new Response(CommitHash: hash);
    }

    private async Task<NoteCommit> ReadNoteChanges()
    {
        if (notesRoot is not { } folder || !Path.Exists(Path.Combine(folder, ".git")))
            throw new NoteGitException("请选择 Git 仓库根目录作为笔记仓库。");

        string output = await RunGit(folder, null, "status", "--porcelain=v1", "-z", "--untracked-files=all",
            "--no-renames", "--ignore-submodules=all");
        var changes = output.Split('\0', StringSplitOptions.RemoveEmptyEntries)
            .Where(item => item.Length > 3 && IsCommitNotePath(item[3..]))
            .Select(item => new NoteChange(item[3..], item[..2]))
            .OrderBy(item => item.Path, StringComparer.Ordinal)
            .ThenBy(item => item.Status, StringComparer.Ordinal)
            .ToArray();
        return new NoteCommit(folder, SuggestCommitMessage(changes), changes);
    }

    private static bool IsCommitNotePath(string path)
    {
        string[] parts = path.Split('/');
        if (parts.Length == 1) return IsRootNote(path);
        return !AppFolders.Contains(parts[0]) &&
            parts.All(part => part.Length > 0 && !part.StartsWith('.'));
    }

    private static string SuggestCommitMessage(IReadOnlyList<NoteChange> changes)
    {
        if (changes.Count == 0) return "";
        string[] notes = changes.Where(change => IsNoteFile(change.Path.Split('/')[^1]))
            .Select(change => Path.GetFileNameWithoutExtension(change.Path)).Distinct().ToArray();
        string[] folders = changes.Select(change => change.Path.Split('/')[0]).Distinct().ToArray();
        string action = changes[0].Kind;
        if (action == "修改" || changes.Any(change => change.Kind != action)) action = "更新";
        string[] subjects = notes.Length == 1 && folders.Length == 1 ? notes : folders;
        string summary = string.Join("、", subjects.Take(3));
        if (subjects.Length > 3) summary += $"等 {subjects.Length} 个目录";
        return $"{action}笔记：{summary}";
    }

    private static string GitPaths(IEnumerable<NoteChange> changes) =>
        string.Join('\0', changes.Select(change => change.Path).Distinct(StringComparer.Ordinal)) + '\0';

    private static Task<string> RunGit(string folder, string? input, params string[] args) =>
        RunGit(folder, input, default, null, args);

    private static Task<string> RunGit(string folder, CancellationToken cancellation, params string[] args) =>
        RunGit(folder, null, cancellation, null, args);

    private static string? FindExecutableOnPath(string name)
    {
        foreach (string entry in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
        {
            string directory = entry.Trim().Trim('"');
            if (!Path.IsPathFullyQualified(directory)) continue;
            string executable = Path.Combine(directory, name);
            if (File.Exists(executable)) return executable;
        }
        return null;
    }

    private static string? FindGitExecutable()
    {
        if (FindExecutableOnPath("git.exe") is { } fromPath) return fromPath;
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string desktopInstall = Path.Combine(localAppData, "GitHubDesktop");
        if (Directory.Exists(desktopInstall))
        {
            var versions = Directory.EnumerateDirectories(desktopInstall, "app-*",
                    new EnumerationOptions { IgnoreInaccessible = true })
                .Select(folder => (Folder: folder, Version: Version.TryParse(Path.GetFileName(folder).AsSpan(4),
                    out var version) ? version : null))
                .Where(app => app.Version is not null)
                .OrderByDescending(app => app.Version);
            foreach (var app in versions)
            {
                string executable = Path.Combine(app.Folder, "resources", "app", "git", "cmd", "git.exe");
                if (File.Exists(executable)) return executable;
            }
        }

        string[] destinations =
        [
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Path.Combine(localAppData, "Programs"),
        ];
        foreach (string directory in destinations)
        {
            if (!Path.IsPathFullyQualified(directory)) continue;
            string executable = Path.Combine(directory, "Git", "cmd", "git.exe");
            if (File.Exists(executable)) return executable;
        }
        return null;
    }

    private static async Task<Response> SetUpGit()
    {
        bool installed = FindGitExecutable() is not null;
        if (!installed)
        {
            string alias = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Microsoft", "WindowsApps", "winget.exe");
            string? installer = FindExecutableOnPath("winget.exe") ?? (File.Exists(alias) ? alias : null);
            if (installer is null)
                return new Response(Error: "找不到 WinGet。请安装 Windows 的「应用安装程序」，或从 git-scm.com 安装 Git for Windows 后重试。");

            var info = new ProcessStartInfo(installer)
            {
                WorkingDirectory = AppContext.BaseDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
            };
            string[] arguments = ["install", "--id", "Git.Git", "--exact", "--source", "winget",
                "--silent", "--disable-interactivity", "--no-upgrade"];
            foreach (string argument in arguments) info.ArgumentList.Add(argument);
            using var process = new Process { StartInfo = info };
            try { process.Start(); }
            catch (Win32Exception error)
            {
                return new Response(Error: "无法启动 WinGet：" + error.Message);
            }
            await process.WaitForExitAsync();
            if (FindGitExecutable() is null)
            {
                return new Response(Error: process.ExitCode == 0
                    ? "WinGet 已完成，但思刻还找不到 Git。请重新打开思刻，再试一次。"
                    : $"Git 安装未完成（WinGet 错误 0x{process.ExitCode:X8}）。请检查网络和系统安装提示后重试。");
            }
        }

        string version = (await RunGit(AppContext.BaseDirectory, CancellationToken.None, "--version")).Trim();
        return new Response(SyncMessage: installed
            ? $"已连接本机 Git（{version}）。"
            : $"Git 已安装并可使用（{version}）。");
    }

    private static async Task<string> RunGit(string folder, string? input, CancellationToken cancellation,
        Func<string, bool>? reportProgress, string[] args)
    {
        const string gitMissing = "找不到 Git。请安装 Git for Windows 或 GitHub Desktop，然后重试。";
        cancellation.ThrowIfCancellationRequested();
        string executable = FindGitExecutable() ?? throw new NoteGitException(gitMissing);
        var info = new ProcessStartInfo(executable)
        {
            WorkingDirectory = folder,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardInputEncoding = GitEncoding,
            StandardOutputEncoding = GitEncoding,
            StandardErrorEncoding = GitEncoding,
        };
        info.Environment["GIT_TERMINAL_PROMPT"] = "0";
        if (reportProgress is not null) info.Environment["LC_ALL"] = "C";
        info.ArgumentList.Add("--literal-pathspecs");
        foreach (string arg in args) info.ArgumentList.Add(arg);

        using var process = new Process { StartInfo = info };
        try { process.Start(); }
        catch (Win32Exception error)
        {
            throw new NoteGitException(error.NativeErrorCode == 2 ? gitMissing : error.Message);
        }
        var output = process.StandardOutput.ReadToEndAsync(cancellation);
        var errors = reportProgress is null
            ? process.StandardError.ReadToEndAsync(cancellation)
            : ReadGitErrors(process.StandardError, reportProgress, cancellation);
        try
        {
            try
            {
                if (input is not null) await process.StandardInput.WriteAsync(input.AsMemory(), cancellation);
                process.StandardInput.Close();
            }
            catch (IOException) { /* Git may exit before reading input when it rejects a command. */ }
            await process.WaitForExitAsync(cancellation);
            await Task.WhenAll(output, errors).WaitAsync(cancellation);
        }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            try { process.Kill(entireProcessTree: true); }
            catch (InvalidOperationException) when (process.HasExited) { }
            catch (Win32Exception) when (process.HasExited) { }
            await process.WaitForExitAsync();
            throw;
        }
        string stdout = await output;
        string stderr = await errors;
        if (process.ExitCode != 0)
        {
            string detail = string.IsNullOrWhiteSpace(stderr) ? stdout.Trim() : stderr.Trim();
            throw new NoteGitException(detail.Length > 0 ? detail : $"Git {args[0]} 失败（退出码 {process.ExitCode}）。");
        }
        return stdout;
    }

    private static async Task<string> ReadGitErrors(StreamReader reader, Func<string, bool> reportProgress,
        CancellationToken cancellation)
    {
        var errors = new StringBuilder();
        var line = new StringBuilder();
        var buffer = new char[4096];

        void ProcessLine()
        {
            if (line.Length > 0 && !reportProgress(line.ToString()))
                errors.AppendLine(line.ToString());
            line.Clear();
        }

        // Git rewrites the current progress line with carriage returns.
        int count;
        while ((count = await reader.ReadAsync(buffer.AsMemory(), cancellation)) > 0)
        {
            for (int i = 0; i < count; i++)
            {
                if (buffer[i] is '\r' or '\n') ProcessLine();
                else line.Append(buffer[i]);
            }
        }
        ProcessLine();
        return errors.ToString();
    }
}
