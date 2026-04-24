namespace ChatApp.Models;

public class UploadResponse
{
    public bool Success { get; set; }
    public string? FileUrl { get; set; }
    public string? Filename { get; set; }
    public string? OriginalFilename { get; set; }
    public string? FileType { get; set; }
    public long FileSize { get; set; }
    public string? Error { get; set; }
}

public class ApiError
{
    public string Error { get; set; } = null!;
}
