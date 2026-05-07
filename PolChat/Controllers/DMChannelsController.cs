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
    IHttpContextAccessor _httpContextAccessor;

    public DMChannelsController(ChatDbContext db, ISessionService sessionService, IHubContext<ChatHub> hub, IHttpContextAccessor httpContextAccessor)
    {
        _db = db;
        _sessionService = sessionService;
        _hub = hub;
        _httpContextAccessor = httpContextAccessor;
    }

    private async Task<SessionData?> GetSession()
    {
        Request.Cookies.TryGetValue($"SESSION_ID_PORT_{_httpContextAccessor.HttpContext?.Connection.LocalPort}", out var sid);
        return await _sessionService.GetSessionAsync(sid);
    }

    // GET /api/dm_channels
    [HttpGet]
    public async Task<IActionResult> ListDMChannels()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });
        var username = session.Username;

        var existingUsers = (await _db.Users.Select(u => u.Username).ToListAsync()).ToHashSet();

        var dms = await _db.DmChannels.ToListAsync();
        var dtos = new List<DMChannelDto>();

        foreach (var dm in dms)
        {
            if (!dm.Participants.Contains(username)) continue;
            var otherUser = dm.Participants.FirstOrDefault(p => p != username);
            var isDeleted = string.IsNullOrEmpty(otherUser) || !existingUsers.Contains(otherUser);

            dtos.Add(new DMChannelDto
            {
                Id = dm.Id,
                Name = isDeleted ? Constants.DeletedUserDisplayName : (otherUser ?? Constants.DeletedUserDisplayName),
                OriginalName = otherUser,
                Participants = dm.Participants,
                CreatedBy = dm.CreatedBy,
                CreatedAt = dm.CreatedAt,
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

        var otherExists = await _db.Users.AnyAsync(u => u.Username == request.OtherUser);
        if (!otherExists) return NotFound(new { error = "User not found" });

        // Check if DM already exists
        var allDms = await _db.DmChannels.ToListAsync();
        var existing = allDms.FirstOrDefault(d =>
            d.Participants.Contains(username) && d.Participants.Contains(request.OtherUser));
        if (existing != null)
            return Conflict(new { error = "Already exists", dm_id = existing.Id });

        var dm = new DMChannel
        {
            Id = Guid.NewGuid().ToString(),
            Participants = new List<string> { username, request.OtherUser },
            CreatedBy = username,
            CreatedAt = DateTime.UtcNow
        };
        _db.DmChannels.Add(dm);
        await _db.SaveChangesAsync();

        // Broadcast dm_channel_created to participants
        await _hub.Clients.Group($"user_{username}").SendAsync("dm_channel_created");
        await _hub.Clients.Group($"user_{request.OtherUser}").SendAsync("dm_channel_created");

        return Ok(new
        {
            id = dm.Id,
            participants = dm.Participants,
            created_by = dm.CreatedBy,
            created_at = dm.CreatedAt
        });
    }

    // DELETE /api/dm_channels/{dmId}
    [HttpDelete("{dmId}")]
    public async Task<IActionResult> DeleteDMChannel(string dmId)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var dm = await _db.DmChannels.FindAsync(dmId);
        if (dm == null) return NotFound(new { error = "Not found" });

        if (!dm.Participants.Contains(session.Username))
            return StatusCode(403, new { error = "No permission" });

        _db.DmChannels.Remove(dm);
        var messages = _db.Messages.Where(m => m.ChannelId == dmId);
        _db.Messages.RemoveRange(messages);
        await _db.SaveChangesAsync();

        // Broadcast dm_channel_deleted to participants
        foreach (var p in dm.Participants)
        {
            await _hub.Clients.Group($"user_{p}").SendAsync("dm_channel_deleted");
        }

        return Ok(new { success = true });
    }
}
