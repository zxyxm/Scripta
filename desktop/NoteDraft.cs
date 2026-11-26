namespace Moye;

internal sealed partial class EditorWindow
{
    private string RememberedNoteFile => Path.Combine(view.CoreWebView2.Environment.UserDataFolder, "moye-last-note.txt");

    private void RememberNotePath(string path) => TryWriteProfilePath(RememberedNoteFile, path);

    private static bool TryWriteProfilePath(string file, string path)
    {
        string temporary = file + "." + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(temporary, path, Utf8);
            File.Move(temporary, file, overwrite: true);
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            DeleteTemporaryFile(temporary);
            return false;
        }
    }

    private async Task<Response> RestoreNote(string name, string savedContents, bool dirty)
    {
        var remembered = await TryReadNoteText(RememberedNoteFile);
        if (remembered is not null && Path.IsPathFullyQualified(remembered) && SameNoteName(remembered, name))
        {
            var disk = await TryReadNoteText(remembered);
            if (disk is not null)
            {
                if (DraftMatches(disk, savedContents)) return BindDocument(remembered, disk);
                // Keep the path and the draft's original baseline when both versions changed.
                return dirty
                    ? BindDocument(remembered, savedContents) with { DiskChanged = true }
                    : BindDocument(remembered, disk, includeContents: true);
            }
        }

        // Drafts created before the path was remembered can recover a unique matching repository note.
        if (notesRoot is not { } root || savedContents.Length == 0) return new Response();
        var tree = await Task.Run(() => ReadNoteFolder(root, "", rootLevel: true));
        string? path = null;
        string? contents = null;
        foreach (string candidate in FindNotesByName(tree.Entries, name))
        {
            string fullPath = Path.Combine(root, candidate);
            var disk = await TryReadNoteText(fullPath);
            if (disk is null || !DraftMatches(disk, savedContents)) continue;
            if (path is not null) return new Response();
            path = fullPath;
            contents = disk;
        }
        return path is null ? new Response() : BindDocument(path, contents!);
    }

    private static IEnumerable<string> FindNotesByName(IEnumerable<NoteEntry> entries, string name)
    {
        foreach (var entry in entries)
        {
            if (entry.Children is { } children)
            {
                foreach (string match in FindNotesByName(children, name)) yield return match;
            }
            else if (!entry.Resource && SameNoteName(entry.Name, name))
            {
                yield return entry.Path;
            }
        }
    }

    private static bool SameNoteName(string path, string name) =>
        Path.GetFileName(path).Equals(name, StringComparison.OrdinalIgnoreCase);

    private static bool DraftMatches(string disk, string savedContents) =>
        NormalizeNoteText(disk) == NormalizeNoteText(savedContents);

    private static string NormalizeNoteText(string text) =>
        (text.StartsWith('\uFEFF') ? text[1..] : text).Replace("\r\n", "\n").Replace('\r', '\n');

    private static async Task<string?> TryReadNoteText(string path)
    {
        try { return Utf8.GetString(await File.ReadAllBytesAsync(path)); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.DecoderFallbackException)
        {
            return null;
        }
    }
}
