using System.Security.Cryptography;

namespace Moye;

internal sealed partial class EditorWindow
{
    private sealed record MergeInput(string Name, string Contents, string RelativeFolder, bool HasAssets, bool HasReferences);
    private sealed record MergedOriginal(string Path, string Fingerprint);
    private sealed record MergePlan(string Destination, string[] Sources, IReadOnlyList<MergedOriginal> Originals);
    private MergePlan? pendingMerge;

    private async Task<Response> PrepareMarkdownMerge(IReadOnlyList<string>? notePaths)
    {
        pendingMerge = null;
        string[] selected;
        if (notePaths is null)
        {
            using var select = new OpenFileDialog
            {
                Title = "选择要合并的 Markdown 笔记（按文件名排序）",
                Filter = "Markdown 文档 (*.md;*.markdown)|*.md;*.markdown",
                Multiselect = true,
                CheckFileExists = true,
            };
            if (select.ShowDialog(this) != DialogResult.OK) return new Response();
            selected = select.FileNames;
        }
        else
        {
            var repositorySources = new List<string>();
            foreach (string path in notePaths)
            {
                if (ResolveRepositoryEntry(path, isFolder: false) is not { } source)
                    return new Response(Error: "所选笔记已不可用，请刷新笔记列表后重试。");
                repositorySources.Add(source);
            }
            selected = repositorySources.ToArray();
        }
        var sources = selected.Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(Path.GetFileName, StringComparer.CurrentCultureIgnoreCase)
            .ThenBy(path => path, StringComparer.OrdinalIgnoreCase).ToArray();
        if (sources.Length < 2 || sources.Any(path => !IsNoteFile(Path.GetFileName(path))))
            return new Response(Error: "请选择至少两篇 Markdown 笔记。");

        using var save = new SaveFileDialog
        {
            Title = "保存合并后的 Markdown",
            Filter = "Markdown 文档 (*.md)|*.md",
            DefaultExt = "md",
            AddExtension = true,
            OverwritePrompt = false,
            InitialDirectory = Path.GetDirectoryName(sources[0]),
            FileName = "合并笔记.md",
        };
        if (save.ShowDialog(this) != DialogResult.OK) return new Response();
        if (!Path.GetExtension(save.FileName).Equals(".md", StringComparison.OrdinalIgnoreCase) || ImportDestinationExists(save.FileName))
            return new Response(Error: "请选择一个新的 .md 文件名，合并会保留已有笔记和图床。");

        string folder = Path.GetDirectoryName(save.FileName)!;
        var entries = new List<MergeInput>();
        var originals = new List<MergedOriginal>();
        foreach (string file in sources)
        {
            byte[] bytes = await File.ReadAllBytesAsync(file);
            var text = Utf8.GetString(bytes);
            if (GetMergeNotePath(file) is { } path)
                originals.Add(new MergedOriginal(path, Convert.ToHexString(SHA256.HashData(bytes))));
            string relative = Path.GetRelativePath(folder, Path.GetDirectoryName(file)!);
            if (Path.IsPathRooted(relative)) return new Response(Error: "请选择与源笔记在同一磁盘上的合并位置。");
            entries.Add(new MergeInput(Path.GetFileName(file), text, relative,
                Directory.Exists(Path.ChangeExtension(file, ".assets")), Directory.Exists(Path.ChangeExtension(file, ReferenceSuffix))));
        }
        pendingMerge = new MergePlan(save.FileName, sources, originals);
        return new Response(Name: Path.GetFileName(save.FileName), MergeFiles: entries);
    }

    private async Task<Response> WriteMarkdownMerge(string contents)
    {
        if (pendingMerge is not { } plan) return new Response(Error: "请先选择要合并的笔记。");
        pendingMerge = null;
        if (ImportDestinationExists(plan.Destination)) return new Response(Error: "目标笔记或同名图床已存在。");
        await Task.Run(() => PublishMerge(plan, contents));
        var opened = await ReadDocument(plan.Destination);
        return GetMergeNotePath(plan.Destination) is { } destination && plan.Originals.Count > 0
            ? opened with { Repository = notesRoot, NotePath = destination, MergeOriginals = plan.Originals }
            : opened;
    }

    private string? GetMergeNotePath(string absolute)
    {
        if (notesRoot is not { } root || !IsInsideFolder(root, absolute)) return null;
        string relative = Path.GetRelativePath(root, absolute);
        return ResolveRepositoryEntry(relative, isFolder: false) is not null ? relative : null;
    }

    private Response RecycleMergedOriginals(string destination, IReadOnlyList<MergedOriginal> originals)
    {
        if (ResolveRepositoryEntry(destination, isFolder: false) is not { } merged)
            return new Response(Error: "合并稿已不可用，请刷新笔记列表。");
        var fingerprints = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var original in originals)
        {
            if (!Path.IsPathRooted(original.Path) &&
                !SamePath(Path.GetFullPath(original.Path, notesRoot!), merged))
                fingerprints.TryAdd(original.Path, original.Fingerprint);
        }
        return fingerprints.Count == 0 ? new Response() : RecycleRepositoryNotes(fingerprints.Keys.ToArray(), fingerprints);
    }

    private bool MatchesMergedOriginal(string relativePath, string fingerprint)
    {
        if (ResolveRepositoryEntry(relativePath, isFolder: false) is not { } path) return false;
        using var source = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(source)) == fingerprint;
    }

    private static void PublishMerge(MergePlan plan, string contents)
    {
        string staging = Path.Combine(Path.GetDirectoryName(plan.Destination)!, ".scripta-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            string stagedNote = Path.Combine(staging, Path.GetFileName(plan.Destination));
            File.WriteAllText(stagedNote, contents, Utf8);
            for (int index = 0; index < plan.Sources.Length; index++)
            {
                foreach (var (source, target) in NoteAttachmentPaths(plan.Sources[index], stagedNote))
                {
                    if (!Directory.Exists(source)) continue;
                    if (File.GetAttributes(source).HasFlag(FileAttributes.ReparsePoint))
                        throw new IOException("无法合并链接形式的图床或资料文件夹。");
                    CopyDirectory(source, Path.Combine(target, (index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture)));
                }
            }
            var attachments = NoteAttachmentPaths(stagedNote, plan.Destination).Where(item => Directory.Exists(item.Source)).ToArray();
            MoveNoteWithAttachments(stagedNote, plan.Destination, attachments);
        }
        finally
        {
            try { Directory.Delete(staging, recursive: true); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
    }
}
