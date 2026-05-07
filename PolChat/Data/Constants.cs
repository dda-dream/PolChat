namespace ChatApp.Data;

public static class Constants
{
    public const string DeletedUserDisplayName = "Удаленный аккаунт";
    public const string DeletedUserAvatarLetter = "?";
    public const string GeneralChannelName = "Общий";
    public const int SessionTtlDays = 30;
    public const int MaxUploadSizeBytes = 1000 * 1024 * 1024; // 1000 MB
    public const int MessagesPerPage = 50;

    public static readonly HashSet<string> AllowedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg",
        "mp4", "webm", "ogg", "mov", "avi", "mkv",
        "pdf", "txt", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        "mp3", "wav", "flac", "m4a",
        "zip", "rar", "7z", "tar", "gz"
    };

    public static readonly HashSet<string> ImageExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg"
    };

    public static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "mp4", "webm", "ogg", "mov", "avi", "mkv"
    };

    public static readonly HashSet<string> AudioExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        "mp3", "wav", "ogg", "flac", "m4a"
    };

    public static readonly HashSet<string> AllowedStatuses = new()
    {
        "online", "away", "offline"
    };

    public static string GetFileType(string filename)
    {
        var ext = filename.Split('.').LastOrDefault()?.ToLower() ?? "";
        if (ImageExtensions.Contains(ext)) return "image";
        if (VideoExtensions.Contains(ext)) return "video";
        if (AudioExtensions.Contains(ext)) return "audio";
        return "file";
    }
}
