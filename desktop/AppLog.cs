using System.Diagnostics;
using System.Text;

namespace Moye;

internal static class AppLog
{
    private const long MaxBytes = 512 * 1024;
    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Moye", "logs", "scripta.log");
    private static readonly Mutex LogLock = new(false, @"Local\Moye.Scripta.AppLog");

    public static bool IsLoggedAction(string action) => action is
        "open" or "open-note" or "save" or "rename" or "rename-folder" or "create-note-entry" or "move-note" or "move-note-section" or
        "copy-note" or "delete-note" or "delete-note-permanently" or "choose-notes" or "unbind-notes" or
        "list-notes" or "merge" or "export-markdown" or "import-pdf" or "import-pdf-with-source" or "import-wps-docx" or "import-resources" or
        "replace-image" or "setup-git" or "commit-notes" or "repository-sync" or "bind-github" or "clone-github" or
        "pull-github" or "pull-github-partial" or "push-github" or "save-display-settings";

    public static void Write(string action, string result, long? elapsedMs = null, Exception? error = null)
    {
        try
        {
            try { if (!LogLock.WaitOne(100)) return; }
            catch (AbandonedMutexException) { }

            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
                if (File.Exists(LogPath) && new FileInfo(LogPath).Length >= MaxBytes)
                    File.Move(LogPath, LogPath + ".1", overwrite: true);

                string duration = elapsedMs is { } ms ? $"\t{ms}ms" : "";
                string diagnostic = error is null ? "" : $"\t{error.GetType().Name} 0x{error.HResult:X8}";
                File.AppendAllText(LogPath, $"{DateTimeOffset.Now:O}\t{action}\t{result}{duration}{diagnostic}{Environment.NewLine}",
                    Encoding.UTF8);
            }
            finally { LogLock.ReleaseMutex(); }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // A log write failure must not interrupt the editor operation.
        }
    }

    public static void Open()
    {
        Write("open-log", "requested");
        if (!File.Exists(LogPath)) throw new IOException("无法创建日志文件。");
        var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "notepad.exe"))
        {
            UseShellExecute = false,
        };
        start.ArgumentList.Add(LogPath);
        using var process = Process.Start(start);
    }
}
