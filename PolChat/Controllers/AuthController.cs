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

    public AuthController(ChatDbContext db, ISessionService sessionService, IConfiguration config, ILogger<AuthController> logger)
    {
        _db = db;
        _sessionService = sessionService;
        _config = config;
        _logger = logger;
    }

    // GET /login - return simple HTML page (in production, serve from wwwroot)
    [HttpGet("/login")]
    public IActionResult LoginPage()
    {
        return Content(LoginHtml(), "text/html");
    }

    // POST /api/auth/login
    [HttpPost("/api/auth/login")]
    public async Task<IActionResult> Login([FromBody] LoginRequest request)
    {
        var user = await _db.users.FindAsync(request.Username);
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

        Response.Cookies.Append("SESSION_ID", sessionId, new CookieOptions
        {
            HttpOnly = true,
            MaxAge = TimeSpan.FromDays(Constants.SessionTtlDays),
            SameSite = SameSiteMode.Lax,
            Secure = false // set true in production with HTTPS
        });

        return Ok(new { success = true, redirect = "/" });
    }

    // GET /logout
    [HttpGet("/logout")]
    public async Task<IActionResult> Logout()
    {
        if (Request.Cookies.TryGetValue("SESSION_ID", out var sid) && !string.IsNullOrEmpty(sid))
        {
            await _sessionService.DeleteSessionAsync(sid);
            Response.Cookies.Delete("SESSION_ID");
        }
        return Redirect("/login");
    }

    // GET /register
    [HttpGet("/register")]
    public IActionResult RegisterPage()
    {
        return Content(RegisterHtml(), "text/html");
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

        var existing = await _db.users.FindAsync(request.Username);
        if (existing != null)
            return BadRequest(new { success = false, error = "Уже существует" });

        _db.users.Add(new User
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
    public IActionResult Index()
    {
        // In production, serve from wwwroot or use static files
        // For now return a placeholder that the frontend will replace
        return Content(ChatHtml(), "text/html");
    }

    // GET /api/time
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

    private static string LoginHtml() => @"<!DOCTYPE html>
<html><head><meta charset='utf-8'><title>Вход</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f2f5}
.box{background:#fff;padding:40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);width:360px;text-align:center}
h2{margin:0 0 20px;color:#333}input{display:block;width:100%;padding:12px;margin:8px 0;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box}
button{width:100%;padding:12px;background:#5b6abf;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;margin-top:8px}
button:hover{background:#4a58a8}a{color:#5b6abf;font-size:13px}.err{color:red;font-size:13px;margin-top:8px;min-height:20px}</style></head>
<body><div class='box'><h2>Вход в чат</h2>
<input id='username' placeholder='Имя пользователя'>
<input id='password' type='password' placeholder='Пароль'>
<button onclick='login()'>Войти</button><div class='err' id='err'></div>
<a href='/register'>Регистрация</a>
</div><script>
async function login(){const u=document.getElementById('username').value,p=document.getElementById('password').value,e=document.getElementById('err');
e.textContent='';const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
const d=await r.json();if(d.success)window.location.href='/';else e.textContent=d.error||'Ошибка';}
document.getElementById('password').addEventListener('keydown',e=>{if(e.key==='Enter')login();});
</script></body></html>";

    private static string RegisterHtml() => @"<!DOCTYPE html>
<html><head><meta charset='utf-8'><title>Регистрация</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f0f2f5}
.box{background:#fff;padding:40px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);width:360px;text-align:center}
h2{margin:0 0 20px;color:#333}input{display:block;width:100%;padding:12px;margin:8px 0;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box}
button{width:100%;padding:12px;background:#5b6abf;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;margin-top:8px}
button:hover{background:#4a58a8}a{color:#5b6abf;font-size:13px}.err{color:red;font-size:13px;margin-top:8px;min-height:20px}</style></head>
<body><div class='box'><h2>Регистрация</h2>
<input id='username' placeholder='Имя пользователя (3-20 символов)'>
<input id='password' type='password' placeholder='Пароль (мин. 6 символов)'>
<button onclick='register()'>Зарегистрироваться</button><div class='err' id='err'></div>
<a href='/login'>Уже есть аккаунт</a>
</div><script>
async function register(){const u=document.getElementById('username').value,p=document.getElementById('password').value,e=document.getElementById('err');
e.textContent='';const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
const d=await r.json();if(d.success)window.location.href='/login';else e.textContent=d.error||'Ошибка';}
document.getElementById('password').addEventListener('keydown',e=>{if(e.key==='Enter')register();});
</script></body></html>";

    private static string ChatHtml() => @"<!DOCTYPE html>
<html><head><meta charset='utf-8'><title>Чат</title>
<style>body{font-family:system-ui;margin:0;padding:20px;background:#f0f2f5;color:#333}
h1{color:#5b6abf}.info{background:#fff;padding:20px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.1);max-width:600px;margin:40px auto}
code{background:#e8eaf6;padding:2px 6px;border-radius:4px;font-size:13px}</style></head>
<body><div class='info'>
<h1>Pol Чат</h1><p>Сервер запущен. API доступно по адресу <code>/api/</code></p>
<p>WebSocket: <code>/chathub</code> (SignalR)</p>
<p>Swagger: <a href='/swagger'>/swagger</a></p>
<p><a href='/api/time'>Серверное время</a> | <a href='/logout'>Выйти</a></p>
</div></body></html>";
}
