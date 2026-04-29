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
        Request.Cookies.TryGetValue($"SESSION_ID_PORT_{_httpContextAccessor.HttpContext?.Connection.LocalPort}", out var sid);
        return await _sessionService.GetSessionAsync(sid);
    }

    // GET /api/users
    [HttpGet]
    public async Task<IActionResult> ListUsers()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var users = await _db.users
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

        var user = await _db.users.FindAsync(username);
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

        var user = await _db.users.FindAsync(username);
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

        var user = await _db.users.FindAsync(username);
        if (user == null) return NotFound(new { error = "User not found" });

        _db.users.Remove(user);
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

        var user = await _db.users.FindAsync(username);
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

        var user = await _db.users.FindAsync(session.Username);
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
}
