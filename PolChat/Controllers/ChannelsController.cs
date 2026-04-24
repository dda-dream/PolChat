using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using ChatApp.Data;
using ChatApp.Models;
using ChatApp.Services;

namespace ChatApp.Controllers;

[ApiController]
[Route("api/[controller]")]
public class ChannelsController : ControllerBase
{
    private readonly ChatDbContext _db;
    private readonly ISessionService _sessionService;

    public ChannelsController(ChatDbContext db, ISessionService sessionService)
    {
        _db = db;
        _sessionService = sessionService;
    }

    private async Task<SessionData?> GetSession()
    {
        Request.Cookies.TryGetValue("SESSION_ID", out var sid);
        return await _sessionService.GetSessionAsync(sid);
    }

    private static ChannelDto ToChannelDto(Channel ch, HashSet<string> existingUsers)
    {
        var creator = ch.CreatedBy;
        return new ChannelDto
        {
            Id = ch.Id,
            Name = ch.Name,
            Description = ch.Description,
            CreatedBy = ch.CreatedBy,
            CreatedByDisplay = (!string.IsNullOrEmpty(creator) && existingUsers.Contains(creator)) ? creator : Constants.DeletedUserDisplayName,
            CreatedByDeleted = string.IsNullOrEmpty(creator) || !existingUsers.Contains(creator),
            CreatedAt = ch.CreatedAt,
            IsPrivate = ch.IsPrivate
        };
    }

    // GET /api/channels
    [HttpGet]
    public async Task<IActionResult> ListChannels()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var channels = await _db.Channels.OrderBy(c => c.CreatedAt).ToListAsync();
        var existingUsers = (await _db.users.Select(u => u.Username).ToListAsync()).ToHashSet();
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

        var existing = await _db.Channels.FirstOrDefaultAsync(c => c.Name == name);
        if (existing != null) return BadRequest(new { error = "Already exists" });

        var channel = new Channel
        {
            Id = Guid.NewGuid().ToString(),
            Name = name,
            Description = description,
            CreatedBy = session.Username,
            CreatedAt = DateTime.UtcNow,
            IsPrivate = request.IsPrivate
        };
        _db.Channels.Add(channel);
        await _db.SaveChangesAsync();

        var existingUsers = (await _db.users.Select(u => u.Username).ToListAsync()).ToHashSet();
        return Ok(ToChannelDto(channel, existingUsers));
    }

    // DELETE /api/channels/{channelId}
    [HttpDelete("{channelId}")]
    public async Task<IActionResult> DeleteChannel(string channelId)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var channel = await _db.Channels.FindAsync(channelId);
        if (channel == null) return NotFound(new { error = "Not found" });

        if (channel.Name == Constants.GeneralChannelName)
            return BadRequest(new { error = "Cannot delete general" });

        if (session.Role != "admin" && channel.CreatedBy != session.Username)
            return StatusCode(403, new { error = "No permission" });

        _db.Channels.Remove(channel);
        var messages = _db.Messages.Where(m => m.ChannelId == channelId);
        _db.Messages.RemoveRange(messages);
        await _db.SaveChangesAsync();

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

        var channel = await _db.Channels.FindAsync(channelId);
        if (channel == null) return NotFound(new { error = "Канал не найден" });

        if (channel.Name == Constants.GeneralChannelName)
            return StatusCode(403, new { error = "Нельзя переименовать общий канал" });

        if (session.Role != "admin" && channel.CreatedBy != session.Username)
            return StatusCode(403, new { error = "Нет прав" });

        var existing = await _db.Channels.FirstOrDefaultAsync(c => c.Name == newName && c.Id != channelId);
        if (existing != null) return BadRequest(new { error = "Канал с таким названием уже существует" });

        var oldName = channel.Name;
        channel.Name = newName;
        await _db.SaveChangesAsync();

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

        var channel = await _db.Channels.FindAsync(channelId);
        if (channel == null) return NotFound(new { error = "Канал не найден" });

        if (channel.Name == Constants.GeneralChannelName)
            return StatusCode(403, new { error = "Нельзя изменить описание общего канала" });

        if (session.Role != "admin" && channel.CreatedBy != session.Username)
            return StatusCode(403, new { error = "Нет прав" });

        channel.Description = newDescription;
        await _db.SaveChangesAsync();

        return Ok(new { success = true, new_description = newDescription });
    }
}
