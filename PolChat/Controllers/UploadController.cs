using ChatApp.Data;
using ChatApp.Hubs;
using ChatApp.Models;
using ChatApp.Services;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;

namespace ChatApp.Controllers;

[ApiController]
public class UploadController : ControllerBase
{
    private readonly ISessionService _sessionService;
    private readonly ILogger<UploadController> _logger;
    private readonly string _uploadFolder;
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly IHubContext<ChatHub> _hubContext;

    public UploadController(
        ISessionService sessionService,
        ILogger<UploadController> logger,
        IConfiguration config,
        IHttpContextAccessor httpContextAccessor,
        IHubContext<ChatHub> hubContext)
    {
        _sessionService = sessionService;
        _logger = logger;
        _uploadFolder = config.GetValue<string>("Uploads:Folder", "uploads");
        _httpContextAccessor = httpContextAccessor;
        _hubContext = hubContext;
    }

    private async Task<SessionData?> GetSession()
    {
        Request.Cookies.TryGetValue($"SESSION_ID", out var sid);
        return await _sessionService.GetSessionAsync(sid);
    }

    [HttpPost("/upload")]
    [RequestSizeLimit(Constants.MaxUploadSizeBytes)]
    [RequestFormLimits(MultipartBodyLengthLimit = Constants.MaxUploadSizeBytes)]
    public async Task<IActionResult> Upload(IFormFile? file, [FromForm] string? channelId = null)
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

        var safeName = $"{DateTime.UtcNow:yyyy-MM-dd-HH-mm-ss}-{Guid.NewGuid():N}.{ext}";
        var filepath = Path.Combine(_uploadFolder, safeName);

        await using var stream = new FileStream(filepath, FileMode.Create);
        await file.CopyToAsync(stream);

        var fileUrl = $"/uploads/{safeName}";
        var fileType = Constants.GetFileType(filename);
        var isImage = fileType == "image";

        var response = new UploadResponse
        {
            Success = true,
            FileUrl = fileUrl,
            Filename = filename.Length > 50 ? filename[..50] : filename,
            OriginalFilename = filename,
            FileType = fileType,
            FileSize = file.Length
        };

        // 🔔 Отправляем уведомление через SignalR о новом файле
        await _hubContext.Clients.Group("all_users").SendAsync("new_file_uploaded", new
        {
            fileUrl = fileUrl,
            filename = filename,
            fileType = fileType,
            fileSize = file.Length,
            isImage = isImage,
            uploadedBy = session.Username,
            uploadedAt = DateTime.UtcNow.ToString("O"),
            channelId = channelId
        });

        return Ok(response);
    }

    // GET /uploads/{filename} - только один раз!
    [HttpGet("/uploads/{filename}")]
    public IActionResult GetUploadedFile(string filename)
    {
        var filepath = Path.Combine(_uploadFolder, filename);

        if (!System.IO.File.Exists(filepath))
            return NotFound();

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