using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Moye;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        AppLog.Write("application", "started");
        Application.Run(new EditorWindow());
        AppLog.Write("application", "closed");
    }
}

internal sealed partial class EditorWindow : Form
{
    private const string AppName = "Scripta 思刻";
    private const string AppHost = "moye.local";
    private const string AppPage = "https://" + AppHost + "/index.html";
    private const string FileFilter = "Markdown 文档 (*.md;*.markdown)|*.md;*.markdown|纯文本 (*.txt)|*.txt|所有文件 (*.*)|*.*";
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly WebView2 view = new() { Dock = DockStyle.Fill };
    private string? documentPath;
    private string? diskContents;
    private Guid? documentToken;
    private bool busy;

    public EditorWindow()
    {
        Text = AppName;
        Icon = new Icon(typeof(EditorWindow), "AppIcon.ico");
        MinimumSize = MinimumWindowSize;
        StartPosition = FormStartPosition.Manual;
        Controls.Add(view);
        Controls.Add(CreateTitleBar());

        ApplyStartupWindow(Screen.FromPoint(Cursor.Position).WorkingArea);
        Shown += InitializeEditor;
    }

    private async void InitializeEditor(object? sender, EventArgs args)
    {
        try
        {
            var profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Moye", "WebView");
            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: profile);
            if (IsDisposed) return;
            await view.EnsureCoreWebView2Async(environment);
            if (IsDisposed) return;
            var web = view.CoreWebView2;
            web.Settings.AreHostObjectsAllowed = false;
            web.Settings.AreDefaultContextMenusEnabled = false;
            web.Settings.AreDevToolsEnabled = false;
            web.Settings.AreBrowserAcceleratorKeysEnabled = false;
            web.Settings.AreDefaultScriptDialogsEnabled = false;
            web.ScriptDialogOpening += OpenScriptDialog;
            web.SetVirtualHostNameToFolderMapping(AppHost, Path.Combine(AppContext.BaseDirectory, "app"), CoreWebView2HostResourceAccessKind.Deny);
            web.NavigationStarting += (_, navigation) =>
            {
                if (navigation.Uri == AppPage || navigation.Uri.StartsWith(AppPage + "#", StringComparison.Ordinal)) return;
                navigation.Cancel = true;
                if (navigation.IsUserInitiated) OpenExternalLink(navigation.Uri);
            };
            web.NewWindowRequested += (_, window) =>
            {
                window.Handled = true;
                if (window.IsUserInitiated) OpenExternalLink(window.Uri);
            };
            web.FrameNavigationStarting += (_, navigation) => navigation.Cancel = true;
            web.DocumentTitleChanged += (_, _) =>
            {
                Text = web.DocumentTitle;
            };
            web.AddWebResourceRequestedFilter("https://" + ImageHost + ImageRoute + "*",
                CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.Document);
            web.WebResourceRequested += LoadNoteImage;
            web.WebMessageReceived += OnWebMessage;
            web.ProcessFailed += (_, failure) => AppLog.Write("webview", failure.ProcessFailedKind.ToString());
            await web.AddScriptToExecuteOnDocumentCreatedAsync(
                $"window.scriptaDisplaySettings = {JsonSerializer.Serialize(displaySettings, Json)};");
            await LoadNotesRoot();
            if (IsDisposed) return;
            web.Navigate(AppPage);
        }
        catch (WebView2RuntimeNotFoundException error)
        {
            AppLog.Write("initialize-editor", "failed", error: error);
            ShowNotice(AppName, $"启动{AppName}需要 Microsoft Edge WebView2 Runtime。");
            Close();
        }
        catch (Exception error)
        {
            AppLog.Write("initialize-editor", "failed", error: error);
            if (IsDisposed) return;
            ShowNotice(AppName, $"无法启动{AppName}。\n{error.Message}");
            Close();
        }
    }

    private void OpenExternalLink(string address)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https") ||
            uri.Host.Equals(AppHost, StringComparison.OrdinalIgnoreCase) ||
            uri.Host.Equals(ImageHost, StringComparison.OrdinalIgnoreCase)) return;

        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (System.ComponentModel.Win32Exception)
        {
            ShowNotice(AppName, "无法打开系统浏览器。");
        }
    }

    private async void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs message)
    {
        if (message.Source != AppPage && !message.Source.StartsWith(AppPage + "#", StringComparison.Ordinal)) return;
        Request? request;
        try
        {
            request = JsonSerializer.Deserialize<Request>(message.WebMessageAsJson, Json);
        }
        catch (JsonException)
        {
            return;
        }
        if (request is null) return;
        if (request.Action == "theme" && request.Dark is bool dark)
        {
            ApplyTitleBarTheme(dark);
            return;
        }

        if (request.Action == "cancel-pull")
        {
            CancelPull();
            return;
        }
        if (request.Action is "editor-undo" or "editor-redo" or "editor-delete-section")
        {
            AppLog.Write(request.Action, "completed");
            return;
        }
        if (busy) return;

        busy = true;
        long started = Stopwatch.GetTimestamp();
        Exception? failure = null;
        Response response;
        try
        {
            response = request.Action switch
            {
                "open" => await OpenDocument(),
                "save-display-settings" => SaveDisplaySettings(request.DisplaySettings),
                "open-linked-pdf" when request.NotePath is not null => await OpenLinkedPdf(request),
                "open-linked-note" when request.NotePath is not null => await OpenLinkedNote(request),
                "reveal-image" when request.NotePath is not null => RevealNoteImage(request),
                "open-note-assets" or "open-note-references" => OpenDocumentFolder(request, request.Action == "open-note-references"),
                "replace-image" => ImportReplacementImage(request),
                "prepare-merge" => await PrepareMarkdownMerge(request.NotePaths),
                "merge" when request.Contents is not null => await WriteMarkdownMerge(request.Contents),
                "copy-editor-text" when !string.IsNullOrEmpty(request.Contents) => CopyEditorText(request.Contents),
                "paste-editor" => ReadEditorClipboard(request),
                "import-pdf" or "import-pdf-with-source" => await ImportPdf(request.Action == "import-pdf-with-source"),
                "import-wps-docx" => await ImportWpsDocx(),
                "search-notes" when request.Query is { Length: <= 160 } => await SearchNotes(request.Query),
                "list-notes" => await ListNotes(),
                "create-note-entry" when request.NotePath is not null && request.Name is not null =>
                    await CreateRepositoryEntry(request.NotePath, request.Name, request.Folder),
                "create-section-note" when request.NotePath is not null && request.Name is not null =>
                    await CreateRepositoryEntry(request.NotePath, request.Name, folder: false, openNote: false),
                "choose-notes" => await ChooseNotesFolder(),
                "unbind-notes" => UnbindNotesFolder(),
                "open-notes-root" => OpenNotesRoot(),
                "repository-local" => new Response(Sync: ReadLocalRepository()),
                "repository-sync" => await ReadRepositorySync(),
                "setup-git" => await SetUpGit(),
                "clone-github" when request.Query is { Length: <= 300 } => await BindOrCloneGitHubRepository(request.Query, clone: true),
                "pull-github" => await RunRepositoryPull((report, cancellation) => SyncGitHubRepository(false, report, cancellation)),
                "choose-partial-folder" => await ChoosePartialFolder(),
                "pull-github-partial" when request.Query is { Length: <= 300 } && request.NotePath is { Length: <= 1000 } =>
                    await RunRepositoryPull((report, cancellation) => PullPartialRepository(request.Query, request.NotePath, report, cancellation)),
                "push-github" => await SyncGitHubRepository(push: true),
                "bind-github" when request.Query is { Length: <= 300 } => await BindOrCloneGitHubRepository(request.Query, clone: false),
                "open-github-desktop" => await OpenInGitHubDesktop(),
                "refresh-synced-note" => await RefreshSyncedNote(request),
                "open-note" when request.NotePath is not null => await OpenRepositoryNote(request.NotePath),
                "delete-note" when request.NotePath is not null => DeleteRepositoryNote(request.NotePath),
                "recycle-notes" when request.NotePaths is { Count: > 0 } => RecycleRepositoryNotes(request.NotePaths),
                "recycle-merge-originals" when request.NotePath is not null && request.MergeOriginals is { Count: > 0 } =>
                    RecycleMergedOriginals(request.NotePath, request.MergeOriginals),
                "delete-note-permanently" when request.NotePath is not null =>
                    DeleteRepositoryNote(request.NotePath, request.Folder, permanent: true),
                "reveal-resource" when request.NotePath is not null => RevealRepositoryResource(request.NotePath),
                "import-resources" when request.DestinationPath is not null =>
                    await ImportResourceFiles(request.DestinationPath, message.AdditionalObjects),
                "reveal-note" or "copy-note-path" or "copy-relative-note-path" when request.NotePath is not null =>
                    UseRepositoryEntry(request.NotePath, request.Folder, request.Action),
                "open-note-folder" when request.NotePath is not null =>
                    UseRepositoryEntry(request.NotePath, isFolder: true, request.Action),
                "restore-note" when request.Name is not null && request.Contents is not null =>
                    await RestoreNote(request.Name, request.Contents, request.Dirty),
                "prepare-commit" => await PrepareNoteCommit(),
                "commit-notes" => await CommitNotes(request.CommitMessage),
                "save" when request.Contents is not null => await SaveDocument(request),
                "export-markdown" when request.Contents is not null => await SaveDocument(request, exportCopy: true),
                "rename" when request.Contents is not null => RenameDocument(request),
                "rename-folder" when request.NotePath is not null => RenameRepositoryFolder(request.NotePath, request.Name),
                "choose-move-destination" when request.NotePath is not null =>
                    await ChooseMoveDestination(request.NotePath, request.Folder),
                "choose-note-destination" => ChooseRepositoryDestination(),
                "choose-section-destination" when request.NotePath is not null =>
                    await ChooseSectionDestination(request.Token, request.NotePath),
                "move-note-section" => await MoveNoteSection(request),
                "move-note" or "copy-note" when request.NotePath is not null && request.DestinationPath is not null =>
                    await TransferRepositoryEntry(request.NotePath, request.DestinationPath, request.Folder, request.Action == "copy-note"),
                _ => new Response(Error: "无法处理文件操作"),
            };
        }
        catch (DecoderFallbackException error)
        {
            failure = error;
            response = new Response(Error: "打开失败，请选择 UTF-8 编码的 Markdown 文件");
        }
        catch (NoteGitException error)
        {
            failure = error;
            response = new Response(Error: error.Message);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or ArgumentException)
        {
            failure = error;
            var action = request.Action switch
            {
                "open" or "open-note" or "restore-note" or "open-linked-pdf" or "open-linked-note" => "打开",
                "save-display-settings" => "保存显示设置",
                "prepare-merge" or "merge" => "合并笔记",
                "import-pdf" or "import-pdf-with-source" => "导入 PDF",
                "import-wps-docx" => "导入 WPS 智能文档",
                "search-notes" => "搜索笔记",
                "import-resources" => "添加资料",
                "export-markdown" => "导出 Markdown",
                "reveal-note" or "reveal-resource" or "open-note-folder" or "reveal-image" => "打开所在位置",
                "open-note-assets" or "open-note-references" => "打开笔记附件文件夹",
                "replace-image" => "替换图片",
                "paste-editor" => "粘贴",
                "open-notes-root" => "打开笔记仓库",
                "repository-sync" or "bind-github" => "设置 GitHub 仓库",
                "setup-git" => "安装 Git",
                "pull-github" or "pull-github-partial" or "clone-github" => "拉取",
                "push-github" => "推送",
                "open-github-desktop" => "打开 GitHub Desktop",
                "refresh-synced-note" => "刷新笔记",
                "copy-note-path" or "copy-relative-note-path" => "复制路径",
                "list-notes" or "choose-notes" => "读取笔记仓库",
                "create-note-entry" or "create-section-note" => "新建",
                "prepare-commit" or "commit-notes" => "提交",
                "rename" or "rename-folder" => "重命名",
                "delete-note" or "delete-note-permanently" or "recycle-notes" or "recycle-merge-originals" => "删除项目",
                "move-note" or "choose-move-destination" or "choose-section-destination" or "move-note-section" => "移动",
                "copy-note" => "复制",
                _ => "保存",
            };
            response = new Response(Error: action + "失败，请检查文件权限和路径");
        }
        catch (Exception error)
        {
            AppLog.Write("editor-request", "unexpected-error", error: error);
            throw;
        }
        finally
        {
            busy = false;
        }
        if (AppLog.IsLoggedAction(request.Action))
            AppLog.Write(request.Action, response.Error is not null ? "failed" :
                response.PullInterrupted ? "cancelled" : "completed",
                (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds, failure);
        if (closeAfterPull)
        {
            closeAfterPull = false;
            Close();
        }
        else if (!IsDisposed) view.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(response, Json));
    }

    private async Task<Response> OpenDocument()
    {
        using var dialog = new OpenFileDialog
        {
            Filter = "笔记或 PDF (*.md;*.markdown;*.txt;*.pdf)|*.md;*.markdown;*.txt;*.pdf|" + FileFilter,
            Title = "打开笔记或 PDF",
            CheckFileExists = true,
        };
        if (dialog.ShowDialog(this) != DialogResult.OK) return new Response();
        if (Path.GetExtension(dialog.FileName).Equals(".pdf", StringComparison.OrdinalIgnoreCase))
            return OpenPdfFile(dialog.FileName);
        return await ReadDocument(dialog.FileName);
    }

    private static Response CopyEditorText(string text)
    {
        try { Clipboard.SetText(text); }
        catch (System.Runtime.InteropServices.ExternalException)
        {
            return new Response(Error: "无法写入剪贴板，请重试。");
        }
        return new Response();
    }

    private async Task<Response> ReadDocument(string path)
    {
        var contents = Utf8.GetString(await File.ReadAllBytesAsync(path));
        return BindDocument(path, contents, includeContents: true);
    }

    private Response BindDocument(string path, string contents, bool includeContents = false)
    {
        documentPath = path;
        diskContents = contents;
        documentToken = Guid.NewGuid();
        RememberNotePath(path);
        return new Response(Name: Path.GetFileName(path), Contents: includeContents ? contents : null, Token: documentToken);
    }

    private async Task<Response> SaveDocument(Request request, bool exportCopy = false)
    {
        var currentPath = request.Token == documentToken ? documentPath : null;
        var path = exportCopy ? null : currentPath;
        bool checkDisk = path is not null;
        bool overwrite = checkDisk;
        if (path is null)
        {
            using var dialog = new SaveFileDialog
            {
                Filter = exportCopy ? "Markdown 文档 (*.md)|*.md" : FileFilter,
                Title = exportCopy ? "导出 Markdown 源码" : "保存 Markdown 文档",
                FileName = exportCopy ? Path.GetFileNameWithoutExtension(request.Name ?? "未命名.md") + "（副本）.md" :
                    Path.GetFileName(request.Name ?? "未命名.md"),
                InitialDirectory = exportCopy && currentPath is not null ? Path.GetDirectoryName(currentPath) : "",
                DefaultExt = "md",
                AddExtension = true,
                OverwritePrompt = false,
            };
            if (dialog.ShowDialog(this) != DialogResult.OK) return new Response();
            path = dialog.FileName;
            if (exportCopy && currentPath is not null && path.Equals(currentPath, StringComparison.OrdinalIgnoreCase))
                return new Response(Error: "请选择不同的文件名或位置来导出副本。");
            if (File.Exists(path))
            {
                if (!ConfirmAction(dialog.Title, $"已存在「{Path.GetFileName(path)}」。要替换它吗？", "替换", destructive: true))
                    return new Response();
                overwrite = true;
            }
        }

        var temporary = Path.Combine(Path.GetDirectoryName(path)!, ".moye-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            await File.WriteAllBytesAsync(temporary, Utf8.GetBytes(request.Contents!));
            if (checkDisk)
            {
                var observed = await TryReadNoteText(path);
                if (observed is null)
                    return new Response(Error: "无法读取原文件，当前草稿已保留。");
                if (observed != diskContents && observed != request.Contents)
                {
                    if (!ConfirmAction(AppName,
                        $"「{Path.GetFileName(path)}」也在磁盘上被修改过。要用当前草稿覆盖原文件吗？",
                        "覆盖", destructive: true))
                        return new Response(Error: "已保留当前草稿，文档仍停留在原处。");
                    if (await TryReadNoteText(path) != observed)
                        return new Response(Error: "确认期间原文件再次更改，当前草稿已保留。");
                }
            }
            File.Move(temporary, path, overwrite);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }

        return exportCopy ? new Response(Name: Path.GetFileName(path)) : BindDocument(path, request.Contents!);
    }

    private sealed record Request(string Action, string? Name, string? Contents, Guid? Token, string? NotePath, string? CommitMessage,
        bool? Dark, bool AutoSave, bool Folder, bool Dirty, string? DestinationPath, bool PlainText, string? Query,
        DisplaySettings? DisplaySettings, SectionMoveInput? SectionMove, IReadOnlyList<string>? NotePaths,
        IReadOnlyList<MergedOriginal>? MergeOriginals);
    private sealed record Response(string? Name = null, string? Contents = null, Guid? Token = null, string? Error = null,
        string? Repository = null, IReadOnlyList<NoteEntry>? Notes = null, NoteCommit? Commit = null, string? CommitHash = null,
        string? NotePath = null, bool DiskChanged = false, string? OpenedPdf = null, IReadOnlyList<MergeInput>? MergeFiles = null,
        int? ImportedCount = null, int? SkippedCount = null, bool DeletedCurrent = false,
        long? RepositorySizeBytes = null, int? RepositoryFileCount = null, string? ClipboardHtml = null,
        IReadOnlyList<string>? PastedImages = null, bool NeedsImageDestination = false,
        IReadOnlyList<NoteHit>? SearchResults = null, bool SearchTruncated = false, string? PdfExcerpt = null,
        RepositorySync? Sync = null, string? SyncMessage = null, string? PartialFolder = null,
        SparseSelection? PartialSelection = null, bool PullInterrupted = false, SectionDestination? SectionDestination = null,
        IReadOnlyList<string>? RecycledNotes = null, string? BatchNotice = null, IReadOnlyList<MergedOriginal>? MergeOriginals = null);
}
