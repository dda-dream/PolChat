using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using ChatApp.Data;
using ChatApp.Models;
using ChatApp.Services;
using System.Text.Json;

namespace ChatApp.Hubs;

public class ChatHub : Hub
{
    private readonly ChatDbContext _db;
    private readonly ISessionService _sessionService;
    private readonly ILogger<ChatHub> _logger;

    // Track connections: ConnectionId -> SessionData
    private static readonly Dictionary<string, SessionData> _connections = new();

    public ChatHub(ChatDbContext db, ISessionService sessionService, ILogger<ChatHub> logger)
    {
        _db = db;
        _sessionService = sessionService;
        _logger = logger;
    }

    public override async Task OnConnectedAsync()
    {
        var session = await GetSessionFromContext();
        if (session == null)
        {
            Context.Abort();
            return;
        }

        _connections[Context.ConnectionId] = session;
        var username = session.Username;

        await Groups.AddToGroupAsync(Context.ConnectionId, "all_users");
        await Groups.AddToGroupAsync(Context.ConnectionId, $"user_{username}");

        _logger.LogInformation("[WS] + {Username}", username);

        // Update user status to online
        var now = DateTime.UtcNow;
        await _db.users
            .Where(u => u.Username == username)
            .ExecuteUpdateAsync(s => s
                .SetProperty(u => u.Status, "online")
                .SetProperty(u => u.LastSeen, now));

        await Clients.All.SendAsync("user_status", new
        {
            username,
            status = "online",
            last_seen = now.ToString("O")
        });

        // Check pending deliveries for DM channels using ADO.NET (JOIN query)
        var conn = _db.Database.GetDbConnection();
        await conn.OpenAsync();
        await using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
                SELECT m.id, m.channel_id, m.username FROM messages m
                JOIN dm_channels d ON m.channel_id = d.id
                WHERE @username = ANY(d.participants)
                AND m.username != @username
                AND NOT (@username = ANY(m.delivered_to))
                AND NOT (@username = ANY(m.read_by))";
            var p = cmd.CreateParameter();
            p.ParameterName = "username";
            p.Value = username;
            cmd.Parameters.Add(p);

            await using var reader = await cmd.ExecuteReaderAsync();
            var pendingList = new List<(string Id, string ChannelId, string MsgUsername)>();
            while (await reader.ReadAsync())
            {
                pendingList.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2)));
            }

            if (pendingList.Count > 0)
            {
                var ids = pendingList.Select(p => p.Id).ToList();

                // Mark as delivered
                await _db.Database.ExecuteSqlRawAsync(@"
                    UPDATE messages SET delivered_to = array_append(delivered_to, {0})
                    WHERE id = ANY({1}) AND NOT ({0} = ANY(delivered_to))",
                    username, ids);

                // Notify senders
                foreach (var msg in pendingList)
                {
                    await Clients.Group($"user_{msg.MsgUsername}").SendAsync("messages_delivered", new
                    {
                        channel_id = msg.ChannelId,
                        message_ids = new[] { msg.Id }
                    });
                }
            }
        }

        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (_connections.Remove(Context.ConnectionId, out var userInfo))
        {
            var username = userInfo.Username;
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, "all_users");
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"user_{username}");
            _logger.LogInformation("[WS] - {Username}", username);

            // Check if still online from other connections
            var stillOnline = _connections.Values.Any(c => c.Username == username);
            if (!stillOnline)
            {
                var now = DateTime.UtcNow;
                await _db.users
                    .Where(u => u.Username == username)
                    .ExecuteUpdateAsync(s => s
                        .SetProperty(u => u.Status, "offline")
                        .SetProperty(u => u.LastSeen, now));

                await Clients.All.SendAsync("user_status", new
                {
                    username,
                    status = "offline",
                    last_seen = now.ToString("O")
                });
            }
        }

        await base.OnDisconnectedAsync(exception);
    }

    public async Task JoinChannel(string channelId)
    {
        if (!string.IsNullOrEmpty(channelId))
            await Groups.AddToGroupAsync(Context.ConnectionId, channelId);
    }

    public async Task LeaveChannel(string channelId)
    {
        if (!string.IsNullOrEmpty(channelId))
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, channelId);
    }

    public async Task SendMessage(SendMessageRequest data)
    {
        var userInfo = _connections.GetValueOrDefault(Context.ConnectionId);
        if (userInfo == null) return;

        var username = userInfo.Username;
        var content = HtmlSanitizer.Sanitize(data.Content);
        var channelId = data.ChannelId;
        var fileUrl = data.FileUrl;
        var replyToId = data.ReplyTo?.Id;
        var tempId = data.TempId;
        var now = DateTime.UtcNow;
        var msgId = Guid.NewGuid().ToString();

        // Insert message
        var message = new Message
        {
            Id = msgId,
            ChannelId = channelId,
            Username = username,
            Content = content,
            FileUrl = fileUrl,
            ReplyToId = replyToId,
            Timestamp = now,
            Edited = false,
            Reactions = new List<Reaction>(),
            ReadBy = new List<string>(),
            DeliveredTo = new List<string>()
        };

        _db.Messages.Add(message);
        await _db.SaveChangesAsync();

        // Get reply-to info if needed
        ReplyToInfo? replyToInfo = null;
        if (replyToId != null)
        {
            var rm = await _db.Messages
                .Where(m => m.Id == replyToId)
                .Select(m => new { m.Id, m.Username, m.Content, m.FileUrl })
                .FirstOrDefaultAsync();

            if (rm != null)
            {
                var existingUsers = await _db.users.Select(u => u.Username).ToListAsync();
                replyToInfo = new ReplyToInfo
                {
                    Id = rm.Id,
                    Username = GetSafeUsername(rm.Username, !existingUsers.Contains(rm.Username)),
                    Content = rm.Content ?? "",
                    FileUrl = rm.FileUrl,
                    IsDeleted = !existingUsers.Contains(rm.Username)
                };
            }
        }

        // DM: check delivery
        if (channelId.Contains('-'))
        {
            var dm = await _db.DMChannels.FirstOrDefaultAsync(d => d.Id == channelId);
            if (dm != null)
            {
                var otherUser = dm.Participants.FirstOrDefault(p => p != username);
                if (otherUser != null)
                {
                    var isOnline = await _db.users
                        .Where(u => u.Username == otherUser)
                        .Select(u => u.Status == "online")
                        .FirstOrDefaultAsync();

                    if (isOnline)
                    {
                        await _db.Database.ExecuteSqlRawAsync(@"
                            UPDATE messages SET delivered_to = array_append(delivered_to, {0})
                            WHERE id = {1} AND NOT ({0} = ANY(delivered_to))",
                            otherUser, msgId);

                        await Clients.Group($"user_{username}").SendAsync("messages_delivered", new
                        {
                            channel_id = channelId,
                            message_ids = new[] { msgId }
                        });
                    }
                }
            }
        }

        // Broadcast message to channel
        var messageForSend = new
        {
            id = msgId,
            channel_id = channelId,
            username,
            content,
            file_url = fileUrl,
            timestamp = now.ToString("O"),
            edited = false,
            reactions = new List<Reaction>(),
            read_by = new List<string>()
        };

        object messageObj = messageForSend;
        if (replyToInfo != null)
        {
            messageObj = new { messageForSend.id, messageForSend.channel_id, messageForSend.username, messageForSend.content, messageForSend.file_url, messageForSend.timestamp, messageForSend.edited, messageForSend.reactions, messageForSend.read_by, reply_to = replyToInfo };
        }

        await Clients.Group(channelId).SendAsync("new_message", messageObj);

        // Send temp_id mapping to sender
        if (tempId != null)
        {
            await Clients.Caller.SendAsync("message_sent", new
            {
                temp_id = tempId,
                id = msgId,
                channel_id = channelId
            });
        }

        // DM unread notification
        if (channelId.Contains('-'))
        {
            var dm = await _db.DMChannels.FirstOrDefaultAsync(d => d.Id == channelId);
            if (dm != null)
            {
                var otherUser = dm.Participants.FirstOrDefault(p => p != username);
                if (otherUser != null)
                {
                    var existingUsers = await _db.users.Select(u => u.Username).ToListAsync();
                    if (existingUsers.Contains(otherUser))
                    {
                        var uc = await GetUnreadCountForChannel(channelId, otherUser);
                        await Clients.Group($"user_{otherUser}").SendAsync("unread_update_dm", new
                        {
                            dm_id = channelId,
                            count = uc
                        });
                    }
                }
            }
        }
    }

    public async Task AddReaction(string messageId, string emoji)
    {
        var userInfo = _connections.GetValueOrDefault(Context.ConnectionId);
        if (userInfo == null) return;

        var username = userInfo.Username;

        var row = await _db.Messages
            .Where(m => m.Id == messageId)
            .Select(m => m.Reactions)
            .FirstOrDefaultAsync();

        if (row == null) return;

        var reactions = row ?? new List<Reaction>();
        var existing = reactions.FirstOrDefault(r => r.Emoji == emoji);

        if (existing != null)
        {
            if (existing.Users.Contains(username))
            {
                existing.Users.Remove(username);
                if (existing.Users.Count == 0)
                    reactions.Remove(existing);
            }
            else
            {
                existing.Users.Add(username);
            }
        }
        else
        {
            reactions.Add(new Reaction { Emoji = emoji, Users = new List<string> { username } });
        }

        // Save back as JSONB
        await _db.Database.ExecuteSqlRawAsync(@"
            UPDATE messages SET reactions = {0}::jsonb WHERE id = {1}",
            JsonSerializer.Serialize(reactions), messageId);

        await Clients.All.SendAsync("message_reaction_updated", new
        {
            id = messageId,
            reactions
        });
    }

    public async Task Typing(string channelId)
    {
        var userInfo = _connections.GetValueOrDefault(Context.ConnectionId);
        if (userInfo == null) return;

        if (!string.IsNullOrEmpty(channelId))
        {
            await Clients.Group(channelId).SendAsync("typing", new
            {
                channel_id = channelId,
                username = userInfo.Username
            });
        }
    }

    public async Task MarkChannelRead(string channelId)
    {
        var userInfo = _connections.GetValueOrDefault(Context.ConnectionId);
        if (userInfo == null) return;

        var username = userInfo.Username;

        await _db.Database.ExecuteSqlRawAsync(@"
            UPDATE messages SET read_by = array_append(read_by, {0})
            WHERE channel_id = {1} AND username != {2} AND NOT ({2} = ANY(read_by))",
            username, channelId, username);

        var unreadCounts = await GetRealUnreadCounts(username);
        await Clients.Group($"user_{username}").SendAsync("unread_counts_updated", new
        {
            unread_counts = unreadCounts
        });
    }

    // === Helper methods ===

    private async Task<SessionData?> GetSessionFromContext()
    {
        var httpContext = Context.GetHttpContext();
        if (httpContext == null) return null;

        httpContext.Request.Cookies.TryGetValue("SESSION_ID", out var sessionId);
        if (string.IsNullOrEmpty(sessionId)) return null;

        return await _sessionService.GetSessionAsync(sessionId);
    }

    private static string GetSafeUsername(string? username, bool isDeleted)
    {
        return isDeleted || username == null
            ? Constants.DeletedUserDisplayName
            : username;
    }

    private async Task<int> GetUnreadCountForChannel(string channelId, string username)
    {
        var conn = _db.Database.GetDbConnection();
        await conn.OpenAsync();
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
            SELECT COUNT(*) FROM messages
            WHERE channel_id = @channelId AND username != @username AND NOT (@username = ANY(read_by))";
        var p1 = cmd.CreateParameter();
        p1.ParameterName = "channelId";
        p1.Value = channelId;
        cmd.Parameters.Add(p1);
        var p2 = cmd.CreateParameter();
        p2.ParameterName = "username";
        p2.Value = username;
        cmd.Parameters.Add(p2);

        var result = await cmd.ExecuteScalarAsync();
        return Convert.ToInt32(result);
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
