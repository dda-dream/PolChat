using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using ChatApp.Data;
using ChatApp.Hubs;
using ChatApp.Models;
using ChatApp.Services;

namespace ChatApp.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ChannelsController : ControllerBase
{
    private readonly ChatDbContext _db;
    private readonly ISessionService _sessionService;
    private readonly IHubContext<ChatHub> _hub;

    public ChannelsController(ChatDbContext db, ISessionService sessionService, IHubContext<ChatHub> hub)
    {
        _db = db;
        _sessionService = sessionService;
        _hub = hub;
    }

    private async Task<SessionData?> GetSession()
    {
        Request.Cookies.TryGetValue($"SESSION_ID_PORT_{Request.Host.Port}", out var sid);
        return await _sessionService.GetSessionAsync(sid);
    }

    private static ChannelDto ToChannelDto(Channel ch, HashSet<string> existingUsers)
    {
        var creator = ch.created_by;
        return new ChannelDto
        {
            Id = ch.id,
            Name = ch.name,
            Description = ch.description,
            CreatedBy = ch.created_by,
            CreatedByDisplay = (!string.IsNullOrEmpty(creator) && existingUsers.Contains(creator)) ? creator : Constants.DeletedUserDisplayName,
            CreatedByDeleted = string.IsNullOrEmpty(creator) || !existingUsers.Contains(creator),
            CreatedAt = ch.created_at,
            IsPrivate = ch.is_private
        };
    }

    // GET /api/channels
    [HttpGet]
    public async Task<IActionResult> ListChannels()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var channels = await _db.channels.OrderBy(c => c.created_at).ToListAsync();
        var existingUsers = (await _db.users.Select(u => u.username).ToListAsync()).ToHashSet();
        var dtos = channels.Select(c => ToChannelDto(c, existingUsers)).ToList();
        return Ok(dtos);
    }

    // POST /api/channels
    [HttpPost]
    public async Task<IActionResult> CreateChannel([FromBody] CreateChannelRequest request)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var name = HtmlSanitizer.Sanitize(request.Name);
        var description = HtmlSanitizer.Sanitize(request.Description);

        var existing = await _db.channels.FirstOrDefaultAsync(c => c.name == name);
        if (existing != null) return BadRequest(new { error = "Already exists" });

        var channel = new Channel
        {
            id = Guid.NewGuid().ToString(),
            name = name,
            description = description,
            created_by = session.Username,
            created_at = DateTime.UtcNow,
            is_private = request.IsPrivate
        };
        _db.channels.Add(channel);
        await _db.SaveChangesAsync();

        var existingUsers = (await _db.users.Select(u => u.username).ToListAsync()).ToHashSet();

        // Broadcast channel_created to all users
        await _hub.Clients.All.SendAsync("channel_created");

        return Ok(ToChannelDto(channel, existingUsers));
    }

    // DELETE /api/channels/{channelId}
    [HttpDelete("{channelId}")]
    public async Task<IActionResult> DeleteChannel(string channelId)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var channel = await _db.channels.FindAsync(channelId);
        if (channel == null) return NotFound(new { error = "Not found" });

        if (channel.name == Constants.GeneralChannelName)
            return BadRequest(new { error = "Cannot delete general" });

        if (session.Role != "admin" && channel.created_by != session.Username)
            return StatusCode(403, new { error = "No permission" });

        _db.channels.Remove(channel);
        var messages = _db.messages.Where(m => m.channel_id == channelId);
        _db.messages.RemoveRange(messages);
        await _db.SaveChangesAsync();

        // Broadcast channel_deleted to all users
        await _hub.Clients.All.SendAsync("channel_deleted");

        return Ok(new { success = true });
    }

    // PUT /api/channels/{channelId}/rename
    [HttpPut("{channelId}/rename")]
    public async Task<IActionResult> RenameChannel(string channelId, [FromBody] RenameChannelRequest request)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var newName = HtmlSanitizer.Sanitize(request.Name).Trim();
        if (string.IsNullOrEmpty(newName) || newName.Length > 50)
            return BadRequest(new { error = "Название должно быть от 1 до 50 символов" });

        var channel = await _db.channels.FindAsync(channelId);
        if (channel == null) return NotFound(new { error = "Канал не найден" });

        if (channel.name == Constants.GeneralChannelName)
            return StatusCode(403, new { error = "Нельзя переименовать общий канал" });

        if (session.Role != "admin" && channel.created_by != session.Username)
            return StatusCode(403, new { error = "Нет прав" });

        var existing = await _db.channels.FirstOrDefaultAsync(c => c.name == newName && c.id != channelId);
        if (existing != null) return BadRequest(new { error = "Канал с таким названием уже существует" });

        var oldName = channel.name;
        channel.name = newName;
        await _db.SaveChangesAsync();

        // Broadcast channel_renamed
        await _hub.Clients.All.SendAsync("channel_renamed", new { channelId, newName });

        return Ok(new { success = true, new_name = newName });
    }

    // PUT /api/channels/{channelId}/description
    [HttpPut("{channelId}/description")]
    public async Task<IActionResult> UpdateDescription(string channelId, [FromBody] UpdateDescriptionRequest request)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var newDescription = HtmlSanitizer.Sanitize(request.Description).Trim();
        if (newDescription != null && newDescription.Length > 500)
            return BadRequest(new { error = "Описание не должно превышать 500 символов" });

        var channel = await _db.channels.FindAsync(channelId);
        if (channel == null) return NotFound(new { error = "Канал не найден" });

        if (channel.name == Constants.GeneralChannelName)
            return StatusCode(403, new { error = "Нельзя изменить описание общего канала" });

        if (session.Role != "admin" && channel.created_by != session.Username)
            return StatusCode(403, new { error = "Нет прав" });

        channel.description = newDescription;
        await _db.SaveChangesAsync();

        // Broadcast channel_description_updated
        await _hub.Clients.All.SendAsync("channel_description_updated", new { channelId, newDescription });

        return Ok(new { success = true, new_description = newDescription });
    }
}
