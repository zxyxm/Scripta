using Microsoft.Web.WebView2.Core;

namespace Moye;

internal sealed partial class EditorWindow
{
    private async Task<Response> ImportResourceFiles(string destinationPath, IReadOnlyList<object> files)
    {
        var parts = destinationPath.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var destination = parts.Any(IsReferenceFolder)
            ? ResolveRepositoryEntry(destinationPath, isFolder: true)
            : null;
        if (destination is null) return new Response(Error: "请将文件拖到仓库的资料文件夹。");
        if (files.Count == 0) return new Response(Error: "请选择要添加的文件。");

        // Resolve the WebView2 objects before copying on the background thread.
        var paths = files.Select(file => file switch
        {
            CoreWebView2File webFile => webFile.Path,
            FileInfo fileInfo => fileInfo.FullName,
            _ => null,
        }).ToArray();
        int imported = await Task.Run(() =>
        {
            int copied = 0;
            foreach (string? path in paths)
                if (TryCopyResource(path, destination)) copied++;
            return copied;
        });
        return new Response(ImportedCount: imported, SkippedCount: paths.Length - imported);
    }

    private static bool TryCopyResource(string? source, string destination)
    {
        if (string.IsNullOrEmpty(source) || !Path.IsPathFullyQualified(source) || !File.Exists(source)) return false;
        var name = Path.GetFileName(source);
        if (name.StartsWith('.') || name.EndsWith('.') || name.EndsWith(' ') ||
            name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || IsDeviceName(name)) return false;

        string target = Path.Combine(destination, name);
        if (Path.Exists(target)) return false;
        string temporary = Path.Combine(destination, ".scripta-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            File.Copy(source, temporary);
            File.Move(temporary, target);
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return false;
        }
        finally
        {
            DeleteTemporaryFile(temporary);
        }
    }

    private async Task<Response> ChooseMoveDestination(string relativePath, bool isFolder)
    {
        if (ResolveRepositoryEntry(relativePath, isFolder) is null)
            return new Response(Error: "此项目已不可用，请刷新笔记列表。");

        var choice = ChooseRepositoryDestination(isFolder);
        return choice.NotePath is { } target
            ? await TransferRepositoryEntry(relativePath, target, isFolder, copy: false)
            : choice;
    }

