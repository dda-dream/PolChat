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
        Request.Cookies.TryGetValue("SESSION_ID", out var sid);
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
}
