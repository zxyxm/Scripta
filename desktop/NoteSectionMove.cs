namespace Moye;

internal sealed partial class EditorWindow
{
    private sealed record SectionMovePlan(Guid Id, Guid Token, string Root, string Source, string Target,
        string SourceDisk, string TargetDisk);
    private sealed record SectionDestination(Guid Id, string Path, string Name, string Contents, bool SameFile,
        string SourceName, string SourceFolder, string AssetFolder);
    private sealed record SectionMoveInput(Guid Id, string? TargetContents, string[]? Assets);
    private SectionMovePlan? pendingSectionMove;

    private async Task<Response> ChooseSectionDestination(Guid? token, string relative)
    {
        pendingSectionMove = null;
        if (notesRoot is not { } root || documentPath is not { } source || documentToken is not { } current ||
            current != token || !IsInsideFolder(root, source) ||
            ResolveRepositoryEntry(Path.GetRelativePath(root, source), isFolder: false) is null)
            return new Response(Error: "请先保存此笔记，并将它放在当前笔记仓库中。");

        if (ResolveRepositoryEntry(relative, isFolder: false) is not { } target)
            return new Response(Error: "请选择当前笔记仓库中的 Markdown 文件。");
        string? sourceDisk = await TryReadNoteText(source);
        bool sameFile = SamePath(source, target);
        string? targetDisk = sameFile ? sourceDisk : await TryReadNoteText(target);
        if (sourceDisk is null || sourceDisk != diskContents || targetDisk is null)
            return new Response(Error: "无法读取笔记，或源笔记已在磁盘上更改。请先刷新并处理冲突。");

        Guid id = Guid.NewGuid();
        pendingSectionMove = new SectionMovePlan(id, current, root, source, target, sourceDisk, targetDisk);
        string sourceFolder = Path.GetRelativePath(Path.GetDirectoryName(target)!, Path.GetDirectoryName(source)!);
        return new Response(SectionDestination: new SectionDestination(id, relative, Path.GetFileName(target), targetDisk,
            sameFile, Path.GetFileName(source), sourceFolder, "section-" + id.ToString("N")));
    }

    private async Task<Response> MoveNoteSection(Request request)
    {
        if (request.SectionMove is not { } input || pendingSectionMove is not { } plan ||
            plan.Id != input.Id || plan.Token != request.Token || plan.Token != documentToken ||
            plan.Root != notesRoot || plan.Source != documentPath || request.Contents is not { } sourceText)
            return new Response(Error: "移动位置已失效，请重新打开标题菜单。");

        bool sameFile = SamePath(plan.Source, plan.Target);
        if (sameFile != (input.TargetContents is null) || sameFile && input.Assets is { Length: > 0 })
            return new Response(Error: "移动位置无效。");
        if (ResolveRepositoryEntry(Path.GetRelativePath(plan.Root, plan.Source), isFolder: false) is not { } source ||
            ResolveRepositoryEntry(Path.GetRelativePath(plan.Root, plan.Target), isFolder: false) is not { } target ||
            !SamePath(source, plan.Source) || !SamePath(target, plan.Target))
            return new Response(Error: "笔记已移动或不可用，请重新选择。");

        try
        {
            await Task.Run(() => PublishSectionMove(plan, sourceText, input.TargetContents, input.Assets ?? []));
        }
        catch (SectionMoveConflict error)
        {
            return new Response(Error: error.Message);
        }
        pendingSectionMove = null;
        return BindDocument(plan.Source, sourceText, includeContents: true);
    }

    private sealed class SectionMoveConflict(string message) : IOException(message);

