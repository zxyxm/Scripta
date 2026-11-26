using System.Runtime.InteropServices;

namespace Moye;

internal sealed partial class EditorWindow
{
    private const int CaptionHeight = 42;
    private readonly Panel titleBar = new() { Dock = DockStyle.Top, Height = CaptionHeight };
    private readonly PictureBox brandMark = new()
    {
        AccessibleName = AppName,
        Size = new Size(144, 38),
        Margin = new Padding(0, 2, 8, 0),
    };

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            // Keep the native sizing frame and system commands while replacing the caption.
            parameters.Style &= ~0x00C00000; // WS_CAPTION
            return parameters;
        }
    }

    private Panel CreateTitleBar()
    {
        var bar = titleBar;
        // Match the web interface's 14 CSS pixels at 96 DPI.
        const float menuFontSizeInPoints = 14f * 72f / 96f;
        var captionFont = new Font(bar.Font.FontFamily, menuFontSizeInPoints, bar.Font.Style, GraphicsUnit.Point);
        var systemMenuFont = SystemFonts.MenuFont ?? Control.DefaultFont;
        var dropDownFont = new Font(systemMenuFont.FontFamily, menuFontSizeInPoints, systemMenuFont.Style, GraphicsUnit.Point);
        bar.Disposed += (_, _) =>
        {
            captionFont.Dispose();
            dropDownFont.Dispose();
        };
        var brand = new FlowLayoutPanel
        {
            Dock = DockStyle.Left, AutoSize = true, WrapContents = false,
            Padding = new Padding(10, 0, 0, 0),
        };
        var menuButtons = new List<(TitleButton Button, int CompactWidth, int FullWidth)>();
        using var logoStream = typeof(EditorWindow).Assembly.GetManifestResourceStream("Moye.scripta-logo-carved-stone.png")!;
        using var logoSource = new Bitmap(logoStream);
        var logo = new Bitmap(logoSource);
        brandMark.Disposed += (_, _) => logo.Dispose();
        bool compact = false;
        brandMark.Paint += (_, args) =>
        {
            if (compact)
            {
                if (Icon is { } icon) args.Graphics.DrawIcon(icon, new Rectangle(2, 8, 22, 22));
                return;
            }
            int width = (int)Math.Round(brandMark.Height * (double)logo.Width / logo.Height);
            args.Graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            args.Graphics.DrawImage(logo, new Rectangle((brandMark.Width - width) / 2, 0, width, brandMark.Height));
        };
        brandMark.MouseDown += DragCaption;
        brand.Controls.Add(brandMark);

        AddMenu(brand, "文件", 40,
            ("新建", "Ctrl+N", () => RunEditorCommand("new")),
            ("打开", "Ctrl+O", () => RunEditorCommand("open")),
            MenuCommand("选择笔记仓库…", "", "choose-notes"),
            ("保存", "Ctrl+S", () => RunEditorCommand("save")),
            ("重命名笔记", "", () => RunEditorCommand("rename")));
        AddMenu(brand, "编辑", 40,
            MenuCommand("撤销", "Ctrl+Z", "undo"),
            MenuCommand("重做", "Ctrl+Y", "redo"),
            MenuCommand("剪切", "Ctrl+X", "cut"),
            MenuCommand("复制", "Ctrl+C", "copy"),
            MenuCommand("粘贴", "Ctrl+V", "paste"),
            MenuCommand("粘贴纯文本", "Ctrl+Shift+V", "paste-plain"),
            MenuCommand("粘贴为代码块", "Ctrl+Alt+V", "paste-code"),
            MenuCommand("全选", "Ctrl+A", "select-all"));
        AddMenu(brand, "段落", 40,
            MenuCommand("正文", "Ctrl+0", "format:h0"),
            MenuCommand("一级标题", "Ctrl+1", "format:h1"),
            MenuCommand("二级标题", "Ctrl+2", "format:h2"),
            MenuCommand("三级标题", "Ctrl+3", "format:h3"),
            MenuCommand("四级标题", "Ctrl+4", "format:h4"),
            MenuCommand("五级标题", "Ctrl+5", "format:h5"),
            MenuCommand("六级标题", "Ctrl+6", "format:h6"),
            MenuCommand("引用", "Ctrl+Shift+Q", "format:quote"),
            MenuCommand("有序列表", "Ctrl+Shift+[", "format:ordered"),
            MenuCommand("无序列表", "Ctrl+Shift+]", "format:unordered"),
            MenuCommand("任务列表", "", "format:task"),
            MenuCommand("代码块", "Ctrl+Shift+K", "format:fence"));
        AddMenu(brand, "格式", 40,
            MenuCommand("粗体", "Ctrl+B", "format:bold"),
            MenuCommand("斜体", "Ctrl+I", "format:italic"),
            MenuCommand("链接", "Ctrl+K", "format:link"),
            MenuCommand("行内代码", "Ctrl+Shift+`", "format:code"));
        AddMenu(brand, "视图", 40,
            MenuCommand("模式 1", "", "mode:write"),
            MenuCommand("模式 2", "", "mode:visual"),
            MenuCommand("切换源码", "Ctrl+/", "toggle-source"),
            MenuCommand("显示大纲", "Ctrl+Shift+1", "show-outline"),
            MenuCommand("切换侧栏", "Ctrl+Shift+L", "toggle-sidebar"),
            ("显示设置…", "", () => RunEditorCommand("display-settings")),
            ("切换深浅色", "", () => RunEditorCommand("theme")),
            ("打开软件日志…", "", () =>
            {
                try { AppLog.Open(); }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
                {
                    ShowNotice(AppName, "无法打开软件日志，请检查本机日志目录和记事本。");
                }
            }));

        var management = new FlowLayoutPanel { Dock = DockStyle.Right, AutoSize = true, WrapContents = false };
        AddFileButton(management, "笔记仓库", "notes", 72);
        AddFileButton(management, "提交", "commit", 44);
        AddSeparator(management);
        AddMenu(management, "导入", 48,
            ("导入 WPS 智能文档（DOCX）", "", () => RunEditorCommand("import-wps-docx")),
            ("导入 PDF", "", () => RunEditorCommand("import-pdf")),
            ("导入 PDF（带原页引用）", "", () => RunEditorCommand("import-pdf-with-source")),
            ("合并 Markdown 笔记", "", () => RunEditorCommand("merge-notes")));
        AddFileButton(management, "导出", "export-markdown", 48);
        AddSeparator(management);

        var controls = new FlowLayoutPanel { Dock = DockStyle.Right, AutoSize = true, WrapContents = false };
        var minimize = CaptionButton("—", 36, () => WindowState = FormWindowState.Minimized);
        minimize.AccessibleName = "最小化";
        var maximize = CaptionButton("□", 36, ToggleMaximize);
        maximize.AccessibleName = "最大化";
        var close = CaptionButton("×", 36, Close);
        close.AccessibleName = "关闭";
        controls.Controls.AddRange([minimize, maximize, close]);
        int fullWidth = brand.PreferredSize.Width + management.PreferredSize.Width + controls.PreferredSize.Width;
        void ArrangeTitleBar()
        {
            bool useCompactMark = ClientSize.Width < fullWidth + 24;
            if (compact != useCompactMark)
            {
                compact = useCompactMark;
                brandMark.Width = compact ? 26 : 144;
                brandMark.Invalidate();
                foreach (var (button, compactWidth, fullButtonWidth) in menuButtons)
                {
                    button.Width = compact ? compactWidth : fullButtonWidth;
                    button.Margin = new Padding(compact ? 2 : 4, 5, compact ? 2 : 4, 0);
                }
            }
            bool maximized = WindowState == FormWindowState.Maximized;
            maximize.Caption = maximized ? "❐" : "□";
            maximize.Invalidate();
            maximize.AccessibleName = maximized ? "还原" : "最大化";
        }
        Resize += (_, _) => ArrangeTitleBar();

        var dragArea = new Panel { Dock = DockStyle.Fill };
        dragArea.MouseDown += DragCaption;
        bar.MouseDown += DragCaption;
        management.MouseDown += DragCaption;
        brand.MouseDown += DragCaption;
        bar.Controls.Add(dragArea);
        bar.Controls.Add(management);
        bar.Controls.Add(controls);
        bar.Controls.Add(brand);
        ArrangeTitleBar();
        ApplyTitleBarTheme(dark: false);
        return bar;

        void AddFileButton(FlowLayoutPanel group, string text, string id, int width)
        {
            var button = MenuButton(text, width, () => RunEditorCommand(id));
            button.Name = id;
            group.Controls.Add(button);
        }

        void AddMenu(FlowLayoutPanel group, string text, int width,
            params (string Label, string Shortcut, Action Run)[] items)
        {
            var menu = new ContextMenuStrip { ShowImageMargin = false, Font = dropDownFont };
            menu.Opening += (_, _) =>
            {
                var colors = DialogColors.For(darkTheme);
                menu.Renderer = new ToolStripProfessionalRenderer(new MenuColors(colors)) { RoundedEdges = false };
                menu.ForeColor = colors.Ink;
            };
            foreach (var (label, shortcut, run) in items)
                menu.Items.Add(new ToolStripMenuItem(label, null, (_, _) => run()) { ShortcutKeyDisplayString = shortcut });
            var button = MenuButton(text, width);
            button.Click += (_, _) => menu.Show(button, new Point(0, button.Height));
            button.Disposed += (_, _) => menu.Dispose();
            group.Controls.Add(button);
        }

        TitleButton MenuButton(string text, int minimumWidth, Action? action = null)
        {
            int textWidth = TextRenderer.MeasureText(text, captionFont, Size.Empty,
                TextFormatFlags.SingleLine | TextFormatFlags.NoPadding).Width;
            int fullButtonWidth = Math.Max(minimumWidth + 6, textWidth + 18);
            int compactWidth = Math.Max(minimumWidth - 6, textWidth + 10);
            var button = CaptionButton(text, fullButtonWidth, action);
            button.Height = 32;
            button.Margin = new Padding(4, 5, 4, 0);
            button.FlatAppearance.BorderSize = 1;
            button.Font = captionFont;
            menuButtons.Add((button, compactWidth, fullButtonWidth));
            return button;
        }

        (string Label, string Shortcut, Action Run) MenuCommand(string label, string shortcut, string action) =>
            (label, shortcut, () => RunMenuCommand(action));

        void RunEditorCommand(string id)
        {
            var web = view.CoreWebView2;
            if (web is not null &&
                (web.Source == AppPage || web.Source.StartsWith(AppPage + "#", StringComparison.Ordinal)))
            {
                view.Focus();
                _ = web.ExecuteScriptAsync($"document.getElementById('{id}')?.click()");
            }
        }

        void RunMenuCommand(string action)
        {
            var web = view.CoreWebView2;
            if (web is null || (web.Source != AppPage && !web.Source.StartsWith(AppPage + "#", StringComparison.Ordinal))) return;
            view.Focus();
            string detail = System.Text.Json.JsonSerializer.Serialize(new { action }, Json);
            _ = web.ExecuteScriptAsync($"document.dispatchEvent(new CustomEvent('scripta-menu', {{ detail: {detail} }}))");
        }

        static void AddSeparator(FlowLayoutPanel group) => group.Controls.Add(new Panel
        {
            Size = new Size(1, 22), Margin = new Padding(5, 10, 5, 0),
        });
    }

    private void ApplyTitleBarTheme(bool dark)
    {
        darkTheme = dark;
        var background = dark ? Color.FromArgb(24, 27, 32) : Color.FromArgb(246, 247, 248);
        var foreground = dark ? Color.FromArgb(229, 232, 238) : Color.FromArgb(34, 38, 44);
        var hover = dark ? Color.FromArgb(44, 52, 64) : Color.FromArgb(234, 238, 243);
        var divider = dark ? Color.FromArgb(82, 93, 109) : Color.FromArgb(193, 202, 214);
        var buttonFace = dark ? Color.FromArgb(35, 41, 50) : Color.White;
        var accent = dark ? Color.FromArgb(169, 203, 249) : Color.FromArgb(41, 86, 145);
        titleBar.BackColor = background;
        brandMark.BackColor = dark ? Color.FromArgb(241, 241, 249) : background;

        foreach (var panel in titleBar.Controls.OfType<FlowLayoutPanel>())
        {
            foreach (var separator in panel.Controls.OfType<Panel>()) separator.BackColor = divider;
            foreach (var button in panel.Controls.OfType<TitleButton>())
            {
                bool bordered = button.FlatAppearance.BorderSize > 0;
                button.BackColor = bordered ? buttonFace : background;
                if (bordered) button.FlatAppearance.BorderColor = divider;
                button.ForeColor = button.Name == "save" ? accent : foreground;
                button.FlatAppearance.MouseOverBackColor = button.Caption == "×"
                    ? (dark ? Color.FromArgb(90, 42, 49) : Color.FromArgb(255, 219, 222))
                    : hover;
                button.FlatAppearance.MouseDownBackColor = button.FlatAppearance.MouseOverBackColor;
            }
        }
    }

    private sealed class MenuColors(DialogColors colors) : ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground => colors.Canvas;
        public override Color MenuBorder => colors.Line;
        public override Color MenuItemSelected => colors.Wash;
        public override Color MenuItemBorder => colors.Line;
        public override Color SeparatorLight => colors.Line;
        public override Color SeparatorDark => colors.Line;
    }

    private static TitleButton CaptionButton(string text, int width, Action? action = null)
    {
        var button = new TitleButton
        {
            Caption = text, AccessibleName = text, Width = width, Height = CaptionHeight, Margin = Padding.Empty,
            FlatStyle = FlatStyle.Flat, UseVisualStyleBackColor = false,
        };
        button.FlatAppearance.BorderSize = 0;
        if (action is not null) button.Click += (_, _) => action();
        return button;
    }

    private sealed class TitleButton : Button
    {
        public string Caption { get; set; } = "";

        protected override void OnPaint(PaintEventArgs args)
        {
            base.OnPaint(args);
            TextRenderer.DrawText(args.Graphics, Caption, Font, ClientRectangle, ForeColor,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter |
                TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
        }
    }

    private void ToggleMaximize() => WindowState = WindowState == FormWindowState.Maximized
        ? FormWindowState.Normal : FormWindowState.Maximized;

    private void DragCaption(object? sender, MouseEventArgs args)
    {
        if (args.Button != MouseButtons.Left) return;
        if (args.Clicks > 1)
        {
            ToggleMaximize();
            return;
        }
        ReleaseCapture();
        SendMessage(Handle, 0x00A1, 2, 0); // WM_NCLBUTTONDOWN, HTCAPTION
    }

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll", EntryPoint = "SendMessageW")]
    private static extern nint SendMessage(nint window, uint message, nint wParam, nint lParam);
}
