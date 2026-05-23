using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using ChatApp.Data;
using ChatApp.Models;
using ChatApp.Services;

namespace ChatApp.Controllers;

[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase
{
    private readonly ChatDbContext _db;
    private readonly ISessionService _sessionService;
    IHttpContextAccessor _httpContextAccessor;

    public UsersController(ChatDbContext db, ISessionService sessionService, IHttpContextAccessor httpContextAccessor)
    {
        _db = db;
        _sessionService = sessionService;
        _httpContextAccessor = httpContextAccessor;
    }

    private async Task<SessionData?> GetSession()
    {
        Request.Cookies.TryGetValue($"SESSION_ID", out var sid);
        return await _sessionService.GetSessionAsync(sid);
    }

    // GET /api/users
    [HttpGet]
    public async Task<IActionResult> ListUsers()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var users = await _db.Users
            .Where(u => u.Username != null)
            .Select(u => new UserDto
            {
                Username = u.Username,
                Role = u.Role,
                Status = u.Status,
                LastSeen = u.LastSeen,
                CreatedAt = u.CreatedAt,
                Avatar = u.Avatar,
                IsDeleted = false
            })
            .ToListAsync();

        return Ok(users);
    }

    // POST /api/user/status
    [HttpPost("/api/user/status")]
    public async Task<IActionResult> SetStatus([FromBody] SetStatusRequest request)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        if (!Constants.AllowedStatuses.Contains(request.Status))
            return BadRequest(new { error = "Invalid status" });

        var username = session.Username;
        var now = DateTime.UtcNow;

        var user = await _db.Users.FindAsync(username);
        if (user == null) return NotFound(new { error = "User not found" });

        user.Status = request.Status;
        user.LastSeen = now;
        await _db.SaveChangesAsync();

        return Ok(new { success = true });
    }

    // PUT /api/users/{username}/role
    [HttpPut("{username}/role")]
    public async Task<IActionResult> ChangeRole(string username, [FromBody] ChangeRoleRequest request)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });
        if (session.Role != "admin") return StatusCode(403, new { error = "Admin only" });

        if (string.IsNullOrEmpty(request.Role) || (request.Role != "user" && request.Role != "admin"))
            return BadRequest(new { error = "Invalid role" });

        var user = await _db.Users.FindAsync(username);
        if (user == null) return NotFound(new { error = "User not found" });

        user.Role = request.Role;
        await _db.SaveChangesAsync();

        return Ok(new { success = true });
    }

    // DELETE /api/users/{username}
    [HttpDelete("{username}")]
    public async Task<IActionResult> DeleteUser(string username)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });
        if (session.Role != "admin") return StatusCode(403, new { error = "Admin only" });
        if (username == session.Username) return BadRequest(new { error = "Cannot delete yourself" });

        var user = await _db.Users.FindAsync(username);
        if (user == null) return NotFound(new { error = "User not found" });

        _db.Users.Remove(user);
        await _db.SaveChangesAsync();

        return Ok(new { success = true });
    }

    // GET /api/server_info
    [HttpGet("/api/server_info")]
    public IActionResult ServerInfo()
    {
        return Ok(new { status = "ok", version = "1.0.0" });
    }

    // POST /api/user/heartbeat
    [HttpPost("/api/user/heartbeat")]
    public async Task<IActionResult> Heartbeat()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var username = session.Username;
        var now = DateTime.UtcNow;

        var user = await _db.Users.FindAsync(username);
        if (user == null) return NotFound(new { error = "User not found" });

        user.LastSeen = now;
        if (user.Status == "away")
        {
            user.Status = "online";
        }
        await _db.SaveChangesAsync();

        return Ok(new { success = true });
    }

    // GET /api/users/me
    [HttpGet("me")]
    public async Task<IActionResult> GetCurrentUser()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var user = await _db.Users.FindAsync(session.Username);
        if (user == null) return NotFound(new { error = "User not found" });

        return Ok(new
        {
            username = user.Username,
            role = user.Role,
            status = user.Status,
            avatar = user.Avatar,
            createdAt = user.CreatedAt,
            lastSeen = user.LastSeen
        });
    }

    // GET /api/users/settings
    [HttpGet("settings")]
    public async Task<IActionResult> GetUserSettings()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var user = await _db.Users.FindAsync(session.Username);
        if (user == null) return NotFound(new { error = "User not found" });

        // Формируем полный URL для аватара
        string avatarUrl = null;
        if (!string.IsNullOrEmpty(user.Avatar))
        {
            if (user.Avatar.StartsWith("/avatars/"))
            {
                var request = _httpContextAccessor.HttpContext.Request;
                avatarUrl = $"{request.Scheme}://{request.Host}{user.Avatar}";
            }
            else
            {
                avatarUrl = user.Avatar;
            }
        }

        return Ok(new
        {
            username = user.Username,
            role = user.Role,
            status = user.Status,
            createdAt = user.CreatedAt,
            lastSeen = user.LastSeen,
            notificationsEnabled = user.NotificationsEnabled ?? true,
            avatar = avatarUrl
        });
    }

    // PUT /api/users/settings/notifications
    [HttpPut("settings/notifications")]
    public async Task<IActionResult> UpdateNotifications([FromBody] UpdateNotificationsRequest request)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var user = await _db.Users.FindAsync(session.Username);
        if (user == null) return NotFound(new { error = "User not found" });

        user.NotificationsEnabled = request.NotificationsEnabled;
        await _db.SaveChangesAsync();

        return Ok(new { success = true, notificationsEnabled = user.NotificationsEnabled });
    }

    // POST /api/users/logout
    [HttpPost("logout")]
    public async Task<IActionResult> Logout()
    {
        var session = await GetSession();
        if (session != null)
        {
            // Удаляем сессию из Redis
            if (Request.Cookies.TryGetValue("SESSION_ID", out var sessionId))
            {
                await _sessionService.DeleteSessionAsync(sessionId);
            }

            // Обновляем статус пользователя на offline
            var user = await _db.Users.FindAsync(session.Username);
            if (user != null)
            {
                user.Status = "offline";
                user.LastSeen = DateTime.UtcNow;
                await _db.SaveChangesAsync();
            }
        }

        // Удаляем cookie
        Response.Cookies.Delete("SESSION_ID");

        return Ok(new { success = true, redirect = "/login" });
    }

    // Класс для запроса обновления уведомлений
    public class UpdateNotificationsRequest
    {
        public bool NotificationsEnabled { get; set; }
    }

    // PUT /api/users/settings/username
    [HttpPut("settings/username")]
    public async Task<IActionResult> UpdateUsername([FromBody] UpdateUsernameRequest request)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        if (string.IsNullOrWhiteSpace(request.NewUsername))
            return BadRequest(new { error = "Имя пользователя не может быть пустым" });

        if (request.NewUsername.Length < 3 || request.NewUsername.Length > 20)
            return BadRequest(new { error = "Имя должно быть от 3 до 20 символов" });

        // Разрешаем русские буквы, цифры и подчеркивание
        if (!System.Text.RegularExpressions.Regex.IsMatch(request.NewUsername, @"^[a-zA-Zа-яА-Я0-9_]+$"))
            return BadRequest(new { error = "Используйте только буквы (русские/английские), цифры и знак подчеркивания" });

        // Проверяем, не занято ли имя
        var existingUser = await _db.Users.FirstOrDefaultAsync(u => u.Username == request.NewUsername);
        if (existingUser != null)
            return BadRequest(new { error = "Имя пользователя уже занято" });

        var oldUsername = session.Username;
        var user = await _db.Users.FindAsync(oldUsername);
        if (user == null) return NotFound(new { error = "User not found" });

        var newUsername = request.NewUsername;

        // Используем транзакцию для безопасности
        using var transaction = await _db.Database.BeginTransactionAsync();

        try
        {
            // 1. Обновляем имя в таблице Users (создаём новую запись и удаляем старую)
            var newUser = new User
            {
                Username = newUsername,
                Password = user.Password,
                Role = user.Role,
                CreatedAt = user.CreatedAt,
                Avatar = user.Avatar,
                Status = user.Status,
                LastSeen = DateTime.UtcNow,
                IsBot = user.IsBot,
                NotificationsEnabled = user.NotificationsEnabled
            };

            _db.Users.Add(newUser);
            await _db.SaveChangesAsync();

            // 2. Обновляем все сообщения пользователя
            var messages = await _db.Messages.Where(m => m.Username == oldUsername).ToListAsync();
            foreach (var msg in messages)
            {
                msg.Username = newUsername;
            }

            // 3. Обновляем участников в DM каналах (обновляем список participants, а не name)
            var dmChannels = await _db.DmChannels
                .Where(d => d.Participants.Contains(oldUsername))
                .ToListAsync();

            foreach (var dm in dmChannels)
            {
                var participants = dm.Participants.ToList();
                var index = participants.FindIndex(p => p == oldUsername);
                if (index >= 0)
                {
                    participants[index] = newUsername;
                    dm.Participants = participants;
                }
            }

            // 4. Обновляем реакции (если есть таблица Reactions)
            var reactions = await _db.Reactions.Where(r => r.UserId == oldUsername).ToListAsync();
            foreach (var reaction in reactions)
            {
                reaction.UserId = newUsername;
            }

            // 5. Удаляем старого пользователя
            _db.Users.Remove(user);
            await _db.SaveChangesAsync();

            // 6. Обновляем сессию
            if (Request.Cookies.TryGetValue("SESSION_ID", out var sessionId))
            {
                await _sessionService.DeleteSessionAsync(sessionId);
                var newSession = new SessionData
                {
                    Username = newUsername,
                    Role = newUser.Role
                };
                await _sessionService.CreateSessionAsync(newSession);

                // Обновляем cookie
                Response.Cookies.Delete("SESSION_ID");
                Response.Cookies.Append("SESSION_ID", sessionId, new CookieOptions
                {
                    HttpOnly = true,
                    SameSite = SameSiteMode.Strict,
                    Expires = DateTimeOffset.UtcNow.AddDays(7)
                });
            }

            await transaction.CommitAsync();

            return Ok(new { success = true, username = newUsername });
        }
        catch (Exception ex)
        {
            await transaction.RollbackAsync();
            Console.WriteLine($"Error updating username: {ex.Message}");
            return StatusCode(500, new { error = "Ошибка при смене имени. Пожалуйста, попробуйте позже." });
        }
    }

    // POST /api/users/settings/avatar
    [HttpPost("settings/avatar")]
    public async Task<IActionResult> UploadAvatar(IFormFile file)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        if (file == null || file.Length == 0)
            return BadRequest(new { error = "Файл не выбран" });

        // Проверяем размер файла (максимум 2MB)
        if (file.Length > 2 * 1024 * 1024)
            return BadRequest(new { error = "Файл слишком большой. Максимум 2MB" });

        // Проверяем тип файла
        var allowedTypes = new[] { "image/jpeg", "image/png", "image/gif", "image/webp" };
        if (!allowedTypes.Contains(file.ContentType))
            return BadRequest(new { error = "Разрешены только JPEG, PNG, GIF, WEBP" });

        var user = await _db.Users.FindAsync(session.Username);
        if (user == null) return NotFound(new { error = "User not found" });

        // Генерируем уникальное имя файла
        var fileExtension = Path.GetExtension(file.FileName).ToLowerInvariant();
        var fileName = $"{Guid.NewGuid()}{fileExtension}";

        // Создаем директорию для аватаров, если её нет
        var avatarsDir = Path.Combine(Directory.GetCurrentDirectory(), "wwwroot", "avatars");
        if (!Directory.Exists(avatarsDir))
            Directory.CreateDirectory(avatarsDir);

        // Сохраняем файл
        var filePath = Path.Combine(avatarsDir, fileName);
        using (var stream = new FileStream(filePath, FileMode.Create))
        {
            await file.CopyToAsync(stream);
        }

        // Удаляем старый аватар, если он существует и не является URL
        if (!string.IsNullOrEmpty(user.Avatar) && !user.Avatar.StartsWith("http") && !user.Avatar.StartsWith("/avatars/"))
        {
            var oldAvatarPath = Path.Combine(avatarsDir, Path.GetFileName(user.Avatar));
            if (System.IO.File.Exists(oldAvatarPath))
            {
                System.IO.File.Delete(oldAvatarPath);
            }
        }

        user.Avatar = $"/avatars/{fileName}";
        await _db.SaveChangesAsync();

        // Формируем полный URL для ответа
        var request = _httpContextAccessor.HttpContext.Request;
        var fullAvatarUrl = $"{request.Scheme}://{request.Host}/avatars/{fileName}";

        return Ok(new { success = true, avatarUrl = fullAvatarUrl });
    }

    // DELETE /api/users/settings/avatar
    [HttpDelete("settings/avatar")]
    public async Task<IActionResult> DeleteAvatar()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var user = await _db.Users.FindAsync(session.Username);
        if (user == null) return NotFound(new { error = "User not found" });

        // Удаляем файл аватара
        if (!string.IsNullOrEmpty(user.Avatar) && !user.Avatar.StartsWith("http"))
        {
            var avatarsDir = Path.Combine(Directory.GetCurrentDirectory(), "wwwroot", "avatars");
            var avatarPath = Path.Combine(avatarsDir, Path.GetFileName(user.Avatar));
            if (System.IO.File.Exists(avatarPath))
            {
                System.IO.File.Delete(avatarPath);
            }
        }

        user.Avatar = null;
        await _db.SaveChangesAsync();

        return Ok(new { success = true });
    }

    // Классы для запросов
    public class UpdateUsernameRequest
    {
        public string NewUsername { get; set; }
    }

    public class UpdateAvatarRequest
    {
        public string Avatar { get; set; }
    }
}
