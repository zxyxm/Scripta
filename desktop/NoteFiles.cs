using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;

namespace Moye;

internal sealed partial class EditorWindow
{
    private async Task<Response> OpenLinkedNote(Request request)
    {
        if (documentPath is not { } document || request.Token is null || request.Token != documentToken)
            return new Response(Error: "请先打开或保存这篇笔记。");

        string folder = Path.GetDirectoryName(document)!;
        string relative = Uri.UnescapeDataString(request.NotePath!);
        if (relative.Contains(':') || Path.IsPathRooted(relative) || !IsNoteFile(Path.GetFileName(relative)))
            return new Response(Error: "笔记链接需要使用 Markdown 文件的相对路径。");
        string path = Path.GetFullPath(relative, folder);
        string boundary = notesRoot is { } root && IsInsideFolder(root, document) ? root : folder;
        if (!IsInsideFolder(boundary, path))
            return new Response(Error: "链接指向当前笔记目录之外。");
        if (!File.Exists(path)) return new Response(Error: "找不到链接的笔记。");
        for (string? entry = path; entry is not null && IsInsideFolder(boundary, entry); entry = Path.GetDirectoryName(entry))
        {
            if (!Path.Exists(entry) || File.GetAttributes(entry).HasFlag(FileAttributes.ReparsePoint))
                return new Response(Error: "找不到链接的笔记。");
        }
        return (await ReadDocument(path)) with
        {
            NotePath = notesRoot is { } repository && IsInsideFolder(repository, path) ? Path.GetRelativePath(repository, path) : null,
        };
    }

    private const string ImageRoute = "/note-image/";
    private const string ImageHost = "moye-images.invalid";

    private static string? ImageMediaType(string path) => Path.GetExtension(path).ToLowerInvariant() switch
    {
        ".png" or ".apng" => "image/png",
        ".jpg" or ".jpeg" or ".jfif" => "image/jpeg",
        ".gif" => "image/gif",
        ".webp" => "image/webp",
        ".svg" => "image/svg+xml",
        ".bmp" => "image/bmp",
        ".ico" => "image/x-icon",
        ".avif" => "image/avif",
        _ => null,
    };

    private Response ReadEditorClipboard(Request request)
    {
        try
        {
            var data = Clipboard.GetDataObject();
            if (data is null) return new Response();
            string? text = data.GetData(DataFormats.UnicodeText) as string ?? data.GetData(DataFormats.Text) as string;
            if (request.PlainText) return new Response(Contents: text);

            string[] images = (data.GetData(DataFormats.FileDrop, autoConvert: false) as string[] ?? [])
                .Where(path => Path.IsPathFullyQualified(path) && ImageMediaType(path) is not null && File.Exists(path))
                .ToArray();
            using var bitmap = images.Length == 0 ? data.GetData(DataFormats.Bitmap) as Image : null;
            if (images.Length == 0 && bitmap is null)
                return new Response(Contents: text, ClipboardHtml: data.GetData(DataFormats.Html, false) as string);

            if (documentPath is not { } note || request.Token != documentToken)
                return new Response(NeedsImageDestination: true);
            return new Response(PastedImages: WriteClipboardImages(note, images, bitmap));
        }
        catch (ExternalException)
        {
            return new Response(Error: "无法读取或保存剪贴板图片，请重试。");
        }
    }

