using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.VisualBasic.FileIO;

namespace Moye;

internal sealed partial class EditorWindow
{
    private const string WelcomeNoteName = "开始使用.md";
    private const string ReferenceFolderName = "资料";
    private const string ReferenceSuffix = ".资料";

    private static bool IsReferenceFolder(string name) =>
        name == ReferenceFolderName || name.EndsWith(ReferenceSuffix, StringComparison.Ordinal);

    private static readonly HashSet<string> AppFolders = new(StringComparer.OrdinalIgnoreCase)
    {
        "desktop", "dist", "web",
    };

    private static readonly EnumerationOptions NoteEnumeration = new()
    {
        AttributesToSkip = FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReparsePoint,
    };

    private string? notesRoot;
    private string NotesRootFile => Path.Combine(view.CoreWebView2.Environment.UserDataFolder, "scripta-notes-root.txt");
    private sealed record NoteEntry(string Name, string Path, IReadOnlyList<NoteEntry>? Children = null,
        bool Resource = false, long SizeBytes = 0, int FileCount = 0);
    private sealed record NoteFolder(List<NoteEntry> Entries, long SizeBytes, int FileCount);

    private static bool IsScriptaSourceFolder(string path)
    {
        for (DirectoryInfo? folder = new(path); folder is not null; folder = folder.Parent)
        {
            if (File.Exists(Path.Combine(folder.FullName, "desktop", "Moye.csproj")) &&
                File.Exists(Path.Combine(folder.FullName, "web", "editor.js")))
                return true;
        }
        return false;
    }

    private async Task LoadNotesRoot()
    {
        string? saved = await TryReadNoteText(NotesRootFile);
        notesRoot = saved is not null && Path.IsPathFullyQualified(saved) && Directory.Exists(saved) &&
            !IsScriptaSourceFolder(saved) ? saved : null;
    }

    private async Task<Response> ChooseNotesFolder()
    {
        using var dialog = new FolderBrowserDialog
        {
            Description = "选择笔记仓库",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = false,
            InitialDirectory = notesRoot ?? "",
        };
        if (dialog.ShowDialog(this) == DialogResult.OK)
        {
            if (IsScriptaSourceFolder(dialog.SelectedPath))
                return new Response(Error: "这是思刻的软件源码目录。请选择 notebook 的本地文件夹。");
            if (!TryWriteProfilePath(NotesRootFile, dialog.SelectedPath))
                return new Response(Error: "无法保存笔记仓库位置。");
            notesRoot = dialog.SelectedPath;
        }
        return await ListNotes();
    }

    private Response UnbindNotesFolder()
    {
        if (!TryWriteProfilePath(NotesRootFile, ""))
            return new Response(Error: "无法清除笔记仓库绑定。");
        notesRoot = null;
        pendingCommit = null;
        return new Response();
    }

    private async Task<Response> ListNotes()
    {
        if (notesRoot is not { } root) return new Response();
        var folder = await Task.Run(() => ReadNoteFolder(root, "", rootLevel: true));
        return new Response(Repository: root, Notes: folder.Entries,
            RepositorySizeBytes: folder.SizeBytes, RepositoryFileCount: folder.FileCount);
    }

    private Response OpenNotesRoot() =>
        notesRoot is { } root && Directory.Exists(root)
            ? OpenInExplorer(root)
            : new Response(Error: "请先在笔记侧栏选择笔记仓库。");

