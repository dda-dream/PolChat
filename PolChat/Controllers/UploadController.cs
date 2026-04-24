using Microsoft.AspNetCore.Mvc;
using ChatApp.Data;
using ChatApp.Services;

namespace ChatApp.Controllers;

[ApiController]
public class UploadController : ControllerBase
{
    private readonly ISessionService _sessionService;
    private readonly ILogger<UploadController> _logger;
    private readonly string _uploadFolder;

    public UploadController(ISessionService sessionService, ILogger<UploadController> logger, IConfiguration config)
    {
        _sessionService = sessionService;
        _logger = logger;
        _uploadFolder = config.GetValue<string>("Uploads:Folder", "uploads");
    }

    private async Task<SessionData?> GetSession()
    {
        Request.Cookies.TryGetValue("SESSION_ID", out var sid);
        return await _sessionService.GetSessionAsync(sid);
    }

    // POST /upload
    [HttpPost("/upload")]
    [RequestSizeLimit(200 * 1024 * 1024)] // 200MB
    [RequestFormLimits(MultipartBodyLengthLimit = 200 * 1024 * 1024)]
    public async Task<IActionResult> Upload(IFormFile? file)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        if (file == null || file.Length == 0)
            return BadRequest(new { error = "No file" });

        var filename = file.FileName;
        if (string.IsNullOrEmpty(filename) || !filename.Contains('.'))
            return BadRequest(new { error = "No extension" });

        var ext = filename.Split('.').Last().ToLower();
        if (!Constants.AllowedExtensions.Contains(ext))
            return BadRequest(new { error = $".{ext} not allowed" });

        if (!Directory.Exists(_uploadFolder))
            Directory.CreateDirectory(_uploadFolder);

        var safeName = $"{DateTime.UtcNow:yyyy-MM-dd-HH-mm-ss}-{Guid.NewGuid():N}.[{ext}]";
        var filepath = Path.Combine(_uploadFolder, safeName);

        await using var stream = new FileStream(filepath, FileMode.Create);
        await file.CopyToAsync(stream);

        var fileUrl = $"/uploads/{safeName}";
        return Ok(new UploadResponse
        {
            Success = true,
            FileUrl = fileUrl,
            Filename = filename.Length > 50 ? filename[..50] : filename,
            OriginalFilename = filename,
            FileType = Constants.GetFileType(filename),
            FileSize = file.Length
        });
    }

    // GET /uploads/{filename}
    [HttpGet("/uploads/{filename}")]
    public IActionResult GetUploadedFile(string filename)
    {
        var filepath = Path.Combine(_uploadFolder, filename);

        if (!System.IO.File.Exists(filepath))
            return NotFound();

        // Security: prevent path traversal
        var fullPath = Path.GetFullPath(filepath);
        var uploadFullPath = Path.GetFullPath(_uploadFolder);
        if (!fullPath.StartsWith(uploadFullPath))
            return NotFound();

        var lastModified = System.IO.File.GetLastWriteTimeUtc(filepath);
        Response.Headers["Cache-Control"] = "public, max-age=31536000, immutable";
        Response.Headers["Last-Modified"] = lastModified.ToString("R");

        var physicalFile = new PhysicalFileResult(filepath, "application/octet-stream");
        physicalFile.EnableRangeProcessing = true;
        return physicalFile;
    }
}
