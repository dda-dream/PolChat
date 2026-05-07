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

    // GET /api/messages/{channelId}/since
    [HttpGet("/api/messages/{channelId}/since")]
    public async Task<IActionResult> GetMessagesSince(
        string channelId,
        [FromQuery] string timestamp,
        [FromQuery] int limit = 100)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized();

        if (!DateTime.TryParse(timestamp, out var sinceTime))
        {
            return BadRequest(new { error = "Invalid timestamp format" });
        }

        // Приводим к UTC для корректного сравнения с БД
        var sinceTimeUtc = sinceTime.Kind == DateTimeKind.Utc ? sinceTime : sinceTime.ToUniversalTime();

        // Получаем сообщения после указанного времени
        var messages = await _db.Messages
            .Where(m => m.ChannelId == channelId && m.Timestamp > sinceTimeUtc)
            .OrderBy(m => m.Timestamp)
            .Take(limit)
            .ToListAsync();

        // Форматируем и возвращаем
        var existingUsers = (await _db.Users.Select(u => u.Username).ToListAsync()).ToHashSet();

        var messageDtos = messages.Select(row =>
        {
            var senderExists = existingUsers.Contains(row.Username);
            var msg = new MessageDto
            {
                Id = row.Id,
                ChannelId = row.ChannelId,
                Username = senderExists ? row.Username : Constants.DeletedUserDisplayName,
                Content = row.Content,
                FileUrl = row.FileUrl,
                Timestamp = row.Timestamp.ToString("O"), // ISO 8601 format
                Edited = row.Edited,
                EditedAt = row.EditedAt,
                Reactions = row.Reactions ?? new List<ReactionInMessage>(),
                ReadBy = row.ReadBy ?? Array.Empty<string>(),
                DeliveredTo = row.DeliveredTo ?? new List<string>(),
                IsDeletedSender = !senderExists
            };

            return msg;
        }).ToList();

        return Ok(new
        {
            messages = messageDtos,
            count = messageDtos.Count,
            hasMore = messages.Count >= limit
        });
    }

    // GET /api/initial_data
    [HttpGet("/api/initial_data")]
    public async Task<IActionResult> InitialData()
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });
        var username = session.Username;

        var channels = await _db.Channels.OrderBy(c => c.CreatedAt).ToListAsync();
        var existingUsers = (await _db.Users.Select(u => u.Username).ToListAsync()).ToHashSet();

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
        var dmRows = await _db.DmChannels.ToListAsync();
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
        var existingUsers = (await _db.Users.Select(u => u.Username).ToListAsync()).ToHashSet();

        var totalCount = await _db.Messages.CountAsync(m => m.ChannelId == channelId);

        var rows = await _db.Messages
            .Where(m => m.ChannelId == channelId)
            .OrderByDescending(m => m.Timestamp)
            .Skip(offset)
            .Take(limit)
            .ToListAsync();
        rows.Reverse();

        var replyToIds = rows.Where(r => r.ReplyToId != null).Select(r => r.ReplyToId!).Distinct().ToList();
        var replyMessages = new Dictionary<string, Message>();
        if (replyToIds.Count > 0)
        {
            var replyRows = await _db.Messages.Where(m => replyToIds.Contains(m.Id)).ToListAsync();
            foreach (var rr in replyRows) replyMessages[rr.Id] = rr;
        }

        var messages = new List<MessageDto>();
        foreach (var row in rows)
        {
            var senderExists = existingUsers.Contains(row.Username);
            var msg = new MessageDto
            {
                Id = row.Id,
                ChannelId = row.ChannelId,
                Username = senderExists ? row.Username : Constants.DeletedUserDisplayName,
                Content = row.Content,
                FileUrl = row.FileUrl,
                Timestamp = row.Timestamp.ToString("O"),
                Edited = row.Edited,
                EditedAt = row.EditedAt,
                Reactions = row.Reactions ?? new List<ReactionInMessage>(),
                ReadBy = row.ReadBy ?? Array.Empty<string>(),
                DeliveredTo = row.DeliveredTo ?? new List<string>(),
                IsDeletedSender = !senderExists
            };

            if (row.ReplyToId != null && replyMessages.TryGetValue(row.ReplyToId, out var rm))
            {
                var ru = rm.Username;
                msg.ReplyTo = new ReplyToInfo
                {
                    Id = rm.Id,
                    Username = existingUsers.Contains(ru) ? ru : Constants.DeletedUserDisplayName,
                    Content = rm.Content ?? "",
                    FileUrl = rm.FileUrl,
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

        var msg = await _db.Messages.FindAsync(messageId);
        if (msg == null || msg.Username != session.Username)
            return StatusCode(403, new { error = "No permission" });

        msg.Content = newContent;
        msg.Edited = true;
        msg.EditedAt = DateTime.UtcNow; // Используем UTC
        await _db.SaveChangesAsync();

        // Broadcast edit to channel
        await _hub.Clients.Group(msg.ChannelId).SendAsync("message_edited", new { id = messageId, content = newContent });

        return Ok(new { success = true });
    }

    // DELETE /api/messages/{messageId}
    [HttpDelete("/api/messages/{messageId}")]
    public async Task<IActionResult> DeleteMessage(string messageId)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var msg = await _db.Messages.FindAsync(messageId);
        if (msg == null) return NotFound(new { error = "Not found" });

        if (msg.Username != session.Username && session.Role != "admin")
            return StatusCode(403, new { error = "No permission" });

        var channelId = msg.ChannelId;
        _db.Messages.Remove(msg);
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

        // Обновляем счетчики непрочитанных
        var unreadCounts = await GetRealUnreadCounts(username);

        // Отправляем обновление через SignalR всем клиентам пользователя
        await _hub.Clients.User(username).SendAsync("unread_counts_updated", unreadCounts);

        return Ok(new { success = true, unread_counts = unreadCounts });
    }

    // POST /api/messages/{messageId}/read
    [HttpPost("/api/messages/{messageId}/read")]
    public async Task<IActionResult> MarkMessageRead(string messageId)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var username = session.Username;

        var msg = await _db.Messages
            .Where(m => m.Id == messageId)
            .Select(m => new { m.ChannelId, m.Username })
            .FirstOrDefaultAsync();

        if (msg == null) return NotFound(new { success = false, error = "Not found" });
        if (msg.Username == username) return Ok(new { success = true, message = "Cannot read own" });

        await _db.Database.ExecuteSqlRawAsync(@"
            UPDATE messages SET read_by = array_append(read_by, {0})
            WHERE id = {1} AND NOT ({0} = ANY(read_by))",
            username, messageId);

        // Broadcast read event
        await _hub.Clients.Group(msg.ChannelId).SendAsync("message_read",
                new { messageId, readBy = username, channelId = msg.ChannelId });

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

        var rows = await _db.Messages
            .Where(m => m.ChannelId == channelId && m.Username == session.Username)
            .Select(m => new { m.Id, m.ReadBy, m.DeliveredTo })
            .ToListAsync();

        var statuses = new Dictionary<string, object>();
        foreach (var r in rows)
        {
            statuses[r.Id] = new
            {
                delivered = (r.DeliveredTo?.Count ?? 0) > 0,
                read = (r.ReadBy?.Length ?? 0) > 0
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

        var msg = await _db.Messages.Where(m => m.Id == messageId).Select(m => m.ReadBy).FirstOrDefaultAsync();
        var readBy = msg ?? Array.Empty<string>();
        return Ok(new { read_by = readBy, read_count = readBy.Length });
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

    // GET /api/messages/item/{messageId}
    [HttpGet("/api/messages/item/{messageId}")]
    public async Task<IActionResult> GetMessageById(string messageId)
    {
        var session = await GetSession();
        if (session == null) return Unauthorized(new { error = "Not authenticated" });

        var existingUsers = (await _db.Users.Select(u => u.Username).ToListAsync()).ToHashSet();

        var message = await _db.Messages
            .Where(m => m.Id == messageId)
            .FirstOrDefaultAsync();

        if (message == null)
            return NotFound(new { error = "Message not found" });

        var senderExists = existingUsers.Contains(message.Username);

        // Загружаем реакции (если они хранятся как JSON)
        // У вас в модели Message есть поле Reactions типа List<Reaction>
        var reactions = message.Reactions ?? new List<ReactionInMessage>();

        var msgDto = new
        {
            id = message.Id,
            channelId = message.ChannelId,
            username = senderExists ? message.Username : Constants.DeletedUserDisplayName,
            content = message.Content,
            fileUrl = message.FileUrl,
            timestamp = message.Timestamp.ToString("O"),
            edited = message.Edited,
            editedAt = message.EditedAt,
            reactions = reactions.Select(r => new
            {
                emoji = r.Emoji,
                users = r.Users ?? new List<string>()
            }).ToList(),
            readBy = message.ReadBy ?? Array.Empty<string>(),
            deliveredTo = message.DeliveredTo ?? new List<string>(),
            isDeletedSender = !senderExists
        };

        return Ok(msgDto);
    }
}