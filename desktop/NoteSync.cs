using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Moye;

internal sealed partial class EditorWindow
{
    private sealed record RepositorySync(string? Folder, bool IsGit = false, string? GitHub = null);

    private sealed record PullProgress(string Stage, int? Percent = null, bool CanCancel = true);
    private CancellationTokenSource? pullCancellation;
    private bool pullCanCancel;
    private bool closeAfterPull;

    private static readonly Regex GitProgress = new(
        @"^\s*(?:remote: )?(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Unpacking objects|Updating files):\s*(?:(\d{1,3})%)?",
        RegexOptions.CultureInvariant);

    private static PullProgress? ReadPullProgress(string line)
    {
        var match = GitProgress.Match(line);
        if (!match.Success) return null;

        string stage = match.Groups[1].Value switch
        {
            "Enumerating objects" => "远程仓库正在扫描对象…",
            "Counting objects" => "远程仓库正在统计对象",
            "Compressing objects" => "远程仓库正在压缩对象",
            "Receiving objects" => "正在下载对象",
            "Resolving deltas" => "正在解析对象差异",
            "Unpacking objects" => "正在解包对象",
            _ => "正在更新本地文件",
        };
        int? percent = int.TryParse(match.Groups[2].Value, out int value) && value <= 100 ? value : null;
        return new PullProgress(stage, percent);
    }

    private static readonly Regex GitHubRepository = new(
        @"\A(?:(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/))?([a-z0-9][a-z0-9-]*)/([a-z0-9._-]+?)(?:\.git)?/?\z",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static string? GitHubUrl(string? value)
    {
        var match = GitHubRepository.Match(value?.Trim() ?? "");
        if (!match.Success || match.Groups[2].Value is "." or "..") return null;
        return $"https://github.com/{match.Groups[1].Value}/{match.Groups[2].Value}";
    }

    private RepositorySync ReadLocalRepository()
    {
        if (notesRoot is not { } folder || !Directory.Exists(folder))
            return new RepositorySync(null);
        return new RepositorySync(folder, IsGit: Path.Exists(Path.Combine(folder, ".git")));
    }

    private async Task<Response> ReadRepositorySync(CancellationToken cancellation = default)
    {
        var local = ReadLocalRepository();
        return new Response(Sync: local is { Folder: { } folder, IsGit: true }
            ? await ReadGitRepository(folder, cancellation) : local);
    }

    private static async Task<RepositorySync> ReadGitRepository(string folder, CancellationToken cancellation = default)
    {
        var remotes = (await RunGit(folder, cancellation, "remote")).Split('\n', StringSplitOptions.TrimEntries);
        if (!remotes.Contains("origin", StringComparer.Ordinal))
            return new RepositorySync(folder, IsGit: true);

        var fetch = await ReadOriginUrls(folder, cancellation: cancellation);
        var push = await ReadOriginUrls(folder, push: true, cancellation: cancellation);
        string? url = fetch.Length == 1 ? GitHubUrl(fetch[0]) : null;
        bool sameTarget = url is not null && push.Length == 1 &&
            url.Equals(GitHubUrl(push[0]), StringComparison.OrdinalIgnoreCase);
        return new RepositorySync(folder, IsGit: true, GitHub: sameTarget ? url : null);
    }

    private static async Task<string[]> ReadOriginUrls(string folder, bool push = false, CancellationToken cancellation = default) =>
        (await RunGit(folder, cancellation, push ? ["remote", "get-url", "--push", "--all", "origin"] :
            ["remote", "get-url", "--all", "origin"])).Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);

