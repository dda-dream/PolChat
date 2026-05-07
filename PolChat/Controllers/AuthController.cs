using Microsoft.AspNetCore.Mvc;
using ChatApp.Data;
using ChatApp.Models;
using ChatApp.Services;

namespace ChatApp.Controllers;

[ApiController]
[Route("/")]
public class AuthController : ControllerBase
{
    private readonly ChatDbContext _db;
    private readonly ISessionService _sessionService;
    private readonly IConfiguration _config;
    private readonly ILogger<AuthController> _logger;
    IHttpContextAccessor _httpContextAccessor;

    public AuthController(ChatDbContext db, ISessionService sessionService, IConfiguration config, ILogger<AuthController> logger,
        IHttpContextAccessor httpContextAccessor)
    {
        _db = db;
        _sessionService = sessionService;
        _config = config;
        _logger = logger;
        _httpContextAccessor = httpContextAccessor;
    }



    // GET /login - return simple HTML page (in production, serve from wwwroot)
    [HttpGet("/login")]
    public IActionResult LoginPage()
    {
        //return Content(LoginHtml(), "text/html");
        return File("~/login.html", "text/html");
    }

    // POST /api/auth/login
    [HttpPost("/api/auth/login")]
    //[HttpPost("/login")]
    public async Task<IActionResult> Login([FromBody] LoginRequest request)
    {
        var user = await _db.Users.FindAsync(request.Username);
        if (user == null || user.Password != DbInitializer.ComputeSha256Hash(request.Password))
        {
            return Unauthorized(new { success = false, error = "Invalid credentials" });
        }

        var sessionId = await _sessionService.CreateSessionAsync(new SessionData
        {
            UserId = user.Username,
            Username = user.Username,
            Role = user.Role
        });

        // Update status to online
        var now = DateTime.UtcNow;
        user.Status = "online";
        user.LastSeen = now;
        await _db.SaveChangesAsync();

        Response.Cookies.Append($"SESSION_ID_PORT_{_httpContextAccessor.HttpContext?.Connection.LocalPort}", sessionId, new CookieOptions
        {
            HttpOnly = true,
            MaxAge = TimeSpan.FromDays(Constants.SessionTtlDays),
            SameSite = SameSiteMode.Lax,
            Secure = false // set true in production with HTTPS
        });

        return Ok(new { success = true, redirect = "/chat.html" });
    }

    // GET /logout
    [HttpGet("/logout")]
    public async Task<IActionResult> Logout()
    {
        if (Request.Cookies.TryGetValue($"SESSION_ID_PORT_{_httpContextAccessor.HttpContext?.Connection.LocalPort}", out var sid) && !string.IsNullOrEmpty(sid))
        {
            await _sessionService.DeleteSessionAsync(sid);
            Response.Cookies.Delete($"SESSION_ID_PORT_{_httpContextAccessor.HttpContext?.Connection.LocalPort}");
        }
        return Redirect("/login");
    }

    // GET /register
    [HttpGet("/register")]
    public IActionResult RegisterPage()
    {
        //return Content(RegisterHtml(), "text/html");
        return File("~/register.html", "text/html");
    }

    // POST /api/auth/register
    [HttpPost("/api/auth/register")]
    public async Task<IActionResult> Register([FromBody] RegisterRequest request)
    {
        var registrationDisabled = _config.GetValue<bool>("Registration:Disabled", true);
        if (registrationDisabled)
        {
            return StatusCode(403, new { success = false, error = _config.GetValue("Registration:DisabledMessage", "Регистрация закрыта") });
        }

        if (request.Username.Length < 3 || request.Username.Length > 20)
            return BadRequest(new { success = false, error = "Имя 3-20 символов" });

        if (!request.Username.Replace("_", "").All(char.IsLetterOrDigit))
            return BadRequest(new { success = false, error = "Только буквы, цифры и _" });

        if (request.Password.Length < 6)
            return BadRequest(new { success = false, error = "Пароль мин. 6 символов" });

        var existing = await _db.Users.FindAsync(request.Username);
        if (existing != null)
            return BadRequest(new { success = false, error = "Уже существует" });

        _db.Users.Add(new User
        {
            Username = request.Username,
            Password = DbInitializer.ComputeSha256Hash(request.Password),
            Role = "user",
            CreatedAt = DateTime.UtcNow,
            Avatar = "default.png",
            Status = "offline"
        });
        await _db.SaveChangesAsync();

        return Ok(new { success = true, message = "Регистрация успешна!" });
    }

    // GET / - main chat page (requires auth)
    [HttpGet("/")]
    public async Task<IActionResult> Index()
    {
        Request.Cookies.TryGetValue($"SESSION_ID_PORT_{_httpContextAccessor.HttpContext?.Connection.LocalPort}", out var sid);
        var session = string.IsNullOrEmpty(sid) ? null : await _sessionService.GetSessionAsync(sid);

        if (session == null)
            return Redirect("/login.html");

        return File("~/chat.html", "text/html");
    }

    // GET /api/time
    //[ResponseCache(Duration = 0, Location = ResponseCacheLocation.None, NoStore = true)]
    [HttpGet("/api/time")]
    public IActionResult ServerTime()
    {
        var now = DateTime.UtcNow;
        return Ok(new
        {
            timestamp = now.ToString("O"),
            time = now.ToString("HH:mm:ss"),
            date = now.ToString("dd.MM.yyyy")
        });
    }
}
