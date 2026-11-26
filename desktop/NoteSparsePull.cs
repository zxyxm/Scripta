using System.Text.Json;

namespace Moye;

internal sealed partial class EditorWindow
{
    private sealed record SparseSelection(string Url, string Path);
    private string? partialPullFolder;

    private async Task<Response> ChoosePartialFolder()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "选择空文件夹，或上次部分拉取使用的文件夹",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
            InitialDirectory = partialPullFolder ?? "",
        };
        if (dialog.ShowDialog(this) == DialogResult.OK)
            partialPullFolder = Path.TrimEndingDirectorySeparator(dialog.SelectedPath);
        return new Response(PartialFolder: partialPullFolder,
            PartialSelection: partialPullFolder is { } folder ? await ReadSparseSelection(folder, default) : null);
    }

    private async Task<Response> PullPartialRepository(string address, string path, Action<PullProgress> report,
        CancellationToken cancellation)
    {
        if (partialPullFolder is not { } folder || !Directory.Exists(folder))
            return new Response(Error: "请选择部分拉取的本地文件夹。");
        if (IsScriptaSourceFolder(folder))
            return new Response(Error: "请选择软件源码目录以外的保存位置。");
        if (notesRoot is not null && (SamePath(notesRoot, folder) || IsInsideFolder(notesRoot, folder)))
            return new Response(Error: "请选择笔记仓库之外的文件夹。若当前笔记仓库已经是部分拉取的目录，请用上方的「拉取」同步。");
        if (GitHubUrl(address) is not { } url || SparsePath(path) is not { } relativePath)
            return new Response(Error: "请输入 GitHub 仓库地址和仓库内的相对路径。");

        string message = await PrepareSparseRepository(folder, new SparseSelection(url, relativePath), report, cancellation);
        return new Response(SyncMessage: message);
    }

    private static string? SparsePath(string value)
    {
        string path = value.Trim().Replace('\\', '/').TrimEnd('/');
        return path.Split('/').Any(part => part.Length == 0 || part.EndsWith('.') || part.EndsWith(' ') ||
            part.Equals(".git", StringComparison.OrdinalIgnoreCase) || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            ? null : path;
    }

    private static string SparseSelectionFile(string folder) => Path.Combine(folder, ".git", "scripta-partial.json");

    private static async Task<SparseSelection?> ReadSparseSelection(string folder, CancellationToken cancellation)
    {
        var file = SparseSelectionFile(folder);
        if (!File.Exists(file)) return null;
        try
        {
            var selection = JsonSerializer.Deserialize<SparseSelection>(await File.ReadAllTextAsync(file, cancellation), Json);
            if (selection is not { Url.Length: > 0, Path.Length: > 0 } || SparsePath(selection.Path) != selection.Path)
                throw new NoteGitException("无法读取这个文件夹的部分拉取记录。");
            return selection;
        }
        catch (JsonException) { throw new NoteGitException("无法读取这个文件夹的部分拉取记录。"); }
    }

    private static async Task<string?> ReadSparsePath(string folder, CancellationToken cancellation) =>
        (await ReadSparseSelection(folder, cancellation))?.Path;

    private static async Task<string> PrepareSparseRepository(string folder, SparseSelection selection,
        Action<PullProgress> report, CancellationToken cancellation)
    {
        report(new PullProgress("正在检查部分拉取的目标文件夹…"));
        var previous = await ReadSparseSelection(folder, cancellation);
        if (Directory.EnumerateFileSystemEntries(folder).Any())
        {
            if (previous is null || !previous.Url.Equals(selection.Url, StringComparison.OrdinalIgnoreCase))
                throw new NoteGitException("请选择空文件夹，或使用这个文件夹原来的 GitHub 仓库地址。");
        }
        else
        {
            cancellation.ThrowIfCancellationRequested();
            // Make initialization durable before starting any cancellable network operation.
            await RunGit(folder, null, "init", "--initial-branch=scripta-initial");
            await RunGit(folder, null, "remote", "add", "origin", selection.Url);
            await RunGit(folder, null, "config", "--local", "remote.origin.promisor", "true");
            await RunGit(folder, null, "config", "--local", "remote.origin.partialclonefilter", "blob:none");
            await SaveSparseSelection(folder, selection);
        }

        var origin = await ReadOriginUrls(folder, cancellation: cancellation);
        if (origin.Length != 1 || !(origin[0].Equals(selection.Url, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(GitHubUrl(origin[0]), selection.Url, StringComparison.OrdinalIgnoreCase)))
            throw new NoteGitException("本地 origin 与部分拉取的仓库地址不一致。");

        string head = (await RunGit(folder, cancellation, "for-each-ref", "--format=%(refname)", "refs/heads")).Trim();
        if (head.Length > 0)
        {
            if (previous?.Path != selection.Path)
                throw new NoteGitException("这个文件夹已拉取其他路径。请改用原路径或选择另一个空文件夹。");
            var (local, remote, upstream) = await ReadSyncBranch(folder, cancellation);
            return await TransferGitBranch(folder, false, local, remote, upstream, report, cancellation);
        }
        if (Directory.EnumerateFileSystemEntries(folder).Any(entry => !SamePath(entry, Path.Combine(folder, ".git"))))
            throw new NoteGitException("目标文件夹已包含其他文件，请选择一个空文件夹。");
        if (previous is not null && previous.Path != selection.Path)
            await SaveSparseSelection(folder, selection);

        var remoteRef = (await RunGit(folder, cancellation,
            "for-each-ref", "--format=%(refname)", "refs/remotes/origin/")).Trim();
        if (remoteRef.Length == 0)
        {
            report(new PullProgress("正在查询远程仓库的默认分支…"));
            string refs = await RunGit(folder, cancellation, "ls-remote", "--symref", "origin", "HEAD");
            string? branch = refs.Split('\n').FirstOrDefault(line =>
                line.StartsWith("ref: refs/heads/", StringComparison.Ordinal) && line.TrimEnd('\r').EndsWith("\tHEAD", StringComparison.Ordinal));
            if (branch is null) throw new NoteGitException("无法读取远程仓库的默认分支。");
            string source = branch[5..branch.IndexOf('\t')];
            remoteRef = "refs/remotes/origin/" + source["refs/heads/".Length..];
            report(new PullProgress("正在下载目录索引…"));
            await RunSparseFetch(folder, null, report, cancellation,
                ["--depth=1", "origin", source + ":" + remoteRef]);
        }

        string commit = (await RunGit(folder, cancellation, "rev-parse", "--verify", remoteRef)).Trim();
        await DownloadSparseFiles(folder, selection.Path, commit, report, cancellation, requirePath: true);
        cancellation.ThrowIfCancellationRequested();
        report(new PullProgress("正在将选定文件写入本地文件夹…", CanCancel: false));
        var pattern = "/" + selection.Path.Replace("[", "\\[").Replace("]", "\\]") + "\n";
        await RunGit(folder, pattern, "--no-lazy-fetch", "sparse-checkout", "set", "--no-cone", "--stdin");
        await RunGit(folder, null, "--no-lazy-fetch", "switch", "--track", "-c", remoteRef["refs/remotes/origin/".Length..], remoteRef);
        return $"已拉取 {selection.Path} 到 {folder}。";
    }

    private static async Task SaveSparseSelection(string folder, SparseSelection selection)
    {
        string file = SparseSelectionFile(folder);
        string temporary = file + ".tmp";
        await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(selection, Json));
        File.Move(temporary, file, overwrite: true);
    }

    private static async Task DownloadSparseFiles(string folder, string path, string commit, Action<PullProgress> report,
        CancellationToken cancellation, bool requirePath)
    {
        string[] objects = await ReadSparseObjects(folder, commit, [path], cancellation);
        if (requirePath && objects.Length == 0)
            throw new NoteGitException("默认分支中没有找到这个路径下的文件，请检查路径和大小写。");

        // Checkout may need .gitattributes from parent directories to apply file filters.
        var attributes = new List<string> { ".gitattributes" };
        for (int slash = path.IndexOf('/'); slash >= 0; slash = path.IndexOf('/', slash + 1))
            attributes.Add(path[..slash] + "/.gitattributes");
        objects = objects.Concat(await ReadSparseObjects(folder, commit, attributes, cancellation)).Distinct().ToArray();
        if (objects.Length == 0) return;

        report(new PullProgress("正在检查已下载的文件对象…"));
        string list = string.Join('\n', objects) + '\n';
        string checkedObjects = await RunGit(folder, list, cancellation, null,
            ["--no-lazy-fetch", "cat-file", "--batch-check=%(objectname)"]);
        string[] missing = checkedObjects.Split('\n', StringSplitOptions.TrimEntries)
            .Where(line => line.EndsWith(" missing", StringComparison.Ordinal))
            .Select(line => line[..^" missing".Length]).ToArray();
        int completed = objects.Length - missing.Length;
        foreach (string[] batch in missing.Chunk(64))
        {
            string stage = $"正在下载选定内容（已完成 {completed}/{objects.Length} 个对象）";
            report(new PullProgress(stage));
            await RunSparseFetch(folder, string.Join('\n', batch) + '\n',
                progress => report(progress with { Stage = stage + " · " + progress.Stage }), cancellation,
                ["--no-write-fetch-head", "--stdin", "origin"]);
            completed += batch.Length;
        }
    }

    private static async Task<string[]> ReadSparseObjects(string folder, string commit, IEnumerable<string> paths,
        CancellationToken cancellation)
    {
        string tree = await RunGit(folder, cancellation,
            ["ls-tree", "-rz", "--format=%(objecttype) %(objectname)", commit, "--", .. paths]);
        return tree.Split('\0').Where(entry => entry.StartsWith("blob ", StringComparison.Ordinal))
            .Select(entry => entry[5..]).ToArray();
    }

    private static Task<string> RunSparseFetch(string folder, string? input, Action<PullProgress> report,
        CancellationToken cancellation, string[] arguments) =>
        RunGit(folder, input, cancellation, line =>
        {
            if (ReadPullProgress(line) is not { } progress) return false;
            report(progress);
            return true;
        }, [.. input is null ? Array.Empty<string>() : new[] { "-c", "fetch.negotiationAlgorithm=noop" },
            "fetch", "--filter=blob:none", "--progress", "--no-recurse-submodules", "--no-tags", .. arguments]);
}
