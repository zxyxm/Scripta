using System.Text.Json;
using System.Text.Json.Serialization;

namespace Moye;

internal sealed partial class EditorWindow
{
    private static readonly Size MinimumWindowSize = new(620, 360);
    private static readonly string DisplaySettingsPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Moye", "display-settings.json");
    private readonly DisplaySettings displaySettings = LoadDisplaySettings();

    private sealed record DisplaySettings(string WindowMode, int WindowWidth, int WindowHeight, int FontSize)
    {
        public int DocumentWidth { get; init; } = 852;
        public bool OpenOutlineByDefault { get; init; }
        public bool? ShowBlockLabelsByDefault { get; init; }

        [JsonIgnore]
        public bool IsValid => (WindowMode is "automatic" or "custom" or "maximized") &&
            WindowWidth >= MinimumWindowSize.Width && WindowWidth <= 10000 &&
            WindowHeight >= MinimumWindowSize.Height && WindowHeight <= 10000 &&
            FontSize is >= 12 and <= 36 &&
            DocumentWidth is >= 360 and <= 10000;
    }

    private static DisplaySettings LoadDisplaySettings()
    {
        try
        {
            var settings = JsonSerializer.Deserialize<DisplaySettings>(File.ReadAllText(DisplaySettingsPath), Json);
            if (settings?.IsValid == true) return settings;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            // A missing, unreadable or invalid preferences file falls back to defaults.
        }
        return new DisplaySettings("automatic", 1200, 800, 17);
    }

    private void ApplyStartupWindow(Rectangle workArea)
    {
        int width = displaySettings.WindowMode == "custom" ? displaySettings.WindowWidth : workArea.Width * 94 / 100;
        int height = displaySettings.WindowMode == "custom" ? displaySettings.WindowHeight : workArea.Height * 94 / 100;
        width = Math.Clamp(width, Math.Min(MinimumSize.Width, workArea.Width), workArea.Width);
        height = Math.Clamp(height, Math.Min(MinimumSize.Height, workArea.Height), workArea.Height);
        Bounds = new Rectangle(workArea.X + (workArea.Width - width) / 2,
            workArea.Y + (workArea.Height - height) / 2, width, height);
        if (displaySettings.WindowMode == "maximized") WindowState = FormWindowState.Maximized;
    }

    private static Response SaveDisplaySettings(DisplaySettings? settings)
    {
        if (settings?.IsValid != true) return new Response(Error: "显示设置超出允许范围。");

        string directory = Path.GetDirectoryName(DisplaySettingsPath)!;
        Directory.CreateDirectory(directory);
        string temporary = Path.Combine(directory, Guid.NewGuid() + ".tmp");
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(settings, Json));
            File.Move(temporary, DisplaySettingsPath, overwrite: true);
        }
        finally
        {
            File.Delete(temporary);
        }
        return new Response();
    }
}