    private static NoteFolder ReadNoteFolder(string folder, string relativePath, bool rootLevel = false, bool resources = false)
    {
        var entries = new List<NoteEntry>();
        long sizeBytes = 0;
        int fileCount = 0;
        var children = new DirectoryInfo(folder).EnumerateFileSystemInfos("*", NoteEnumeration)
            .OrderBy(item => item is DirectoryInfo ? 1 : rootLevel && IsWelcomeNote(item.Name) ? 0 : 2)
            .ThenBy(item => item.Name, StringComparer.CurrentCultureIgnoreCase);
        foreach (var item in children)
        {
            string path = Path.Combine(relativePath, item.Name);
            if (item is DirectoryInfo directory)
            {
                bool noteReferences = item.Name.EndsWith(ReferenceSuffix, StringComparison.Ordinal);
                if (noteReferences || SkipNoteFolder(item.Name, rootLevel))
                {
                    if (!item.Name.StartsWith('.') &&
                        (noteReferences || item.Name.EndsWith(".assets", StringComparison.OrdinalIgnoreCase)))
                        sizeBytes += directory.EnumerateFiles("*", AssetEnumeration).Sum(file => file.Length);
                    continue;
                }
                bool resourceFolder = resources || IsReferenceFolder(item.Name);
                var descendants = ReadNoteFolder(item.FullName, path, resources: resourceFolder);
                sizeBytes += descendants.SizeBytes;
                fileCount += descendants.FileCount;
                if (rootLevel || resourceFolder || descendants.Entries.Count > 0 ||
                    !directory.EnumerateFileSystemInfos().Any())
                    entries.Add(new NoteEntry(item.Name, path, descendants.Entries, resourceFolder,
                        descendants.SizeBytes, descendants.FileCount));
            }
            else if (item is FileInfo file && !item.Name.StartsWith('.'))
            {
                sizeBytes += file.Length;
                bool note = rootLevel ? IsRootNote(item.Name) : IsNoteFile(item.Name);
                if (note || resources)
                {
                    entries.Add(new NoteEntry(item.Name, path, Resource: !note));
                    fileCount++;
                }
            }
        }
        return new NoteFolder(entries, sizeBytes, fileCount);
    }

    private static readonly EnumerationOptions AssetEnumeration = new()
    {
        AttributesToSkip = NoteEnumeration.AttributesToSkip,
        RecurseSubdirectories = true,
    };

    private static bool SkipNoteFolder(string name, bool rootLevel) =>
        name.StartsWith('.') || name.EndsWith(".assets", StringComparison.OrdinalIgnoreCase) ||
        (rootLevel && AppFolders.Contains(name));

    private static bool IsNoteFile(string name) =>
        !name.StartsWith('.') && Path.GetExtension(name).ToLowerInvariant() is ".md" or ".markdown";

    private static bool IsWelcomeNote(string name) =>
        name.Equals(WelcomeNoteName, StringComparison.OrdinalIgnoreCase);

    private static bool IsRootNote(string name) =>
        IsNoteFile(name) && !Path.GetFileNameWithoutExtension(name).Equals("README", StringComparison.OrdinalIgnoreCase);

