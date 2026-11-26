using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Moye;

internal sealed partial class EditorWindow
{
    private async Task<Response> OpenLinkedPdf(Request request)
    {
        if (documentPath is not { } note || request.Token != documentToken ||
            !Uri.TryCreate(request.NotePath, UriKind.Relative, out _))
            return new Response(Error: "请先打开或保存这篇笔记。");

        string folder = Path.GetDirectoryName(note)!;
        string path = Uri.UnescapeDataString(request.NotePath!.Split('#', '?')[0]);
        if (Path.IsPathRooted(path) || path.Contains(':')) return new Response(Error: "PDF 链接需要使用相对路径。");
        path = Path.GetFullPath(path, folder);
        string boundary = notesRoot is { } root && IsInsideFolder(root, note) ? root : folder;
        if (!IsInsideFolder(boundary, path) || !Path.GetExtension(path).Equals(".pdf", StringComparison.OrdinalIgnoreCase))
            return new Response(Error: "PDF 链接超出笔记目录。");
        for (string? item = path; item is not null && !SamePath(item, boundary); item = Path.GetDirectoryName(item))
        {
            if (!Path.Exists(item) || File.GetAttributes(item).HasFlag(FileAttributes.ReparsePoint))
                return new Response(Error: "找不到链接的 PDF 文件。");
        }
        var address = request.NotePath!;
        int fragment = address.IndexOf('#');
        if (fragment < 0 || !address.AsSpan(fragment + 1).StartsWith("page=", StringComparison.OrdinalIgnoreCase))
            return OpenPdfFile(path);
        string pageParameter = address[(fragment + 6)..];
        int separator = pageParameter.IndexOf('&');
        if (separator >= 0) pageParameter = pageParameter[..separator];
        if (!int.TryParse(pageParameter, NumberStyles.None, CultureInfo.InvariantCulture, out int page) || page < 1)
            return new Response(Error: "PDF 页码必须是从 1 开始的整数。");
        string reference = string.Join("/", Path.GetRelativePath(folder, path).Split(Path.DirectorySeparatorChar)
            .Select(Uri.EscapeDataString));
        return await ShowPdfPage(path, reference, page);
    }

    private static Response OpenPdfFile(string path)
    {
        if (!File.Exists(path)) return new Response(Error: "找不到 PDF 文件。");
        try
        {
            using var reader = Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
            return new Response(OpenedPdf: Path.GetFileName(path));
        }
        catch (Win32Exception)
        {
            return new Response(Error: "无法打开 PDF，请检查 Windows 的默认 PDF 阅读器。");
        }
    }

    private async Task<Response> ImportPdf(bool withSource)
    {
        using var source = new OpenFileDialog
        {
            Filter = "PDF 文件 (*.pdf)|*.pdf",
            Title = "选择要导入的 PDF（可多选）",
            CheckFileExists = true,
            Multiselect = true,
        };
        if (source.ShowDialog(this) != DialogResult.OK) return new Response();

        return await ImportMarkdownFiles(source.FileNames,
            withSource ? "保存 Markdown（原始 PDF 副本将放在同名 .assets 目录）" : "保存导入后的 Markdown",
            async (input, output) =>
            {
                string[] arguments = withSource ? [input, output, "--with-source"] : [input, output];
                var (_, error) = await RunPdfTool(arguments);
                return error;
            }, shortFirstSuffix: true);
    }

    private async Task<Response> ImportMarkdownFiles(string[] sources, string title,
        Func<string, string, Task<string?>> convert, bool shortFirstSuffix = false)
    {
        string folder = GetImportOutputFolder(sources[0]);
        if (sources.Length > 1)
        {
            using var target = new FolderBrowserDialog
            {
                Description = "选择批量导入的保存文件夹",
                UseDescriptionForTitle = true,
                InitialDirectory = folder,
            };
            if (target.ShowDialog(this) != DialogResult.OK) return new Response();
            var batch = await ConvertImportBatch(sources, target.SelectedPath, convert, shortFirstSuffix);
            if (IsDisposed) return new Response();
            if (batch.Failures.Count > 0)
            {
                var summary = $"成功导入 {batch.Count} 个文件，失败 {batch.Failures.Count} 个。";
                var details = string.Join("\n\n", batch.Failures.Take(8));
                if (batch.Failures.Count > 8) details += $"\n\n另有 {batch.Failures.Count - 8} 个文件导入失败。";
                ShowNotice("批量导入结果", summary + "\n\n" + details);
            }
            var result = batch.First is { } first ? await ReadDocument(first) : new Response();
            return result with { ImportedCount = batch.Count, SkippedCount = batch.Failures.Count };
        }

        using var destination = new SaveFileDialog
        {
            Filter = "Markdown 文档 (*.md)|*.md",
            Title = title,
            InitialDirectory = folder,
            FileName = Path.GetFileName(FindImportDestination(folder, sources[0], shortFirstSuffix)),
            DefaultExt = "md",
            AddExtension = true,
            OverwritePrompt = false,
        };
        if (destination.ShowDialog(this) != DialogResult.OK) return new Response();
        if (!Path.GetExtension(destination.FileName).Equals(".md", StringComparison.OrdinalIgnoreCase))
            return new Response(Error: "请选择 .md 格式保存。");
        if (ImportDestinationExists(destination.FileName))
            return new Response(Error: "同名笔记或图片目录已存在，请换一个文件名后再导入。");

        string? error = await convert(sources[0], destination.FileName);
        if (error is not null) return new Response(Error: error);
        if (IsDisposed) return new Response();
        return await ReadDocument(destination.FileName);
    }

