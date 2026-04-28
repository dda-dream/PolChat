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

    public UsersController(ChatDbContext db, ISessionService sessionService)
    {
        _db = db;
        _sessionService = sessionService;
    }

    private async Task<SessionData?> GetSession()
    {
        Request.Cookies.TryGetValue($"SESSION_ID_PORT_{Request.Host.Port}", out var sid);
        return await _sessionService.GetSessionAsync(sid);
    }

    // GET /api/users
    [HttpGet]
    public async Task<IActionResult> ListUsers()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var users = await _db.users
            .Where(u => u.username != null)
            .Select(u => new UserDto
            {
                Username = u.username,
                Role = u.role,
                Status = u.status,
                LastSeen = u.last_seen,
                CreatedAt = u.created_at,
                Avatar = u.avatar,
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

        user.status = request.Status;
        user.last_seen = now;
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

        user.role = request.Role;
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

        user.last_seen = now;
        if (user.status == "away")
        {
            user.status = "online";
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
            username = user.username,
            role = user.role,
            status = user.status,
            avatar = user.avatar,
            createdAt = user.created_at,
            lastSeen = user.last_seen
        });
    }
}
