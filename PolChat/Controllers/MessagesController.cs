using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using ChatApp.Data;
using ChatApp.Hubs;
using ChatApp.Models;
using ChatApp.Services;

namespace ChatApp.Controllers;

[ApiController]
public class MessagesController : ControllerBase
{
    private readonly ChatDbContext _db;
    private readonly ISessionService _sessionService;
    private readonly IHubContext<ChatHub> _hub;
    IHttpContextAccessor _httpContextAccessor;

    public MessagesController(ChatDbContext db, ISessionService sessionService, IHubContext<ChatHub> hub, IHttpContextAccessor httpContextAccessor)
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

    // GET /api/initial_data
    [HttpGet("/api/initial_data")]
    public async Task<IActionResult> InitialData()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });
        var username = session.Username;

        var channels = await _db.channels.OrderBy(c => c.CreatedAt).ToListAsync();
        var existingUsers = (await _db.users.Select(u => u.Username).ToListAsync()).ToHashSet();

        var channelDtos = channels.Select(ch => new ChannelDto
        {
            Id = ch.Id,
            Name = ch.Name,
            Description = ch.Description,
            CreatedBy = ch.CreatedBy,
            CreatedByDisplay = (!string.IsNullOrEmpty(ch.CreatedBy) && existingUsers.Contains(ch.CreatedBy)) ? ch.CreatedBy : Constants.DeletedUserDisplayName,
            CreatedByDeleted = string.IsNullOrEmpty(ch.CreatedBy) || !existingUsers.Contains(ch.CreatedBy),
            CreatedAt = ch.CreatedAt,
            IsPrivate = ch.IsPrivate
        }).ToList();

        // DM channels
        var dmRows = await _db.dm_channels.ToListAsync();
        var dmDtos = new List<DMChannelDto>();
        foreach (var dm in dmRows)
        {
            if (!dm.Participants.Contains(username)) continue;
            var otherUser = dm.Participants.FirstOrDefault(p => p != username);
            var isDeleted = string.IsNullOrEmpty(otherUser) || !existingUsers.Contains(otherUser);

            dmDtos.Add(new DMChannelDto
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

        // Unread counts
        var unreadCounts = await GetRealUnreadCounts(username);

        return Ok(new InitialDataResponse
        {
            Channels = channelDtos,
            DMChannels = dmDtos,
            Users = users,
            UnreadCounts = unreadCounts
        });
    }

    // GET /api/messages/{channelId}
    [HttpGet("/api/messages/{channelId}")]
    public async Task<IActionResult> GetMessages(string channelId, [FromQuery] int page = 1, [FromQuery] int limit = 50)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var offset = (page - 1) * limit;
        var existingUsers = (await _db.users.Select(u => u.Username).ToListAsync()).ToHashSet();

        var totalCount = await _db.messages.CountAsync(m => m.channel_id == channelId);

        var rows = await _db.messages
            .Where(m => m.channel_id == channelId)
            .OrderByDescending(m => m.timestamp)
            .Skip(offset)
            .Take(limit)
            .ToListAsync();
        rows.Reverse();

        var replyToIds = rows.Where(r => r.reply_to_id != null).Select(r => r.reply_to_id!).Distinct().ToList();
        var replyMessages = new Dictionary<string, Message>();
        if (replyToIds.Count > 0)
        {
            var replyRows = await _db.messages.Where(m => replyToIds.Contains(m.id)).ToListAsync();
            foreach (var rr in replyRows) replyMessages[rr.id] = rr;
        }

        var messages = new List<MessageDto>();
        foreach (var row in rows)
        {
            var senderExists = existingUsers.Contains(row.username);
            var msg = new MessageDto
            {
                Id = row.id,
                ChannelId = row.channel_id,
                Username = senderExists ? row.username : Constants.DeletedUserDisplayName,
                Content = row.content,
                FileUrl = row.file_url,
                Timestamp = row.timestamp.ToString("O"),
                Edited = row.edited,
                //TODO: FIX IT LATER
                EditedAt = row.edited_at,//row.EditedAt?.ToString("O"),
                Reactions = row.reactions ?? new List<Reaction>(),
                ReadBy = row.read_by ?? Array.Empty<string>(),
                DeliveredTo = row.delivered_to ?? new List<string>(),
                IsDeletedSender = !senderExists
            };

            if (row.reply_to_id != null && replyMessages.TryGetValue(row.reply_to_id, out var rm))
            {
                var ru = rm.username;
                msg.ReplyTo = new ReplyToInfo
                {
                    Id = rm.id,
                    Username = existingUsers.Contains(ru) ? ru : Constants.DeletedUserDisplayName,
                    Content = rm.content ?? "",
                    FileUrl = rm.file_url,
                    IsDeleted = !existingUsers.Contains(ru)
                };
            }

            messages.Add(msg);
        }

        return Ok(new MessagesResponse
        {
            Messages = messages,
            Pagination = new PaginationInfo
            {
                Page = page,
                Limit = limit,
                Total = totalCount,
                HasMore = offset + limit < totalCount
            }
        });
    }

    // PUT /api/messages/{messageId}
    [HttpPut("/api/messages/{messageId}")]
    public async Task<IActionResult> EditMessage(string messageId, [FromBody] EditMessageRequest request)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var newContent = HtmlSanitizer.Sanitize(request.Content);

        var msg = await _db.messages.FindAsync(messageId);
        if (msg == null || msg.username != session.Username)
            return StatusCode(403, new { error = "No permission" });

        msg.content = newContent;
        msg.edited = true;
        msg.edited_at = DateTime.UtcNow;
        await _db.SaveChangesAsync();

        // Broadcast edit to channel
        await _hub.Clients.Group(msg.channel_id).SendAsync("message_edited", new { id = messageId, content = newContent });

        return Ok(new { success = true });
    }

    // DELETE /api/messages/{messageId}
    [HttpDelete("/api/messages/{messageId}")]
    public async Task<IActionResult> DeleteMessage(string messageId)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var msg = await _db.messages.FindAsync(messageId);
        if (msg == null) return NotFound(new { error = "Not found" });

        if (msg.username != session.Username && session.Role != "admin")
            return StatusCode(403, new { error = "No permission" });

        var channelId = msg.channel_id;
        _db.messages.Remove(msg);
        await _db.SaveChangesAsync();

        // Broadcast delete to channel
        await _hub.Clients.Group(channelId).SendAsync("message_deleted", new { id = messageId });

        return Ok(new { success = true });
    }

    // POST /api/unread/{channelId}/read
    [HttpPost("/api/unread/{channelId}/read")]
    public async Task<IActionResult> MarkChannelRead(string channelId)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var username = session.Username;

        await _db.Database.ExecuteSqlRawAsync(@"
            UPDATE messages SET read_by = array_append(read_by, {0})
            WHERE channel_id = {1} AND username != {2} AND NOT ({2} = ANY(read_by))
            RETURNING id",
            username, channelId, username);

        var unreadCounts = await GetRealUnreadCounts(username);
        return Ok(new { success = true, unread_counts = unreadCounts });
    }

    // POST /api/messages/{messageId}/read
    [HttpPost("/api/messages/{messageId}/read")]
    public async Task<IActionResult> MarkMessageRead(string messageId)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var username = session.Username;

        var msg = await _db.messages
            .Where(m => m.id == messageId)
            .Select(m => new { m.channel_id, m.username })
            .FirstOrDefaultAsync();

        if (msg == null) return NotFound(new { success = false, error = "Not found" });
        if (msg.username == username) return Ok(new { success = true, message = "Cannot read own" });

        await _db.Database.ExecuteSqlRawAsync(@"
            UPDATE messages SET read_by = array_append(read_by, {0})
            WHERE id = {1} AND NOT ({0} = ANY(read_by))",
            username, messageId);

        // Broadcast read event
        await _hub.Clients.Group(msg.channel_id).SendAsync("message_read", 
                new { messageId, readBy = username, channelId = msg.channel_id });

        return Ok(new { success = true });
    }

    // GET /api/unread
    [HttpGet("/api/unread")]
    public async Task<IActionResult> GetUnreadCounts()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var counts = await GetRealUnreadCounts(session.Username);
        return Ok(counts);
    }

    // GET /api/messages/{channelId}/status
    [HttpGet("/api/messages/{channelId}/status")]
    public async Task<IActionResult> GetMessageStatuses(string channelId)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var rows = await _db.messages
            .Where(m => m.channel_id == channelId && m.username == session.Username)
            .Select(m => new { m.id, m.read_by, m.delivered_to })
            .ToListAsync();

        var statuses = new Dictionary<string, object>();
        foreach (var r in rows)
        {
            statuses[r.id] = new
            {
                delivered = (r.delivered_to?.Count ?? 0) > 0,
                read = (r.read_by?.Length ?? 0) > 0
            };
        }
        return Ok(statuses);
    }

    // GET /api/message/{messageId}/read_status
    [HttpGet("/api/message/{messageId}/read_status")]
    public async Task<IActionResult> GetMessageReadStatus(string messageId)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var msg = await _db.messages.Where(m => m.id == messageId).Select(m => m.read_by).FirstOrDefaultAsync();
        var readBy = msg ?? Array.Empty<string>(); ;
        return Ok(new { read_by = readBy, read_count = readBy });
    }

    private async Task<Dictionary<string, int>> GetRealUnreadCounts(string username)
    {
        var conn = _db.Database.GetDbConnection();
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            SELECT m.channel_id, COUNT(*) as unread_count
            FROM messages m
            LEFT JOIN channels c ON c.id = m.channel_id
            LEFT JOIN dm_channels d ON d.id = m.channel_id
            WHERE m.username != @username 
            AND NOT (@username = ANY(m.read_by))
            AND (
                (c.id IS NOT NULL AND c.is_private = FALSE)  
                OR (d.id IS NOT NULL AND @username = ANY(d.participants))  
            )
            GROUP BY m.channel_id";
        var p = cmd.CreateParameter();
        p.ParameterName = "username";
        p.Value = username;
        cmd.Parameters.Add(p);

        var result = new Dictionary<string, int>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            result[reader.GetString(0)] = reader.GetInt32(1);
        }
        return result;
    }
}