    private async Task<Response> RunRepositoryPull(Func<Action<PullProgress>, CancellationToken, Task<Response>> pull)
    {
        using var cancellation = new CancellationTokenSource();
        pullCancellation = cancellation;
        pullCanCancel = true;
        PullProgress? lastProgress = null;
        void Report(PullProgress progress)
        {
            if (IsDisposed || cancellation.IsCancellationRequested || progress == lastProgress) return;
            pullCanCancel = progress.CanCancel;
            lastProgress = progress;
            view.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(new { PullProgress = progress }, Json));
        }
        try { return await pull(Report, cancellation.Token); }
        catch (OperationCanceledException) when (cancellation.IsCancellationRequested)
        {
            return new Response(PullInterrupted: true, SyncMessage: "拉取已中断，可以继续。");
        }
        finally
        {
            pullCancellation = null;
            pullCanCancel = false;
        }
    }

    private void CancelPull()
    {
        if (pullCanCancel) pullCancellation?.Cancel();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        base.OnFormClosing(e);
        if (e.Cancel || e.CloseReason != CloseReason.UserClosing || pullCancellation is null) return;
        e.Cancel = true;
        closeAfterPull = true;
        CancelPull();
    }

    private async Task<Response> SyncGitHubRepository(bool push, Action<PullProgress>? report = null,
        CancellationToken cancellation = default)
    {
        var state = (await ReadRepositorySync(cancellation)).Sync!;
        if (state is not { Folder: { } folder, GitHub: { } target })
            return new Response(Error: "请先绑定 GitHub 仓库。");
        var (localBranch, remoteBranch, hasUpstream) = await ReadSyncBranch(folder, cancellation);
        if (push && !ConfirmAction("推送到 GitHub",
            $"将本地分支 {localBranch["refs/heads/".Length..]} 的提交推送到\n{target}\n远程分支：{remoteBranch["refs/heads/".Length..]}？",
            "推送"))
            return new Response();

        var latest = (await ReadRepositorySync(cancellation)).Sync!;
        if (latest.GitHub != target || await ReadSyncBranch(folder, cancellation) != (localBranch, remoteBranch, hasUpstream))
            return new Response(Error: "同步目标或当前分支已更改，请重新操作。");
        return new Response(SyncMessage: await TransferGitBranch(folder, push, localBranch, remoteBranch, hasUpstream, report, cancellation));
    }

    private static async Task<(string Local, string Remote, bool HasUpstream)> ReadSyncBranch(string folder, CancellationToken cancellation)
    {
        string local;
        try { local = (await RunGit(folder, cancellation, "symbolic-ref", "--quiet", "HEAD")).TrimEnd('\r', '\n'); }
        catch (NoteGitException) { throw new NoteGitException("请切换到一个本地分支再同步。"); }
        if (!local.StartsWith("refs/heads/", StringComparison.Ordinal))
            throw new NoteGitException("请切换到一个本地分支再同步。");

        string[] tracking = (await RunGit(folder, cancellation, "for-each-ref",
            "--format=%(upstream:remotename)%00%(upstream:remoteref)", "--", local)).TrimEnd('\r', '\n').Split('\0');
        if (tracking.Length != 2)
            throw new NoteGitException("当前分支还没有提交。请先提交本地笔记；如果远程仓库已有内容，可选择新的父文件夹后使用「首次下载并绑定」。");
        if (tracking is ["", ""]) return (local, local, false);
        if (tracking[0] != "origin" || !tracking[1].StartsWith("refs/heads/", StringComparison.Ordinal))
            throw new NoteGitException("当前分支跟踪的是其他远程目标，请在 GitHub Desktop 中同步。");
        return (local, tracking[1], true);
    }

    private static async Task<string> TransferGitBranch(string folder, bool push, string localBranch, string remoteBranch,
        bool hasUpstream, Action<PullProgress>? report, CancellationToken cancellation)
    {
        if (push)
        {
            var arguments = new List<string>
            {
                "-c", "push.followTags=false", "-c", "remote.origin.mirror=false",
                "push", "--porcelain", "--recurse-submodules=no",
            };
            if (!hasUpstream) arguments.Add("--set-upstream");
            arguments.AddRange(["origin", localBranch + ":" + remoteBranch]);
            string result = await RunGit(folder, null, arguments.ToArray());
            return result.Split('\n').Any(line => line.StartsWith("=\t", StringComparison.Ordinal))
                ? "远程分支已包含当前提交。" : "已推送当前分支的提交。";
        }

        async Task CheckWorktree()
        {
            string changes = await RunGit(folder, cancellation, "status", "--porcelain=v1", "--untracked-files=no");
            if (changes.Length != 0)
                throw new NoteGitException("当前仓库有已跟踪的文件尚未提交，请先提交再拉取。");
        }

        report!(new PullProgress("正在检查本地未提交的更改…"));
        await CheckWorktree();
        string before = await RunGit(folder, cancellation, "rev-parse", "HEAD");
        var sparsePath = await ReadSparsePath(folder, cancellation);
        report(new PullProgress("正在连接远程仓库，等待 Git 返回更新…"));
        if (sparsePath is not null)
            await RunSparseFetch(folder, null, report, cancellation, ["origin", remoteBranch]);
        else
        {
            await RunGit(folder, null, cancellation, line =>
            {
                if (ReadPullProgress(line) is not { } progress) return false;
                report(progress);
                return true;
            }, ["fetch", "--progress", "--no-recurse-submodules", "origin", remoteBranch]);
        }
        report(new PullProgress("下载完成，正在核对本地分支…"));
        string fetched = (await RunGit(folder, cancellation, "rev-parse", "--verify", "FETCH_HEAD")).Trim();
        if (sparsePath is not null)
            await DownloadSparseFiles(folder, sparsePath, fetched, report, cancellation, requirePath: false);
        await CheckWorktree();
        if (await ReadSyncBranch(folder, cancellation) != (localBranch, remoteBranch, hasUpstream) ||
            await RunGit(folder, cancellation, "rev-parse", "HEAD") != before)
            throw new NoteGitException("下载期间本地分支已更改，请重新拉取。");
        cancellation.ThrowIfCancellationRequested();
        // The fast-forward writes the index and working tree, so let it finish once started.
        report(new PullProgress("正在应用更新到本地文件，完成后会刷新笔记。", CanCancel: false));
        string[] merge = sparsePath is null
            ? ["merge", "--ff-only", "--no-autostash", fetched]
            : ["--no-lazy-fetch", "merge", "--ff-only", "--no-autostash", "--no-stat", fetched];
        await RunGit(folder, null, merge);
        string after = await RunGit(folder, null, "rev-parse", "HEAD");
        return before == after ? "当前分支已是最新。" : "已拉取远程更新。";
    }

    private async Task<Response> BindOrCloneGitHubRepository(string address, bool clone)
    {
        if (GitHubUrl(address) is not { } target)
            return new Response(Error: "请输入 GitHub 仓库地址，例如 https://github.com/用户名/仓库名，或 owner/repo。");

        var local = ReadLocalRepository();
        string parent;
        if (local.Folder is { } selected)
        {
            parent = selected;
            if (local.IsGit)
            {
                var current = await ReadGitRepository(parent);
                if (string.Equals(current.GitHub, target, StringComparison.OrdinalIgnoreCase))
                    return new Response(Sync: current, SyncMessage: "当前文件夹已绑定到这个 GitHub 仓库。");
            }
        }
        else
        {
            if (!clone) return new Response(Error: "请先选择存放仓库的本地文件夹。");
            using var dialog = new FolderBrowserDialog
            {
                Description = "选择父文件夹，思刻将在其中新建与仓库同名的子文件夹",
                UseDescriptionForTitle = true,
                ShowNewFolderButton = true,
            };
            if (dialog.ShowDialog(this) != DialogResult.OK) return new Response();
            parent = dialog.SelectedPath;
        }

        if (IsScriptaSourceFolder(parent))
            return new Response(Error: "请选择软件源码目录以外的保存位置。");
        string destination = GitHubChildFolder(parent, target);
        if (Path.Exists(destination))
        {
            if (Directory.Exists(destination) &&
                (File.GetAttributes(destination) & FileAttributes.ReparsePoint) == 0 &&
                Path.Exists(Path.Combine(destination, ".git")))
            {
                var existing = await ReadGitRepository(destination);
                if (string.Equals(existing.GitHub, target, StringComparison.OrdinalIgnoreCase))
                    return UseGitHubFolder(existing, "已绑定同名本地仓库。");
            }
            return new Response(Error: $"同名位置已被占用：{destination}。请选择其他父文件夹。");
        }

        if (!clone)
        {
            if (!ConfirmAction("绑定 GitHub 仓库", $"将在以下子文件夹初始化 Git 并绑定到远程仓库：\n{destination}\n\n{target}", "绑定"))
                return new Response();

            return await CreateGitHubChild(destination, async staging =>
            {
                await RunGit(parent, null, "init", "--initial-branch=main", "--", staging);
                await RunGit(staging, null, "remote", "add", "origin", target + ".git");
            }, "已新建并绑定同名子文件夹。");
        }

        return await RunRepositoryPull((report, cancellation) => CreateGitHubChild(destination, async staging =>
        {
            report(new PullProgress("正在连接 GitHub，首次下载仓库…"));
            await RunGit(parent, null, cancellation, line =>
            {
                if (ReadPullProgress(line) is not { } progress) return false;
                report(progress);
                return true;
            }, ["clone", "--progress", "--origin", "origin", "--", target + ".git", staging]);
            cancellation.ThrowIfCancellationRequested();
            report(new PullProgress("下载完成，正在绑定本地文件夹…", CanCancel: false));
        }, "已下载并绑定同名子文件夹。"));
    }

    private static string GitHubChildFolder(string parent, string target)
    {
        string name = target[(target.LastIndexOf('/') + 1)..];
        if (name.EndsWith('.') || name.Equals(".git", StringComparison.OrdinalIgnoreCase) ||
            Regex.IsMatch(name, @"\A(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|\z)",
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            throw new NoteGitException("这个 GitHub 仓库名不能用于 Windows 子文件夹。");
        return Path.Combine(parent, name);
    }

    private async Task<Response> CreateGitHubChild(string destination, Func<string, Task> create, string message)
    {
        string parent = Path.GetDirectoryName(destination)!;
        string staging = Path.Combine(parent, ".scripta-github-" + Guid.NewGuid().ToString("N"));
        try
        {
            await create(staging);
            Directory.Move(staging, destination);
            return UseGitHubFolder(await ReadGitRepository(destination), message);
        }
        finally
        {
            try { if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
    }

    private Response UseGitHubFolder(RepositorySync repository, string message)
    {
        string folder = repository.Folder!;
        if (!TryWriteProfilePath(NotesRootFile, folder))
            return new Response(Error: $"无法保存绑定。请使用「绑定本地文件夹」选择 {folder}。");
        notesRoot = folder;
        pendingCommit = null;
        return new Response(Sync: repository, SyncMessage: message);
    }

    private async Task<Response> OpenInGitHubDesktop()
    {
        if (notesRoot is not { } folder || !Path.Exists(Path.Combine(folder, ".git")))
            return new Response(Error: "请先选择已有 Git 仓库，或绑定 GitHub 来初始化当前文件夹。");
        string root = (await RunGit(folder, null, "rev-parse", "--show-toplevel")).TrimEnd('\r', '\n');
        if (!SamePath(Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)), Path.TrimEndingDirectorySeparator(folder)))
            return new Response(Error: "请选择 Git 仓库的根目录。");
        if (FindGitHubDesktop() is not { } executable)
            return new Response(Error: "未找到 GitHub Desktop。安装后可在此打开当前笔记仓库。");

        try
        {
            var start = new ProcessStartInfo(executable) { UseShellExecute = false };
            start.ArgumentList.Add("--cli-open=" + folder);
            using var process = Process.Start(start);
            return new Response();
        }
        catch (Win32Exception)
        {
            return new Response(Error: "无法启动 GitHub Desktop，请检查安装。");
        }
    }

    private static string? FindGitHubDesktop()
    {
        using var key = Registry.ClassesRoot.OpenSubKey(@"x-github-client\shell\open\command");
        if (key?.GetValue(null) is string command)
        {
            var match = Regex.Match(command, "^\"([^\"]+)\"");
            if (match.Success && Path.GetFileName(match.Groups[1].Value).Equals("GitHubDesktop.exe", StringComparison.OrdinalIgnoreCase) &&
                File.Exists(match.Groups[1].Value)) return match.Groups[1].Value;
        }
        string fallback = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "GitHubDesktop", "GitHubDesktop.exe");
        return File.Exists(fallback) ? fallback : null;
    }

    private async Task<Response> RefreshSyncedNote(Request request)
    {
        if (request.Token != documentToken || documentPath is not { } path || notesRoot is not { } root ||
            !IsInsideFolder(root, path)) return new Response();
        var contents = await TryReadNoteText(path);
        if (contents is null)
            return new Response(Error: "当前笔记在磁盘上已移走或无法读取，编辑器中的内容仍保留。");
        if (contents == diskContents) return new Response();
        return request.Dirty ? new Response(DiskChanged: true) : BindDocument(path, contents, includeContents: true);
    }
}
