using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using ChatApp.Data;
using ChatApp.Hubs;
using ChatApp.Models;
using ChatApp.Services;

namespace ChatApp.Controllers;

[ApiController]
//[Route("api/[controller]")]
[Route("api/dm_channels")]
public class DMChannelsController : ControllerBase
{
    private readonly ChatDbContext _db;
    private readonly ISessionService _sessionService;
    private readonly IHubContext<ChatHub> _hub;

    public DMChannelsController(ChatDbContext db, ISessionService sessionService, IHubContext<ChatHub> hub)
    {
        _db = db;
        _sessionService = sessionService;
        _hub = hub;
    }

    private async Task<SessionData?> GetSession()
    {
        Request.Cookies.TryGetValue("SESSION_ID", out var sid);
        return await _sessionService.GetSessionAsync(sid);
    }

    // GET /api/dm_channels
    [HttpGet]
    public async Task<IActionResult> ListDMChannels()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });
        var username = session.Username;

        var existingUsers = (await _db.users.Select(u => u.username).ToListAsync()).ToHashSet();

        var dms = await _db.dm_channels.ToListAsync();
        var dtos = new List<DMChannelDto>();

        foreach (var dm in dms)
        {
            if (!dm.participants.Contains(username)) continue;
            var otherUser = dm.participants.FirstOrDefault(p => p != username);
            var isDeleted = string.IsNullOrEmpty(otherUser) || !existingUsers.Contains(otherUser);

            dtos.Add(new DMChannelDto
            {
                Id = dm.id,
                Name = isDeleted ? Constants.DeletedUserDisplayName : (otherUser ?? Constants.DeletedUserDisplayName),
                OriginalName = otherUser,
                Participants = dm.participants,
                CreatedBy = dm.created_by,
                CreatedAt = dm.created_at,
                IsDeleted = isDeleted
            });
        }

        return Ok(dtos);
    }

    // POST /api/dm_channels
    [HttpPost]
    public async Task<IActionResult> CreateDMChannel([FromBody] CreateDMChannelRequest request)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });
        var username = session.Username;

        if (string.IsNullOrEmpty(request.OtherUser) || request.OtherUser == username)
            return BadRequest(new { error = "Invalid user" });

        var otherExists = await _db.users.AnyAsync(u => u.username == request.OtherUser);
        if (!otherExists) return NotFound(new { error = "User not found" });

        // Check if DM already exists
        var allDms = await _db.dm_channels.ToListAsync();
        var existing = allDms.FirstOrDefault(d =>
            d.participants.Contains(username) && d.participants.Contains(request.OtherUser));
        if (existing != null)
            return Conflict(new { error = "Already exists", dm_id = existing.id });

        var dm = new DMChannel
        {
            id = Guid.NewGuid().ToString(),
            participants = new List<string> { username, request.OtherUser },
            created_by = username,
            created_at = DateTime.UtcNow
        };
        _db.dm_channels.Add(dm);
        await _db.SaveChangesAsync();

        // Broadcast dm_channel_created to participants
        await _hub.Clients.Group($"user_{username}").SendAsync("dm_channel_created");
        await _hub.Clients.Group($"user_{request.OtherUser}").SendAsync("dm_channel_created");

        return Ok(new
        {
            id = dm.id,
            participants = dm.participants,
            created_by = dm.created_by,
            created_at = dm.created_at
        });
    }

    // DELETE /api/dm_channels/{dmId}
    [HttpDelete("{dmId}")]
    public async Task<IActionResult> DeleteDMChannel(string dmId)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var dm = await _db.dm_channels.FindAsync(dmId);
        if (dm == null) return NotFound(new { error = "Not found" });

        if (!dm.participants.Contains(session.Username))
            return StatusCode(403, new { error = "No permission" });

        _db.dm_channels.Remove(dm);
        var messages = _db.messages.Where(m => m.channel_id == dmId);
        _db.messages.RemoveRange(messages);
        await _db.SaveChangesAsync();

        // Broadcast dm_channel_deleted to participants
        foreach (var p in dm.participants)
        {
            await _hub.Clients.Group($"user_{p}").SendAsync("dm_channel_deleted");
        }

        return Ok(new { success = true });
    }
}