    private async Task<(string? First, int Count, List<string> Failures)> ConvertImportBatch(
        string[] sources, string folder, Func<string, string, Task<string?>> convert, bool shortFirstSuffix)
    {
        string? first = null;
        int count = 0;
        var failures = new List<string>();
        foreach (string source in sources)
        {
            if (IsDisposed) break;
            string output = FindImportDestination(folder, source, shortFirstSuffix);
            string? error;
            try { error = await convert(source, output); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException)
            {
                error = exception.Message;
            }
            if (error is not null)
            {
                failures.Add(Path.GetFileName(source) + "：" + (error.Length <= 180 ? error : error[..180] + "…"));
                continue;
            }
            first ??= output;
            count++;
        }
        return (first, count, failures);
    }

    private static string FindImportDestination(string folder, string source, bool shortFirstSuffix)
    {
        string stem = Path.GetFileNameWithoutExtension(source);
        string suggested = Path.Combine(folder, stem + ".md");
        for (int suffix = 1; ImportDestinationExists(suggested); suffix++)
        {
            string copy = shortFirstSuffix && suffix == 1 ? "（导入）" : $"（导入 {suffix}）";
            suggested = Path.Combine(folder, stem + copy + ".md");
        }
        return suggested;
    }

    private string GetImportOutputFolder(string sourcePath) =>
        notesRoot is { } root && Directory.Exists(root)
            ? Directory.CreateDirectory(Path.Combine(root, "导入暂存")).FullName
            : Path.GetDirectoryName(sourcePath)!;

    private static bool ImportDestinationExists(string path) =>
        Path.Exists(path) || NoteAttachmentPaths(path, path).Any(item => Path.Exists(item.Source));

    private static async Task<(string? Output, string? Error)> RunPdfTool(string[] arguments)
    {
        var converter = Path.Combine(AppContext.BaseDirectory, "pdf-import.py");
        if (!File.Exists(converter)) return (null, $"找不到 PDF 组件，请重新构建{AppName}。");

        foreach (string command in new[] { "py", "python" })
        {
            var info = new ProcessStartInfo(command)
            {
                WorkingDirectory = AppContext.BaseDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Utf8,
                StandardErrorEncoding = Utf8,
            };
            if (command == "py") info.ArgumentList.Add("-3");
            foreach (string arg in new[] { "-X", "utf8", converter }.Concat(arguments))
                info.ArgumentList.Add(arg);

            Process? process;
            try { process = Process.Start(info); }
            catch (Win32Exception) { continue; }
            if (process is null) continue;

            using (process)
            {
                var output = process.StandardOutput.ReadToEndAsync();
                var errors = process.StandardError.ReadToEndAsync();
                await process.WaitForExitAsync();
                string result = await output;
                string error = (await errors).Trim();

                if (process.ExitCode == 0) return (result, null);
                if (process.ExitCode == 1 && error.Length > 0) return (null, error);
            }
        }
        return (null, "PDF 导入和原页预览需要 Python 和 PyMuPDF。请在终端运行 python -m pip install pymupdf 后重试。");
    }

    private sealed record PdfPage(int Count, string Image, string Text);