    private static void PublishSectionMove(SectionMovePlan plan, string sourceText, string? targetText, string[] assets)
    {
        string sourceStage = plan.Source + ".scripta-" + plan.Id.ToString("N");
        string targetStage = plan.Target + ".scripta-" + plan.Id.ToString("N");
        string sourceBackup = sourceStage + ".bak";
        string targetBackup = targetStage + ".bak";
        string targetAssets = Path.ChangeExtension(plan.Target, ".assets");
        string copied = Path.Combine(targetAssets, "section-" + plan.Id.ToString("N"));
        bool assetsCreated = false;
        bool assetsParentCreated = false;
        bool sourceWritten = false;
        bool targetWritten = false;
        bool keepRecovery = false;
        try
        {
            StageSectionNote(sourceStage, sourceText);
            if (targetText is not null) StageSectionNote(targetStage, targetText);
            if (assets.Length > 0)
            {
                if (Path.Exists(targetAssets) &&
                    (!Directory.Exists(targetAssets) || File.GetAttributes(targetAssets).HasFlag(FileAttributes.ReparsePoint)))
                    throw new SectionMoveConflict("目标图床不可用，移动已停止。");
                if (Path.Exists(copied)) throw new SectionMoveConflict("目标附件目录已存在，请重新选择目标笔记。");
                assetsParentCreated = !Directory.Exists(targetAssets);
                Directory.CreateDirectory(copied);
                assetsCreated = true;
                foreach (string path in assets.Distinct(StringComparer.OrdinalIgnoreCase))
                    CopySectionAsset(Path.ChangeExtension(plan.Source, ".assets"), copied, path);
            }

            VerifySectionSnapshot(plan.Source, plan.SourceDisk);
            if (targetText is not null) VerifySectionSnapshot(plan.Target, plan.TargetDisk);

            // Publish the destination first so an interrupted move never removes the only copy.
            if (targetText is not null)
            {
                File.Replace(targetStage, plan.Target, targetBackup);
                targetWritten = true;
                VerifySectionSnapshot(targetBackup, plan.TargetDisk);
            }
            File.Replace(sourceStage, plan.Source, sourceBackup);
            sourceWritten = true;
            VerifySectionSnapshot(sourceBackup, plan.SourceDisk);
        }
        catch
        {
            if (sourceWritten && !RestoreSectionNote(plan.Source, sourceBackup, sourceText) ||
                targetWritten && !RestoreSectionNote(plan.Target, targetBackup, targetText!))
            {
                keepRecovery = true;
                throw new SectionMoveConflict("写入过程中笔记再次发生变化，已保留现有文件及同目录下的 .scripta-*.bak 恢复副本。");
            }
            if (assetsCreated)
            {
                try
                {
                    Directory.Delete(copied, recursive: true);
                    if (assetsParentCreated && !Directory.EnumerateFileSystemEntries(targetAssets).Any())
                        Directory.Delete(targetAssets);
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            }
            throw;
        }
        finally
        {
            DeleteTemporaryFile(sourceStage);
            if (targetText is not null) DeleteTemporaryFile(targetStage);
            if (!keepRecovery)
            {
                DeleteTemporaryFile(sourceBackup);
                if (targetText is not null) DeleteTemporaryFile(targetBackup);
            }
        }
    }

    private static void StageSectionNote(string path, string text)
    {
        using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write);
        using var writer = new StreamWriter(stream, Utf8);
        writer.Write(text);
    }

    private static void VerifySectionSnapshot(string path, string expected)
    {
        if (Utf8.GetString(File.ReadAllBytes(path)) != expected)
            throw new SectionMoveConflict("保存时检测到磁盘版本冲突，已停止移动。");
    }

    private static bool RestoreSectionNote(string path, string backup, string written)
    {
        try
        {
            if (Utf8.GetString(File.ReadAllBytes(path)) != written) return false;
            File.Move(backup, path, overwrite: true);
            return true;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return false; }
    }

    private static void CopySectionAsset(string root, string destination, string path)
    {
        if (string.IsNullOrEmpty(path) || Path.IsPathRooted(path) || !Directory.Exists(root) ||
            File.GetAttributes(root).HasFlag(FileAttributes.ReparsePoint))
            throw new SectionMoveConflict("章节中的附件无法读取，移动已停止。");
        string current = root;
        string[] parts = path.Split('/');
        for (int i = 0; i < parts.Length; i++)
        {
            string part = parts[i];
            if (part.Length == 0 || part.EndsWith('.') || part.EndsWith(' ') ||
                part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || IsDeviceName(part))
                throw new SectionMoveConflict("章节中的附件路径无效。");
            current = Path.Combine(current, part);
            if (!Path.Exists(current)) throw new SectionMoveConflict("章节中有找不到的附件，移动已停止。");
            var attributes = File.GetAttributes(current);
            if (attributes.HasFlag(FileAttributes.ReparsePoint) ||
                attributes.HasFlag(FileAttributes.Directory) != (i < parts.Length - 1))
                throw new SectionMoveConflict("章节中的附件无法安全复制。");
        }
        string target = Path.Combine(destination, Path.GetRelativePath(root, current));
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.Copy(current, target);
    }
}