    private static List<string> WriteClipboardImages(string note, string[] images, Image? bitmap)
    {
        string assets = Path.GetFileNameWithoutExtension(note) + ".assets";
        string folder = Path.Combine(Path.GetDirectoryName(note)!, assets);
        Directory.CreateDirectory(folder);
        if (File.GetAttributes(folder).HasFlag(FileAttributes.ReparsePoint))
            throw new IOException("无法向链接图床写入图片。");

        var written = new List<string>();
        try
        {
            foreach (string? source in bitmap is null ? images : new string?[] { null })
            {
                string id = Guid.NewGuid().ToString("N");
                string name = "paste-" + id + (source is null ? ".png" : Path.GetExtension(source).ToLowerInvariant());
                string temporary = Path.Combine(folder, ".moye-" + id + ".tmp");
                try
                {
                    using (var output = File.Open(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        if (source is null)
                            bitmap!.Save(output, ImageFormat.Png);
                        else
                        {
                            using var input = File.OpenRead(source);
                            input.CopyTo(output);
                        }
                    }
                    File.Move(temporary, Path.Combine(folder, name));
                    written.Add(name);
                }
                finally
                {
                    DeleteTemporaryFile(temporary);
                }
            }
        }
        catch
        {
            foreach (string name in written) DeleteTemporaryFile(Path.Combine(folder, name));
            throw;
        }
        return written.Select(name => assets + "/" + name).ToList();
    }

    private Response RevealNoteImage(Request request)
    {
        if (documentPath is not { } note || request.Token != documentToken)
            return new Response(Error: "请先打开或保存笔记");

        string relative = Uri.UnescapeDataString(request.NotePath!.Split('?', '#')[0]);
        if (!Uri.TryCreate(request.NotePath, UriKind.Relative, out _) ||
            Path.IsPathRooted(relative) || relative.Contains(':'))
            return new Response(Error: "图片没有可打开的本地位置");

        string folder = Path.GetDirectoryName(note)!;
        string path = Path.GetFullPath(relative, folder);
        string boundary = notesRoot is { } root && IsInsideFolder(root, note) ? root : folder;
        if (!IsInsideFolder(boundary, path) || ImageMediaType(path) is null)
            return new Response(Error: "图片路径超出笔记目录或格式不受支持");
        if (!File.Exists(path)) return new Response(Error: "找不到图片文件");
        for (string? item = path; item is not null && !SamePath(item, boundary); item = Path.GetDirectoryName(item))
        {
            if (File.GetAttributes(item).HasFlag(FileAttributes.ReparsePoint))
                return new Response(Error: "无法打开图片的链接位置");
        }
        return OpenInExplorer(path, select: true);
    }

    private Response ImportReplacementImage(Request request)
    {
        if (documentPath is not { } note || request.Token != documentToken)
            return new Response(Error: "请先打开或保存笔记");

        using var dialog = new OpenFileDialog
        {
            Filter = "图片文件|*.png;*.apng;*.jpg;*.jpeg;*.jfif;*.gif;*.webp;*.svg;*.bmp;*.ico;*.avif",
            Title = "选择替换图片",
            CheckFileExists = true,
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return new Response();
        if (ImageMediaType(dialog.FileName) is null) return new Response(Error: "请选择受支持的图片格式");

        string assets = Path.GetFileNameWithoutExtension(note) + ".assets";
        string folder = Path.Combine(Path.GetDirectoryName(note)!, assets);
        Directory.CreateDirectory(folder);
        if (File.GetAttributes(folder).HasFlag(FileAttributes.ReparsePoint))
            return new Response(Error: "无法向链接图床写入图片");

        string name = Path.GetFileName(dialog.FileName);
        string destination = Path.Combine(folder, name);
        if (SamePath(dialog.FileName, destination)) return new Response(NotePath: assets + "/" + name);
        for (int suffix = 2; Path.Exists(destination); suffix++)
        {
            name = $"{Path.GetFileNameWithoutExtension(dialog.FileName)}-{suffix}{Path.GetExtension(dialog.FileName)}";
            destination = Path.Combine(folder, name);
        }

        string temporary = Path.Combine(folder, ".moye-" + Guid.NewGuid().ToString("N"));
        try
        {
            File.Copy(dialog.FileName, temporary);
            File.Move(temporary, destination);
        }
        finally
        {
            DeleteTemporaryFile(temporary);
        }
        return new Response(NotePath: assets + "/" + name);
    }

    private Response OpenDocumentFolder(Request request, bool references)
    {
        if (documentPath is not { } note || request.Token != documentToken || !File.Exists(note))
            return new Response(Error: "请先打开或保存笔记。");

        string folder = Path.ChangeExtension(note, references ? ReferenceSuffix : ".assets");
        if (Path.Exists(folder) && (!Directory.Exists(folder) || File.GetAttributes(folder).HasFlag(FileAttributes.ReparsePoint)))
            return new Response(Error: "对应路径已被文件或链接占用。");
        bool created = !Directory.Exists(folder);
        Directory.CreateDirectory(folder);
        return OpenInExplorer(folder) with { NotePath = created ? Path.GetFileName(folder) : null };
    }

    private Response RenameDocument(Request request)
    {
        if (documentPath is not { } original || request.Token != documentToken)
            return new Response(Error: "请先打开或保存笔记");

        string? name = request.Name;
        string extension = Path.GetExtension(original);
        if (string.IsNullOrWhiteSpace(name) || name != name.Trim() ||
            Path.GetExtension(name) != extension || name.Length <= extension.Length ||
            name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || name.EndsWith('.') ||
            IsDeviceName(name))
            return new Response(Error: "请输入有效的笔记名称");

        string folder = Path.GetDirectoryName(original)!;
        if (folder.Equals(notesRoot, StringComparison.OrdinalIgnoreCase) && !IsRootNote(name))
            return new Response(Error: "该名称保留给仓库说明。");
        string destination = Path.Combine(folder, name);
        if (destination == original) return new Response();
        var attachments = NoteAttachmentPaths(original, destination);
        if (IsOccupied(destination, original) || attachments.Any(item => IsOccupied(item.Target, item.Source)))
            return new Response(Error: "新名称对应的笔记、图床或资料文件夹已存在");
        if (Utf8.GetString(File.ReadAllBytes(original)) != diskContents)
            return new Response(Error: "磁盘上的笔记已被修改，请重新打开后再重命名");

        RenameNoteFiles(original, destination, attachments, request.Contents!);
        return BindDocument(destination, request.Contents!);
    }

    private static bool IsDeviceName(string name)
    {
        string stem = name.Split('.')[0].TrimEnd().ToUpperInvariant();
        return stem is "CON" or "PRN" or "AUX" or "NUL" or "CONIN$" or "CONOUT$" ||
            (stem.Length == 4 && stem[..3] is ("COM" or "LPT") && "123456789¹²³".Contains(stem[3]));
    }

    private static bool IsOccupied(string path, string original) =>
        !path.Equals(original, StringComparison.OrdinalIgnoreCase) && Path.Exists(path);

    private static void RenameNoteFiles(string original, string destination, (string Source, string Target)[] attachments, string contents)
    {
        string temporary = Path.Combine(Path.GetDirectoryName(original)!, ".moye-" + Guid.NewGuid().ToString("N"));
        string backup = temporary + ".bak";
        var moved = new List<(string Source, string Target)>();
        bool originalMoved = false;
        try
        {
            File.WriteAllBytes(temporary, Utf8.GetBytes(contents));
            File.Move(original, backup);
            originalMoved = true;
            foreach (var (source, target) in attachments)
            {
                if (!Directory.Exists(source)) continue;
                string staging = temporary + Path.GetExtension(source);
                Directory.Move(source, staging);
                moved.Add((source, staging));
                Directory.Move(staging, target);
                moved[^1] = (source, target);
            }
            File.Move(temporary, destination);
        }
        catch
        {
            try
            {
                foreach (var (source, target) in moved.AsEnumerable().Reverse())
                {
                    string from = target;
                    if (SamePath(source, target))
                    {
                        from = temporary + Path.GetExtension(source);
                        Directory.Move(target, from);
                    }
                    Directory.Move(from, source);
                }
            }
            finally
            {
                if (originalMoved) File.Move(backup, original);
                DeleteTemporaryFile(temporary);
            }
            throw;
        }
        DeleteTemporaryFile(backup);
    }

    private static void DeleteTemporaryFile(string path)
    {
        try { File.Delete(path); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }

    private void LoadNoteImage(object? sender, CoreWebView2WebResourceRequestedEventArgs args)
    {
        Stream? stream = null;
        string? mediaType = null;
        if (documentPath is { } note && documentToken is { } token &&
            args.ResourceContext == CoreWebView2WebResourceContext.Image && args.Request.Method == "GET" &&
            Uri.TryCreate(args.Request.Uri, UriKind.Absolute, out var uri))
        {
            string prefix = ImageRoute + token + "/";
            if (uri.AbsolutePath.StartsWith(prefix, StringComparison.Ordinal))
            {
                try
                {
                    var parts = uri.AbsolutePath[prefix.Length..].Split('/').Select(Uri.UnescapeDataString).ToArray();
                    string assets = Path.GetFileNameWithoutExtension(note) + ".assets";
                    if (parts.Length >= 2 && parts[0].Equals(assets, StringComparison.OrdinalIgnoreCase) &&
                        parts.All(part => part.Length > 0 && !part.EndsWith('.') && !part.EndsWith(' ') &&
                            part.IndexOfAny(Path.GetInvalidFileNameChars()) < 0 && !IsDeviceName(part)))
                    {
                        mediaType = ImageMediaType(parts[^1]);
                        if (mediaType is not null)
                        {
                            string path = Path.GetDirectoryName(note)!;
                            foreach (string part in parts)
                            {
                                path = Path.Combine(path, part);
                                if (File.GetAttributes(path).HasFlag(FileAttributes.ReparsePoint))
                                {
                                    NotFound();
                                    return;
                                }
                            }
                            // WebView2 can retain the response stream after the image is painted.
                            stream = new MemoryStream(File.ReadAllBytes(path), writable: false);
                        }
                    }
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException) { }
            }
        }
        if (stream is null) NotFound();
        else args.Response = view.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK",
            $"Content-Type: {mediaType}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'");

        void NotFound() => args.Response = view.CoreWebView2.Environment.CreateWebResourceResponse(null, 404, "Not Found", "");
    }
}
