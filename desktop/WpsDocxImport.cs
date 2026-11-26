using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Moye;

internal sealed partial class EditorWindow
{
    private async Task<Response> ImportWpsDocx()
    {
        using var source = new OpenFileDialog
        {
            Title = "选择 WPS 智能文档导出的 DOCX（可多选）",
            Filter = "Word 文档 (*.docx)|*.docx",
            CheckFileExists = true,
            Multiselect = true,
        };
        if (source.ShowDialog(this) != DialogResult.OK) return new Response();
        return await ImportMarkdownFiles(source.FileNames, "保存导入后的 Markdown", ConvertWpsImport);
    }

    private static async Task<string?> ConvertWpsImport(string sourcePath, string outputPath)
    {
        try
        {
            await Task.Run(() => PublishWpsDocx(sourcePath, outputPath));
        }
        catch (Exception error) when (error is InvalidDataException or System.Xml.XmlException)
        {
            return "无法导入 DOCX：" + error.Message;
        }
        return null;
    }

    private static void PublishWpsDocx(string source, string destination)
    {
        string stage = Path.Combine(Path.GetDirectoryName(destination)!, ".scripta-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(stage);
        try
        {
            string note = Path.Combine(stage, Path.GetFileName(destination));
            using var input = new FileStream(source, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var package = new ZipArchive(input, ZipArchiveMode.Read);
            var converter = new WpsDocxMarkdown(package, Path.ChangeExtension(note, ".assets"));
            File.WriteAllText(note, converter.Convert(), Utf8);
            var attachments = NoteAttachmentPaths(note, destination).Where(item => Directory.Exists(item.Source)).ToArray();
            if (ImportDestinationExists(destination)) throw new IOException("目标笔记或同名附件目录已存在。");
            MoveNoteWithAttachments(note, destination, attachments);
        }
        finally
        {
            try { Directory.Delete(stage, recursive: true); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
    }
}

internal sealed class WpsDocxMarkdown
{
    private static readonly XNamespace W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    private static readonly XNamespace R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    private static readonly XNamespace A = "http://schemas.openxmlformats.org/drawingml/2006/main";
    private static readonly XNamespace V = "urn:schemas-microsoft-com:vml";
    private static readonly XNamespace P = "http://schemas.openxmlformats.org/package/2006/relationships";
    private static readonly Uri DocumentPart = new("https://docx.invalid/word/document.xml");
    private readonly ZipArchive package;
    private readonly string assets;
    private readonly Dictionary<string, XElement> styles;
    private readonly Dictionary<string, XElement> relationships;
    private readonly Dictionary<string, XElement> numbering;
    private readonly Dictionary<string, XElement> abstractNumbering;
    private readonly Dictionary<string, string> images = new(StringComparer.Ordinal);

    public WpsDocxMarkdown(ZipArchive package, string assets)
    {
        this.package = package;
        this.assets = assets;
        styles = Index(ReadPart("word/styles.xml"), W + "style", W + "styleId");
        relationships = Index(ReadPart("word/_rels/document.xml.rels"), P + "Relationship", "Id");
        var numbers = ReadPart("word/numbering.xml");
        numbering = Index(numbers, W + "num", W + "numId");
        abstractNumbering = Index(numbers, W + "abstractNum", W + "abstractNumId");
    }

    private XElement? ReadPart(string path)
    {
        var entry = package.GetEntry(path);
        if (entry is null) return null;
        using var stream = entry.Open();
        return XElement.Load(stream, LoadOptions.PreserveWhitespace);
    }

    private static Dictionary<string, XElement> Index(XElement? root, XName child, XName key)
    {
        var result = new Dictionary<string, XElement>(StringComparer.Ordinal);
        if (root is not null)
            foreach (var element in root.Elements(child))
                if ((string?)element.Attribute(key) is { } id) result[id] = element;
        return result;
    }

    private static string? Value(XElement? element) => (string?)element?.Attribute(W + "val");

    private IEnumerable<XElement> StyleChain(string? id)
    {
        var visited = new HashSet<string>(StringComparer.Ordinal);
        while (id is not null && visited.Add(id) && styles.TryGetValue(id, out var style))
        {
            yield return style;
            id = Value(style.Element(W + "basedOn"));
        }
    }

    private static IEnumerable<XElement> Blocks(XElement container)
    {
        foreach (var element in container.Elements())
        {
            if (element.Name == W + "p" || element.Name == W + "tbl") yield return element;
            else if (element.Name == W + "sdt" || element.Name == W + "sdtContent" ||
                element.Name == W + "customXml" || element.Name == W + "ins")
                foreach (var child in Blocks(element)) yield return child;
        }
    }

    public string Convert()
    {
        var body = ReadPart("word/document.xml")?.Element(W + "body")
            ?? throw new InvalidDataException("缺少正文，或文件不是受支持的 DOCX。");
        var output = new List<string>();
        var list = new List<string>();
        var markers = new List<int>();
        var codeLines = new List<string>();
        var outlinePath = new Stack<int>();
        bool hasMainTitle = false;
        void FlushList()
        {
            if (list.Count == 0) return;
            output.Add(string.Join('\n', list));
            list.Clear();
            markers.Clear();
        }
        void FlushCode()
        {
            if (codeLines.Count == 0) return;
            string code = string.Join('\n', codeLines);
            string fence = new('~', Regex.Matches(code, "~{3,}").Select(match => match.Length + 1).DefaultIfEmpty(3).Max());
            output.Add(fence + "\n" + code + "\n" + fence);
            codeLines.Clear();
        }

        foreach (var block in Blocks(body))
        {
            if (block.Name == W + "tbl")
            {
                FlushList();
                FlushCode();
                if (Table(block) is { Length: > 0 } table) output.Add(table);
                continue;
            }
            var properties = block.Element(W + "pPr");
            var chain = StyleChain(Value(properties?.Element(W + "pStyle"))).ToArray();
            var names = chain.Select(style => Value(style.Element(W + "name")) ?? "").ToArray();
            bool IsStyle(string name) => names.Contains(name, StringComparer.OrdinalIgnoreCase);
            if (IsStyle("CodeBlock"))
            {
                FlushList();
                codeLines.Add(PlainText(block));
                continue;
            }
            FlushCode();
            string text = Inline(block).Trim();
            if (IsStyle("Seperate") || IsStyle("Separator"))
            {
                FlushList();
                output.Add("---");
                continue;
            }
            if (text.Length == 0) continue;
            string? outline = Value(properties?.Element(W + "outlineLvl")) ??
                chain.Select(style => Value(style.Element(W + "pPr")?.Element(W + "outlineLvl"))).FirstOrDefault(value => value is not null);
            int heading = 0;
            if (IsStyle("MainTitle") || IsStyle("Title"))
            {
                outlinePath.Clear();
                hasMainTitle = true;
                heading = 2;
            }
            else if (int.TryParse(outline, out int level) && level is >= 0 and <= 8)
            {
                while (outlinePath.TryPeek(out int previous) && previous >= level) outlinePath.Pop();
                outlinePath.Push(level);
                heading = Math.Min(6, outlinePath.Count + (hasMainTitle ? 2 : 1));
            }
            var number = properties?.Element(W + "numPr") ??
                chain.Select(style => style.Element(W + "pPr")?.Element(W + "numPr")).FirstOrDefault(value => value is not null);
            if (heading == 0 && ListMarker(number) is { } item)
            {
                int depth = Math.Min(item.Level, markers.Count);
                if (markers.Count > depth) markers.RemoveRange(depth, markers.Count - depth);
                int indent = markers.Sum();
                markers.Add(item.Marker.Length);
                list.Add(new string(' ', indent) + item.Marker + Protect(text).Replace("\n", "\n" + new string(' ', indent + item.Marker.Length)));
                continue;
            }
            FlushList();
            if (heading > 0) output.Add(new string('#', heading) + " " + Regex.Replace(text, @"\s*\n\s*", " "));
            else if (IsStyle("Blockquote") || IsStyle("HighlightBlock")) output.Add("> " + Protect(text).Replace("\n", "\n> "));
            else output.Add(Protect(text));
        }
        FlushList();
        FlushCode();
        if (output.Count == 0) throw new InvalidDataException("正文没有可导入的内容。");
        return string.Join("\n\n", output) + "\n";
    }

    private (int Level, string Marker)? ListMarker(XElement? properties)
    {
        string? id = Value(properties?.Element(W + "numId"));
        if (id is null or "0" || !numbering.TryGetValue(id, out var number)) return null;
        string? abstractId = Value(number.Element(W + "abstractNumId"));
        if (abstractId is null || !abstractNumbering.TryGetValue(abstractId, out var definition)) return null;
        string depth = Value(properties?.Element(W + "ilvl")) ?? "0";
        var overrideLevel = number.Elements(W + "lvlOverride").FirstOrDefault(e => (string?)e.Attribute(W + "ilvl") == depth);
        var level = overrideLevel?.Element(W + "lvl") ??
            definition.Elements(W + "lvl").FirstOrDefault(e => (string?)e.Attribute(W + "ilvl") == depth);
        string? format = Value(level?.Element(W + "numFmt"));
        if (format is null or "none") return null;
        string start = Value(overrideLevel?.Element(W + "startOverride")) ?? Value(level?.Element(W + "start")) ?? "1";
        int ordinal = int.TryParse(start, out int parsed) ? Math.Clamp(parsed, 0, 999999999) : 1;
        return (int.TryParse(depth, out int indent) ? Math.Clamp(indent, 0, 8) : 0,
            format == "bullet" ? "- " : $"{ordinal}. ");
    }

    private string Table(XElement table)
    {
        var rows = table.Elements(W + "tr").Select(row =>
        {
            var cells = new List<string>();
            foreach (var cell in row.Elements(W + "tc"))
            {
                cells.Add(string.Join("<br>", Blocks(cell).Where(block => block.Name == W + "p").Select(Inline)
                    .Select(text => text.Trim().Replace("\n", "<br>").Replace("|", "\\|"))));
                if (int.TryParse(Value(cell.Element(W + "tcPr")?.Element(W + "gridSpan")), out int span))
                    for (int column = 1; column < Math.Clamp(span, 1, 256); column++) cells.Add("");
            }
            return cells;
        }).Where(row => row.Count > 0).ToArray();
        if (rows.Length == 0) return "";
        int width = rows.Max(row => row.Count);
        string Row(IEnumerable<string> cells) => "| " + string.Join(" | ", cells) + " |";
        string Content(List<string> row) => Row(row.Concat(Enumerable.Repeat("", width - row.Count)));
        bool header = table.Element(W + "tr")?.Element(W + "trPr")?.Element(W + "tblHeader") is not null;
        return string.Join('\n', new[] { header ? Content(rows[0]) : Row(Enumerable.Repeat("", width)),
            Row(Enumerable.Repeat("---", width)) }.Concat(rows.Skip(header ? 1 : 0).Select(Content)));
    }

    private sealed class Field
    {
        public StringBuilder Instruction { get; } = new();
        public StringBuilder Label { get; } = new();
        public bool ReadingLabel { get; set; }
    }

    private string Inline(XElement block)
    {
        var result = new StringBuilder();
        var fields = new Stack<Field>();
        var run = new StringBuilder();
        (bool Bold, bool Italic, bool Strike, bool Code) style = default;
        void Append(string value)
        {
            if (fields.TryPeek(out var field))
            {
                if (field.ReadingLabel) field.Label.Append(value);
            }
            else result.Append(value);
        }
        void FlushRun()
        {
            if (run.Length == 0) return;
            string value = run.ToString();
            run.Clear();
            string core = value.Trim();
            if (core.Length == 0) { Append(value); return; }
            int left = value.Length - value.TrimStart().Length;
            string formatted;
            if (style.Code)
            {
                string ticks = new('\u0060', Regex.Matches(core, "\u0060+").Select(match => match.Length + 1).DefaultIfEmpty(1).Max());
                string pad = core.StartsWith('\u0060') || core.EndsWith('\u0060') ? " " : "";
                formatted = ticks + pad + core + pad + ticks;
            }
            else
            {
                formatted = Escape(core);
                if (style.Bold) formatted = "**" + formatted + "**";
                if (style.Italic) formatted = "*" + formatted + "*";
                if (style.Strike) formatted = "~~" + formatted + "~~";
            }
            Append(value[..left] + formatted + value[(left + core.Length)..]);
        }
        void EndField()
        {
            var field = fields.Pop();
            Append(Link(field.Label.ToString(), FieldAddress(field.Instruction.ToString())));
        }
        void Walk(XElement element)
        {
            if (element.Name == W + "r")
            {
                var properties = element.Element(W + "rPr");
                var chain = StyleChain(Value(properties?.Element(W + "rStyle"))).ToArray();
                bool Flag(string name)
                {
                    var flag = properties?.Element(W + name) ?? chain.Select(s => s.Element(W + "rPr")?.Element(W + name))
                        .FirstOrDefault(value => value is not null);
                    return flag is not null && Value(flag) is not ("0" or "false" or "off");
                }
                var nextStyle = (Flag("b"), Flag("i"), Flag("strike") || Flag("dstrike"),
                    chain.Any(s => string.Equals(Value(s.Element(W + "name")), "Code", StringComparison.OrdinalIgnoreCase)));
                if (nextStyle != style) { FlushRun(); style = nextStyle; }
                foreach (var child in element.Elements())
                {
                    if (child.Name == W + "t") run.Append(child.Value);
                    else if (child.Name == W + "tab") run.Append("    ");
                    else if (child.Name == W + "br" || child.Name == W + "cr") { FlushRun(); Append("  \n"); }
                    else if (child.Name == W + "drawing" || child.Name == W + "pict") { FlushRun(); Append(Image(child)); }
                    else if (child.Name == W + "instrText" && fields.TryPeek(out var current)) current.Instruction.Append(child.Value);
                    else if (child.Name == W + "fldChar")
                    {
                        FlushRun();
                        switch ((string?)child.Attribute(W + "fldCharType"))
                        {
                            case "begin": fields.Push(new Field()); break;
                            case "separate" when fields.TryPeek(out var field): field.ReadingLabel = true; break;
                            case "end" when fields.Count > 0: EndField(); break;
                        }
                    }
                }
            }
            else if (element.Name == W + "hyperlink" || element.Name == W + "fldSimple")
            {
                FlushRun();
                string? id = (string?)element.Attribute(R + "id");
                string? anchor = (string?)element.Attribute(W + "anchor");
                string? address = element.Name == W + "fldSimple" ? FieldAddress((string?)element.Attribute(W + "instr") ?? "") :
                    id is not null && relationships.TryGetValue(id, out var relationship) ? (string?)relationship.Attribute("Target") :
                    anchor is not null ? "#" + anchor : null;
                Append(Link(Inline(element), address));
            }
            else if (element.Name != W + "del" && element.Name != W + "moveFrom" && element.Name != W + "pPr")
                foreach (var child in element.Elements()) Walk(child);
        }
        foreach (var child in block.Elements()) Walk(child);
        FlushRun();
        while (fields.Count > 0) EndField();
        return result.ToString();
    }

    private static string PlainText(XElement element) => string.Concat(element.Descendants()
        .Where(node => node.Name.Namespace == W && !node.Ancestors(W + "del").Any())
        .Select(node => node.Name.LocalName switch { "t" => node.Value, "br" or "cr" => "\n", "tab" => "\t", _ => "" }));

    private static string? FieldAddress(string instruction)
    {
        var match = Regex.Match(instruction, "^\\s*HYPERLINK\\s+(?:\"([^\"]+)\"|([^\\s\\\\]+))", RegexOptions.IgnoreCase);
        return !match.Success ? null : match.Groups[1].Success ? match.Groups[1].Value : match.Groups[2].Value;
    }

    private static string Link(string label, string? address)
    {
        if (string.IsNullOrWhiteSpace(address) || string.IsNullOrWhiteSpace(label)) return label;
        if (!address.StartsWith('#') && (!Uri.TryCreate(address, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https" or "mailto"))) return label;
        string target = address.Replace("\\", "%5C").Replace("<", "%3C").Replace(">", "%3E").Replace("\n", "%0A").Replace("\r", "%0D");
        return "[" + label + "](<" + target + ">)";
    }

    private string Image(XElement drawing)
    {
        string? id = (string?)drawing.Descendants(A + "blip").FirstOrDefault()?.Attribute(R + "embed") ??
            (string?)drawing.Descendants(V + "imagedata").FirstOrDefault()?.Attribute(R + "id");
        string alt = (string?)drawing.Descendants().FirstOrDefault(node => node.Name.LocalName == "docPr")?.Attribute("descr") ?? "图片";
        if (id is null || !relationships.TryGetValue(id, out var relationship) ||
            (string?)relationship.Attribute("TargetMode") == "External" ||
            !Uri.TryCreate(DocumentPart, (string?)relationship.Attribute("Target"), out var uri) ||
            uri.Host != DocumentPart.Host || uri.Scheme != DocumentPart.Scheme)
            return Escape(alt);
        string part = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/'));
        var entry = package.GetEntry(part);
        string extension = Path.GetExtension(part).ToLowerInvariant();
        if (entry is null || extension is not (".png" or ".jpg" or ".jpeg" or ".gif" or ".bmp" or ".webp" or ".svg" or ".ico" or ".apng"))
            return Escape(alt);
        if (!images.TryGetValue(part, out var file))
        {
            file = $"image-{images.Count + 1:D2}{extension}";
            Directory.CreateDirectory(assets);
            entry.ExtractToFile(Path.Combine(assets, file));
            images.Add(part, file);
        }
        return "![" + Escape(alt) + "](" + Uri.EscapeDataString(Path.GetFileName(assets)) + "/" + file + ")";
    }

    private static string Escape(string text) => Regex.Replace(text, @"[\\\x60*_~\[\]<>]", @"\$0").Replace("&", "&amp;");

    private static string Protect(string text) => Regex.Replace(text,
        @"(?m)^( {0,3})(?:(#{1,6}|[-+])(?=\s|$)|(\d{1,9})([.)])(?=\s)|(-)(?=[ -]*$)|(=)(?==*[ \t]*$))",
        match => match.Groups[3].Success ? match.Groups[1].Value + match.Groups[3].Value + "\\" + match.Groups[4].Value :
            match.Groups[1].Value + "\\" + match.Value[match.Groups[1].Length..]);
}
