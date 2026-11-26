using System.Text;
using System.Text.RegularExpressions;

namespace Moye;

internal sealed partial class EditorWindow
{
    private const int SearchLimit = 80;
    private static readonly Regex SearchHeading = new(@"^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$", RegexOptions.Compiled);
    private static readonly Regex SearchFence = new(@"^ {0,3}(`{3,}|~{3,})(.*)$", RegexOptions.Compiled);
    private static readonly Regex SearchUnderline = new(@"^ {0,3}(?:=+|-+)[ \t]*$", RegexOptions.Compiled);

    private sealed record NoteHit(string Path, string? Heading, string? Preview, int? Line, string? Match, int Rank);

    private async Task<Response> SearchNotes(string query)
    {
        if (notesRoot is not { } root) return new Response(Error: "请先选择笔记仓库。");
        query = query.Trim();
        if (query.Length == 0) return new Response(SearchResults: []);
        return await Task.Run(() =>
        {
            var best = new PriorityQueue<NoteHit, (int Rank, int Order)>();
            int order = 0;
            int skipped = 0;
            foreach (var hit in SearchNoteFolder(root, "", query, () => skipped++))
            {
                best.Enqueue(hit, (-hit.Rank, -order++));
                if (best.Count > SearchLimit) best.Dequeue();
            }
            var results = new List<NoteHit>(best.Count);
            while (best.TryDequeue(out var hit, out _)) results.Add(hit);
            results.Reverse();
            return new Response(SearchResults: results, SearchTruncated: order > SearchLimit, SkippedCount: skipped);
        });
    }

    private static IEnumerable<NoteHit> SearchNoteFolder(string folder, string relative, string query, Action skip)
    {
        FileSystemInfo[] entries;
        try
        {
            entries = new DirectoryInfo(folder).EnumerateFileSystemInfos("*", NoteEnumeration)
                .OrderBy(item => item.Name, StringComparer.OrdinalIgnoreCase).ToArray();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            skip();
            yield break;
        }

        bool rootLevel = relative.Length == 0;
        foreach (var item in entries)
        {
            string path = Path.Combine(relative, item.Name);
            if (item is DirectoryInfo && !SkipNoteFolder(item.Name, rootLevel))
            {
                foreach (var hit in SearchNoteFolder(item.FullName, path, query, skip)) yield return hit;
            }
            if (item is not FileInfo || !(rootLevel ? IsRootNote(item.Name) : IsNoteFile(item.Name))) continue;
            if (item.Name.Contains(query, StringComparison.OrdinalIgnoreCase))
                yield return new NoteHit(path, null, null, null, null, 0);

            List<NoteHit> matches;
            try { matches = SearchNoteText(item.FullName, path, query); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or DecoderFallbackException)
            {
                skip();
                continue;
            }
            foreach (var hit in matches) yield return hit;
        }
    }

    private static List<NoteHit> SearchNoteText(string file, string path, string query)
    {
        var results = new List<NoteHit>();
        using var reader = new StreamReader(file, Utf8, detectEncodingFromByteOrderMarks: false);
        string? heading = null;
        string? fence = null;
        string? line = reader.ReadLine()?.TrimStart('\uFEFF');
        bool afterBlank = true;
        bool matchedChapter = false;
        for (int index = 0; line is not null; index++)
        {
            string? next = reader.ReadLine();
            var marker = SearchFence.Match(line);
            string? title = null;
            if (fence is null)
            {
                if (marker.Success) fence = marker.Groups[1].Value;
                else
                {
                    var atx = SearchHeading.Match(line);
                    if (atx.Success) title = atx.Groups[1].Value;
                    else if (afterBlank && !string.IsNullOrWhiteSpace(line) && !line.StartsWith("    ") &&
                        next is not null && SearchUnderline.IsMatch(next)) title = line.Trim();
                }
            }
            else if (marker.Success && marker.Groups[1].Value[0] == fence[0] &&
                marker.Groups[1].Length >= fence.Length && string.IsNullOrWhiteSpace(marker.Groups[2].Value))
            {
                fence = null;
            }

            if (title is not null)
            {
                heading = title;
                matchedChapter = false;
            }
            int start = line.IndexOf(query, StringComparison.OrdinalIgnoreCase);
            if (start >= 0 && !matchedChapter)
            {
                int from = Math.Max(0, start - 45);
                int to = Math.Min(line.Length, start + query.Length + 75);
                string preview = (from > 0 ? "…" : "") + line[from..to].Trim() + (to < line.Length ? "…" : "");
                results.Add(new NoteHit(path, heading, preview, index, line.Substring(start, query.Length), title is null ? 2 : 1));
                matchedChapter = true;
            }
            afterBlank = string.IsNullOrWhiteSpace(line);
            line = next;
        }
        return results;
    }
}
