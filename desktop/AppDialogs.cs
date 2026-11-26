using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;

namespace Moye;

internal sealed partial class EditorWindow
{
    private bool darkTheme;

    private sealed record DialogColors(Color Canvas, Color Ink, Color Line, Color Wash, Color Accent, Color AccentInk)
    {
        public static DialogColors For(bool dark) => dark
            ? new(Color.FromArgb(32, 35, 40), Color.FromArgb(229, 232, 238), Color.FromArgb(54, 60, 70),
                Color.FromArgb(44, 52, 64), Color.FromArgb(169, 203, 249), Color.FromArgb(21, 36, 59))
            : new(Color.White, Color.FromArgb(34, 38, 44), Color.FromArgb(225, 229, 234),
                Color.FromArgb(234, 238, 243), Color.FromArgb(41, 86, 145), Color.White);
    }

    private void ShowNotice(string title, string message) => ShowAppDialog(title, message, "确定");

    private bool ConfirmAction(string title, string message, string action, bool destructive = false) =>
        ShowAppDialog(title, message, action, allowCancel: true, destructive: destructive).Accepted;

    private (bool Accepted, string Answer) ShowAppDialog(string title, string message, string action,
        bool allowCancel = false, string? initial = null, bool destructive = false)
    {
        using var dialog = new Form
        {
            Text = title, StartPosition = FormStartPosition.CenterParent, ShowInTaskbar = false,
            FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, MinimizeBox = false,
            AutoScaleMode = AutoScaleMode.Dpi, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
            Icon = Icon,
        };
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1, Padding = new Padding(20, 16, 20, 14),
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        string body = message.ReplaceLineEndings(Environment.NewLine);
        const int bodyWidth = 386;
        int measured = TextRenderer.MeasureText(body, Font, new Size(bodyWidth - 12, 0),
            TextFormatFlags.WordBreak | TextFormatFlags.NoPrefix).Height;
        var copy = new TextBox
        {
            Text = body, ReadOnly = true, Multiline = true, TabStop = false, BorderStyle = BorderStyle.None,
            Size = new Size(bodyWidth, Math.Clamp(measured + 10, 40, 245)),
            ScrollBars = measured > 235 ? ScrollBars.Vertical : ScrollBars.None,
            AccessibleName = "提示内容", Margin = new Padding(0, 2, 0, 10),
        };
        layout.Controls.Add(copy);
        TextBox? input = null;
        if (initial is not null)
        {
            input = new TextBox
            {
                Text = initial, Dock = DockStyle.Fill, BorderStyle = BorderStyle.FixedSingle,
                AccessibleName = message, Margin = new Padding(0, 0, 0, 10),
            };
            layout.Controls.Add(input);
        }
        var buttons = new FlowLayoutPanel
        {
            AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, WrapContents = false,
            Anchor = AnchorStyles.Right, FlowDirection = FlowDirection.RightToLeft, Margin = Padding.Empty,
        };
        var accept = new Button
        {
            Text = action, DialogResult = DialogResult.OK, AutoSize = true,
            MinimumSize = new Size(72, 32), Margin = Padding.Empty,
        };
        buttons.Controls.Add(accept);
        Button? cancel = null;
        if (allowCancel)
        {
            cancel = new Button
            {
                Text = "取消", DialogResult = DialogResult.Cancel, AutoSize = true,
                MinimumSize = new Size(72, 32), Margin = new Padding(0, 0, 8, 0),
            };
            buttons.Controls.Add(cancel);
        }
        layout.Controls.Add(buttons);
        dialog.Controls.Add(layout);
        dialog.AcceptButton = accept;
        dialog.CancelButton = cancel ?? accept;
        ApplyDialogTheme(dialog);
        var colors = DialogColors.For(darkTheme);
        accept.BackColor = destructive
            ? (darkTheme ? Color.FromArgb(255, 154, 152) : Color.FromArgb(179, 45, 49))
            : colors.Accent;
        accept.ForeColor = colors.AccentInk;
        accept.FlatAppearance.BorderSize = 0;
        accept.FlatAppearance.MouseOverBackColor = Color.FromArgb(
            (accept.BackColor.R * 9 + colors.Ink.R) / 10, (accept.BackColor.G * 9 + colors.Ink.G) / 10,
            (accept.BackColor.B * 9 + colors.Ink.B) / 10);
        dialog.Shown += (_, _) =>
        {
            dialog.ActiveControl = (Control?)input ?? cancel ?? accept;
            input?.SelectAll();
        };
        bool accepted = dialog.ShowDialog(this) == DialogResult.OK;
        return (accepted, input?.Text ?? "");
    }

    private void ApplyDialogTheme(Form dialog)
    {
        var colors = DialogColors.For(darkTheme);
        void Apply(Control control)
        {
            control.BackColor = colors.Canvas;
            control.ForeColor = colors.Ink;
            if (control is Button button)
            {
                button.UseVisualStyleBackColor = false;
                button.FlatStyle = FlatStyle.Flat;
                button.FlatAppearance.BorderColor = colors.Line;
                button.FlatAppearance.MouseOverBackColor = colors.Wash;
            }
            foreach (Control child in control.Controls) Apply(child);
        }
        Apply(dialog);
        dialog.HandleCreated += (_, _) => ThemeDialogCaption(dialog);
        if (dialog.IsHandleCreated) ThemeDialogCaption(dialog);
    }

    private void ThemeDialogCaption(Form dialog)
    {
        int dark = darkTheme ? 1 : 0;
        _ = DwmSetWindowAttribute(dialog.Handle, 20, ref dark, sizeof(int));
    }

    private void OpenScriptDialog(object? sender, CoreWebView2ScriptDialogOpeningEventArgs args)
    {
        var deferral = args.GetDeferral();
        // A modal loop must run outside the WebView2 event callback.
        BeginInvoke(() =>
        {
            try
            {
                if (IsDisposed) return;
                bool prompt = args.Kind == CoreWebView2ScriptDialogKind.Prompt;
                var answer = ShowAppDialog(prompt ? "输入" : AppName, args.Message, "确定",
                    allowCancel: args.Kind != CoreWebView2ScriptDialogKind.Alert, initial: prompt ? args.DefaultText ?? "" : null);
                if (!answer.Accepted && args.Kind != CoreWebView2ScriptDialogKind.Alert) return;
                if (prompt) args.ResultText = answer.Answer;
                args.Accept();
            }
            finally
            {
                deferral.Complete();
            }
        });
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);
}