    private async Task<Response> ShowPdfPage(string path, string address, int firstPage)
    {
        using var dialog = new Form
        {
            Text = Path.GetFileName(path),
            StartPosition = FormStartPosition.CenterParent,
            ClientSize = new Size(960, 700),
            MinimumSize = new Size(550, 350),
            ShowInTaskbar = false,
            KeyPreview = true,
        };
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 2, Padding = new Padding(8) };
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink };
        var previous = new Button { Text = "上一页", AutoSize = true };
        var next = new Button { Text = "下一页", AutoSize = true };
        var insert = new Button { Text = "插入所选文字和出处", AutoSize = true };
        var original = new Button { Text = "用系统阅读器打开", AutoSize = true };
        var status = new Label { AutoSize = true, Padding = new Padding(4, 8, 0, 0), AccessibleName = "PDF 页码和状态" };
        buttons.Controls.AddRange([previous, next, insert, original, status]);
        var split = new SplitContainer { Dock = DockStyle.Fill, Size = new Size(900, 600), SplitterDistance = 500 };
        var picture = new PictureBox { Dock = DockStyle.Fill, SizeMode = PictureBoxSizeMode.Zoom, AccessibleName = "PDF 原页" };
        // A selectable text pane also works when the image is scaled to fit the window.
        var text = new TextBox
        {
            Dock = DockStyle.Fill, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical,
            AccessibleName = "PDF 页内文字，可选择后插入笔记",
        };
        split.Panel1.Controls.Add(picture);
        split.Panel2.Controls.Add(text);
        layout.Controls.Add(buttons, 0, 0);
        layout.Controls.Add(split, 0, 1);
        dialog.Controls.Add(layout);
        ApplyDialogTheme(dialog);

        int page = firstPage;
        int total = 0;
        string? excerpt = null;
        bool loading = false;
        previous.Click += async (_, _) => await LoadPage(page - 1);
        next.Click += async (_, _) => await LoadPage(page + 1);
        text.GotFocus += (_, _) => insert.Enabled = !loading && text.TextLength > 0;
        insert.Click += (_, _) =>
        {
            string selected = text.SelectedText.Trim();
            if (selected.Length == 0)
            {
                status.Text = "请先选择右侧的文字。";
                text.Focus();
                return;
            }
            string quote = string.Join("\n", selected.ReplaceLineEndings("\n").Split('\n').Select(line =>
                "> " + Regex.Replace(line.Trim(), @"[^\w\s]|_", match =>
                    char.IsAscii(match.Value[0]) ? "\\" + match.Value : match.Value)));
            excerpt = $"{quote}\n>\n> [原 PDF 第 {page} 页](<{address}#page={page}>)";
            dialog.Close();
        };
        original.Click += (_, _) =>
        {
            var response = OpenPdfFile(path);
            if (response.Error is { } error) status.Text = error;
        };
        dialog.KeyDown += (_, args) =>
        {
            if (args.KeyCode == Keys.Escape) dialog.Close();
        };
        dialog.Shown += async (_, _) => await LoadPage(firstPage);
        try { dialog.ShowDialog(this); }
        finally
        {
            picture.Image?.Dispose();
            picture.Image = null;
        }
        return new Response(OpenedPdf: Path.GetFileName(path), PdfExcerpt: excerpt);

        async Task LoadPage(int target)
        {
            if (loading) return;
            loading = true;
            previous.Enabled = next.Enabled = insert.Enabled = false;
            status.Text = $"正在读取第 {target} 页…";
            try
            {
                var (data, error) = await RunPdfTool(["--page", path, target.ToString(CultureInfo.InvariantCulture)]);
                if (dialog.IsDisposed || !dialog.Visible) return;
                if (error is not null)
                {
                    status.Text = error;
                    return;
                }
                var result = JsonSerializer.Deserialize<PdfPage>(data!, Json) ?? throw new JsonException();
                using var stream = new MemoryStream(Convert.FromBase64String(result.Image));
                using var image = Image.FromStream(stream);
                var old = picture.Image;
                picture.Image = new Bitmap(image);
                old?.Dispose();
                page = target;
                total = result.Count;
                text.Text = result.Text.ReplaceLineEndings(Environment.NewLine);
                status.Text = $"第 {page} / {total} 页" + (string.IsNullOrWhiteSpace(text.Text) ? " · 无可选文字" : "");
            }
            catch (Exception error) when (error is JsonException or FormatException or IOException or ArgumentException)
            {
                if (dialog.Visible) status.Text = "无法显示 PDF 原页，可用系统阅读器打开。";
            }
            finally
            {
                loading = false;
                if (dialog.Visible)
                {
                    previous.Enabled = total > 0 && page > 1;
                    next.Enabled = page < total;
                    insert.Enabled = !string.IsNullOrWhiteSpace(text.Text);
                }
            }
        }
    }
}