    private async Task<Response> CreateRepositoryEntry(string relativeFolder, string name, bool folder, bool openNote = true)
    {
        var parent = relativeFolder.Length == 0 ? notesRoot : ResolveRepositoryEntry(relativeFolder, isFolder: true);
        if (parent is null || !Directory.Exists(parent))
            return new Response(Error: "请先选择有效的笔记目录。");
        if (string.IsNullOrWhiteSpace(name) || name != name.Trim() || name.EndsWith('.') ||
            name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || IsDeviceName(name))
            return new Response(Error: "请输入有效的名称。");
        if (!folder && !IsNoteFile(name)) name += ".md";
        bool root = relativeFolder.Length == 0;
        if (folder ? SkipNoteFolder(name, root) : root ? !IsRootNote(name) : !IsNoteFile(name))
            return new Response(Error: "这个名称不能用作笔记库中的新项目。");
        string path = Path.Combine(parent, name);
        if (Path.Exists(path)) return new Response(Error: "该目录中已有同名项目。");
        if (folder) Directory.CreateDirectory(path);
        else
        {
            using var stream = File.Open(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        }
        string relative = Path.Combine(relativeFolder, name);
        return folder || !openNote ? new Response(Name: name, NotePath: relative) :
            (await ReadDocument(path)) with { NotePath = relative };
    }

    private async Task<Response> OpenRepositoryNote(string relativePath)
    {
        var path = ResolveRepositoryEntry(relativePath, isFolder: false);
        return path is null
            ? new Response(Error: "请选择仓库中的 Markdown 笔记")
            : await ReadDocument(path);
    }

    private Response RecycleRepositoryNotes(IReadOnlyList<string> relativePaths, IReadOnlyDictionary<string, string>? fingerprints = null)
    {
        var paths = relativePaths.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        string confirmation = fingerprints is null ? $"将选中的 {paths.Length} 份笔记移到回收站？" :
            $"将以下 {paths.Length} 份原稿移到回收站？已改动的原稿会保留。\n\n" +
            string.Join("\n", paths.Take(12)) + (paths.Length > 12 ? $"\n… 另有 {paths.Length - 12} 份" : "");
        if (!ConfirmAction(fingerprints is null ? "删除笔记" : "删除合并前的原稿",
            confirmation, "移到回收站", destructive: true))
            return new Response();

        var recycled = new List<string>();
        bool deletedCurrent = false;
        foreach (string path in paths)
        {
            try
            {
                if (fingerprints is not null && !MatchesMergedOriginal(path, fingerprints[path])) continue;
                var result = DeleteRepositoryNote(path, confirmed: true);
                if (result.Name is null) continue;
                recycled.Add(path);
                deletedCurrent |= result.DeletedCurrent;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                System.Diagnostics.Debug.WriteLine(error);
            }
        }
        int skipped = paths.Length - recycled.Count;
        return new Response(DeletedCurrent: deletedCurrent, RecycledNotes: recycled,
            BatchNotice: skipped == 0 ? null : fingerprints is null ? $"有 {skipped} 份笔记未能移到回收站。" :
                $"有 {skipped} 份原稿已修改或无法移到回收站，已跳过。");
    }

    private Response DeleteRepositoryNote(string relativePath, bool folder = false, bool permanent = false, bool confirmed = false)
    {
        var path = ResolveRepositoryEntry(relativePath, isFolder: folder);
        if (path is null || !IsInsideFolder(notesRoot!, path))
            return new Response(Error: "此项目已不可用，请刷新笔记列表。");

        string name = Path.GetFileName(path);
        string confirmation = permanent
            ? $"永久删除「{name}」{(folder ? "及其所有内容" : "")}？此操作无法撤销。"
            : $"将「{name}」移到回收站？";
        if (!confirmed && !ConfirmAction(permanent ? "永久删除" : "删除笔记",
            confirmation, permanent ? "永久删除" : "移到回收站", destructive: true))
            return new Response();

        try
        {
            if (permanent && folder) Directory.Delete(path, recursive: true);
            else if (permanent) File.Delete(path);
            else FileSystem.DeleteFile(path, UIOption.OnlyErrorDialogs, RecycleOption.SendToRecycleBin, UICancelOption.ThrowException);
        }
        catch (OperationCanceledException)
        {
            return new Response();
        }

        bool deletedCurrent = documentPath is { } current &&
            (folder ? IsInsideFolder(path, current) : SamePath(current, path));
        if (deletedCurrent)
        {
            documentPath = diskContents = null;
            documentToken = null;
            DeleteTemporaryFile(RememberedNoteFile);
        }
        return new Response(Name: name, DeletedCurrent: deletedCurrent);
    }

    private Response RenameRepositoryFolder(string relativePath, string? name)
    {
        string? original = ResolveRepositoryEntry(relativePath, isFolder: true);
        if (original is null) return new Response(Error: "此文件夹已不可用，请刷新笔记列表。");

        string parent = Path.GetDirectoryName(original)!;
        if (string.IsNullOrWhiteSpace(name) || name != name.Trim() || name.EndsWith('.') ||
            name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || IsDeviceName(name) ||
            SkipNoteFolder(name, rootLevel: parent.Equals(notesRoot, StringComparison.OrdinalIgnoreCase)))
            return new Response(Error: "请输入有效的文件夹名称。");

        string destination = Path.Combine(parent, name);
        if (destination == original) return new Response();
        if (IsOccupied(destination, original))
            return new Response(Error: "此处已存在同名文件或文件夹。");

        // Directory.Move rejects paths that differ only in letter case on Windows.
        if (destination.Equals(original, StringComparison.OrdinalIgnoreCase))
        {
            if (!MoveFileEx(original, destination, 0))
                throw new IOException("无法重命名文件夹。", new Win32Exception(Marshal.GetLastWin32Error()));
        }
        else
        {
            Directory.Move(original, destination);
        }

        UpdateMovedDocument(original, destination, isFolder: true);
        return new Response(NotePath: Path.GetRelativePath(notesRoot!, destination));
    }

    [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileEx(string existingName, string newName, uint flags);

    private Response UseRepositoryEntry(string relativePath, bool isFolder, string action)
    {
        var path = ResolveRepositoryEntry(relativePath, isFolder);
        if (path is null) return new Response(Error: "此项目已不可用，请刷新笔记列表。");

        if (action is "copy-note-path" or "copy-relative-note-path")
        {
            string copiedPath = action == "copy-relative-note-path" ? Path.GetRelativePath(notesRoot!, path) : path;
            try { Clipboard.SetText(copiedPath); }
            catch (ExternalException) { return new Response(Error: "无法写入剪贴板，请重试。"); }
        }
        else
        {
            return OpenInExplorer(path, select: action == "reveal-note");
        }
        return new Response();
    }

    private Response RevealRepositoryResource(string relativePath)
    {
        var path = ResolveRepositoryEntry(relativePath, isFolder: false, isResource: true);
        return path is null
            ? new Response(Error: "此资料文件已不可用，请刷新笔记列表。")
            : OpenInExplorer(path, select: true);
    }

    private static Response OpenInExplorer(string path, bool select = false)
    {
        if (select)
        {
            int parsed = SHParseDisplayName(path, IntPtr.Zero, out IntPtr item, 0, IntPtr.Zero);
            try
            {
                if (parsed >= 0 && item != IntPtr.Zero &&
                    SHOpenFolderAndSelectItems(item, 0, IntPtr.Zero, 0) >= 0)
                    return new Response();

                return new Response(Error: "无法在文件资源管理器中定位此项目。");
            }
            finally
            {
                Marshal.FreeCoTaskMem(item);
            }
        }

        try
        {
            using var explorer = Process.Start(new ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true });
            return new Response();
        }
        catch (Win32Exception)
        {
            return new Response(Error: "无法打开文件资源管理器。");
        }
    }

    [DllImport("shell32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int SHParseDisplayName(string name, IntPtr bindContext, out IntPtr item,
        uint requestedAttributes, IntPtr attributes);

    [DllImport("shell32.dll", ExactSpelling = true)]
    private static extern int SHOpenFolderAndSelectItems(IntPtr folder, uint itemCount, IntPtr items, uint flags);

    private string? ResolveRepositoryEntry(string relativePath, bool isFolder, bool isResource = false)
    {
        if (notesRoot is not { } root || Path.IsPathRooted(relativePath))
            return null;

        string[] parts = relativePath.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (isResource)
        {
            if (parts[^1].StartsWith('.') || !parts.Take(parts.Length - 1).Any(IsReferenceFolder))
                return null;
        }
        else if (!isFolder && (parts.Length == 1 ? !IsRootNote(parts[0]) : !IsNoteFile(parts[^1])))
        {
            return null;
        }

        string path = root;
        for (int index = 0; index < parts.Length; index++)
        {
            string part = parts[index];
            bool folder = isFolder || index < parts.Length - 1;
            if (part.Length == 0 || part.EndsWith('.') || part.EndsWith(' ') ||
                part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || IsDeviceName(part) ||
                (folder && SkipNoteFolder(part, rootLevel: index == 0)))
                return null;

            path = Path.Combine(path, part);
            var attributes = File.GetAttributes(path);
            if ((attributes & NoteEnumeration.AttributesToSkip) != 0 || attributes.HasFlag(FileAttributes.Directory) != folder)
                return null;
        }
        return path;
    }
}