    private Response ChooseRepositoryDestination(bool allowRoot = false)
    {
        if (notesRoot is not { } root) return new Response(Error: "请先绑定笔记仓库。");
        using var dialog = new FolderBrowserDialog
        {
            Description = "选择要移动到的仓库文件夹",
            UseDescriptionForTitle = true,
            InitialDirectory = root,
            ShowNewFolderButton = false,
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return new Response();

        string target = Path.TrimEndingDirectorySeparator(Path.GetFullPath(dialog.SelectedPath));
        if (SamePath(Path.TrimEndingDirectorySeparator(root), target))
        {
            return allowRoot ? new Response(NotePath: "") :
                new Response(Error: "请选择仓库根目录下的主题文件夹。");
        }
        if (!IsInsideFolder(root, target))
            return new Response(Error: "请选择当前笔记仓库内的目标文件夹。");

        return new Response(NotePath: Path.GetRelativePath(root, target));
    }

    private async Task<Response> TransferRepositoryEntry(string relativePath, string destinationPath, bool isFolder, bool copy)
    {
        var source = ResolveRepositoryEntry(relativePath, isFolder);
        var targetFolder = destinationPath.Length == 0
            ? notesRoot
            : ResolveRepositoryEntry(destinationPath, isFolder: true);
        if (source is null || targetFolder is null)
            return new Response(Error: "请选择笔记仓库中的目标文件夹。");
        if (destinationPath.Length == 0 &&
            (isFolder ? SkipNoteFolder(Path.GetFileName(source), rootLevel: true) : !IsRootNote(Path.GetFileName(source))))
            return new Response(Error: "该名称不适合作为仓库根目录的项目。");

        if (isFolder && (SamePath(source, targetFolder) || IsInsideFolder(source, targetFolder)))
            return new Response(Error: "不能将文件夹放入自身或其子文件夹。");

        string destination = Path.Combine(targetFolder, Path.GetFileName(source));
        if (SamePath(source, destination)) return new Response();
        if (Path.Exists(destination))
            return new Response(Error: "目标文件夹中已有同名项目。");

        var attachments = isFolder ? [] : NoteAttachmentPaths(source, destination);
        foreach (var (from, to) in attachments)
        {
            if (Path.Exists(to)) return new Response(Error: "目标文件夹中已有同名图床或资料文件夹。");
            if (Directory.Exists(from) && File.GetAttributes(from).HasFlag(FileAttributes.ReparsePoint))
                return new Response(Error: "此笔记的图床或资料文件夹是链接，无法随笔记转移。");
        }
        attachments = attachments.Where(item => Directory.Exists(item.Source)).ToArray();

        string siblingExtension = Path.GetExtension(source).Equals(".md", StringComparison.OrdinalIgnoreCase) ? ".markdown" : ".md";
        bool sharedAttachments = attachments.Length > 0 && File.Exists(Path.ChangeExtension(source, siblingExtension));
        if (copy || sharedAttachments)
        {
            await Task.Run(() => TransferWithCopies(source, destination, isFolder, copy, attachments));
        }
        else
        {
            if (isFolder) Directory.Move(source, destination);
            else MoveNoteWithAttachments(source, destination, attachments);
        }
        if (!copy) UpdateMovedDocument(source, destination, isFolder);
        return new Response(NotePath: Path.GetRelativePath(notesRoot!, destination));
    }

    private static bool SamePath(string left, string right) =>
        left.Equals(right, StringComparison.OrdinalIgnoreCase);

    private static bool IsInsideFolder(string folder, string path) =>
        path.StartsWith(Path.TrimEndingDirectorySeparator(folder) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private void UpdateMovedDocument(string source, string destination, bool isFolder)
    {
        if (documentPath is not { } current) return;
        string? moved = isFolder
            ? (IsInsideFolder(source, current) ? Path.Combine(destination, Path.GetRelativePath(source, current)) : null)
            : (SamePath(source, current) ? destination : null);
        if (moved is null) return;
        documentPath = moved;
        RememberNotePath(moved);
    }

    private static (string Source, string Target)[] NoteAttachmentPaths(string source, string destination) =>
        new[] { ".assets", ReferenceSuffix }.Select(suffix =>
            (Path.ChangeExtension(source, suffix), Path.ChangeExtension(destination, suffix))).ToArray();

    private static void MoveNoteWithAttachments(string source, string destination, (string Source, string Target)[] attachments)
    {
        var moved = new List<(string Source, string Target)>();
        try
        {
            foreach (var (from, to) in attachments)
            {
                Directory.Move(from, to);
                moved.Add((from, to));
            }
            File.Move(source, destination);
        }
        catch
        {
            foreach (var (from, to) in moved.AsEnumerable().Reverse()) Directory.Move(to, from);
            throw;
        }
    }

    private static void TransferWithCopies(string source, string destination, bool isFolder, bool copy, (string Source, string Target)[] attachments)
    {
        string staging = Path.Combine(Path.GetDirectoryName(destination)!, ".scripta-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        try
        {
            string stagedEntry = Path.Combine(staging, Path.GetFileName(source));
            if (isFolder)
            {
                CopyDirectory(source, stagedEntry);
                Directory.Move(stagedEntry, destination);
                return;
            }

            if (copy) File.Copy(source, stagedEntry);
            var stagedAttachments = new List<(string Source, string Target)>();
            foreach (var (from, to) in attachments)
            {
                string staged = Path.Combine(staging, Path.GetFileName(from));
                CopyDirectory(from, staged);
                stagedAttachments.Add((staged, to));
            }
            MoveNoteWithAttachments(copy ? stagedEntry : source, destination, stagedAttachments.ToArray());
        }
        finally
        {
            try { Directory.Delete(staging, recursive: true); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var entry in new DirectoryInfo(source).EnumerateFileSystemInfos())
        {
            if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new IOException("无法复制包含链接的文件夹。");
            string target = Path.Combine(destination, entry.Name);
            if (entry is DirectoryInfo) CopyDirectory(entry.FullName, target);
            else File.Copy(entry.FullName, target);
        }
    }
}
