using ChatApp.Data;
using ChatApp.Models;
using ChatApp.Services;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using System.Text.Json;

namespace ChatApp.Hubs;

public class ChatHub : Hub
{
    private readonly ChatDbContext _db;
    private readonly ISessionService _sessionService;
    private readonly ILogger<ChatHub> _logger;
    private readonly IMemoryCache _cache;
    private readonly IServiceProvider _serviceProvider;

    // Track connections: ConnectionId -> SessionData
    private static readonly Dictionary<string, SessionData> _connections = new();

    public ChatHub(
        ChatDbContext db,
        ISessionService sessionService,
        ILogger<ChatHub> logger,
        IMemoryCache cache,
        IServiceProvider serviceProvider)
    {
        _db = db;
        _sessionService = sessionService;
        _logger = logger;
        _cache = cache;
        _serviceProvider = serviceProvider;
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
        await _db.Users
            .Where(u => u.Username == username)
            .ExecuteUpdateAsync(s => s
                .SetProperty(u => u.Status, "online")
                .SetProperty(u => u.LastSeen, now));

        await Clients.All.SendAsync("user_status", new { username });

        // Get pending messages
        var pendingList = new List<(string Id, string ChannelId, string MsgUsername)>();
        var connection = _db.Database.GetDbConnection();
        await connection.OpenAsync();

        try
        {
            await using (var cmd = connection.CreateCommand())
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
                while (await reader.ReadAsync())
                {
                    pendingList.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2)));
                }
            }

            if (pendingList.Count > 0)
            {
                var ids = pendingList.Select(p => p.Id).ToList();

                await using (var cmd = connection.CreateCommand())
                {
                    cmd.CommandText = @"
                        UPDATE messages SET delivered_to = array_append(delivered_to, @username)
                        WHERE id = ANY(@ids) AND NOT (@username = ANY(delivered_to))";

                    var pUsername = cmd.CreateParameter();
                    pUsername.ParameterName = "username";
                    pUsername.Value = username;
                    cmd.Parameters.Add(pUsername);

                    var pIds = cmd.CreateParameter();
                    pIds.ParameterName = "ids";
                    pIds.Value = ids.ToArray();
                    cmd.Parameters.Add(pIds);

                    await cmd.ExecuteNonQueryAsync();
                }

                foreach (var msg in pendingList)
                {
                    await Clients.Group($"user_{msg.MsgUsername}").SendAsync("messages_delivered",
                        new { channelId = msg.ChannelId, messageIds = new[] { msg.Id } });
                }
            }
        }
        finally
        {
            await connection.CloseAsync();
            await connection.DisposeAsync();
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

            var stillOnline = _connections.Values.Any(c => c.Username == username);
            if (!stillOnline)
            {
                var now = DateTime.UtcNow;
                await _db.Users
                    .Where(u => u.Username == username)
                    .ExecuteUpdateAsync(s => s
                        .SetProperty(u => u.Status, "offline")
                        .SetProperty(u => u.LastSeen, now));

                await Clients.All.SendAsync("user_status", new { username });
            }
        }

        await base.OnDisconnectedAsync(exception);
    }

    public async Task JoinChannel(string channelId)
    {
        if (!string.IsNullOrEmpty(channelId))
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, channelId);
            _logger.LogInformation("User {ConnectionId} joined channel {ChannelId}", Context.ConnectionId, channelId);
        }
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
            Reactions = new List<ReactionInMessage>(),
            ReadBy = Array.Empty<string>(),
            DeliveredTo = new List<string>()
        };

        _db.Messages.Add(message);
        await _db.SaveChangesAsync();

        ReplyToInfo? replyToInfo = null;
        if (replyToId != null)
        {
            var rm = await _db.Messages
                .Where(m => m.Id == replyToId)
                .Select(m => new { m.Id, m.Username, m.Content, m.FileUrl })
                .FirstOrDefaultAsync();

            if (rm != null)
            {
                var existingUsers = await _db.Users.Select(u => u.Username).ToListAsync();
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

        // Handle AI Assistant DM
        if (channelId.Contains('-'))
        {
            var dm = await _db.DmChannels.FirstOrDefaultAsync(d => d.Id == channelId);
            if (dm != null)
            {
                var otherUser = dm.Participants.FirstOrDefault(p => p != username);
                if (otherUser != null && otherUser == "AI Assistant")
                {
                    // Fire-and-forget AI response (no blocking)
                    _ = Task.Run(async () => await GenerateAIResponseAsync(channelId, username, content));
                }
                else if (otherUser != null)
                {
                    var isOnline = await _db.Users
                        .Where(u => u.Username == otherUser)
                        .Select(u => u.Status == "online")
                        .FirstOrDefaultAsync();

                    if (isOnline)
                    {
                        await _db.Database.ExecuteSqlRawAsync(@"
                            UPDATE messages SET delivered_to = array_append(delivered_to, {0})
                            WHERE id = {1} AND NOT ({0} = ANY(delivered_to))",
                            otherUser, msgId);

                        await Clients.Group($"user_{username}").SendAsync("messages_delivered",
                            new { channelId = channelId, messageIds = new[] { msgId } });
                    }
                }
            }
        }

        var messageToSend = new
        {
            id = msgId,
            channelId = channelId,
            username,
            content,
            fileUrl = fileUrl,
            timestamp = now.ToString("O"),
            edited = false,
            reactions = new List<ReactionInMessage>(),
            readBy = new List<string>(),
            deliveredTo = new List<string>(),
            replyTo = replyToInfo
        };

        await Clients.Group(channelId).SendAsync("new_message", messageToSend);

        if (tempId != null)
        {
            await Clients.Caller.SendAsync("message_sent", new { tempId = tempId, id = msgId });
        }

        // Update unread counts
        if (channelId.Contains('-'))
        {
            var dm = await _db.DmChannels.FirstOrDefaultAsync(d => d.Id == channelId);
            if (dm != null)
            {
                var otherUser = dm.Participants.FirstOrDefault(p => p != username);
                if (otherUser != null)
                {
                    var existingUsers = await _db.Users.Select(u => u.Username).ToListAsync();
                    if (existingUsers.Contains(otherUser))
                    {
                        var uc = await GetUnreadCountForChannel(channelId, otherUser);
                        await Clients.Group($"user_{otherUser}").SendAsync("unread_update_dm",
                            new { dmId = channelId, count = uc });
                    }
                }
            }
        }
    }

    private async Task GenerateAIResponseAsync(string channelId, string username, string userMessage)
    {
        try
        {
            using (var scope = _serviceProvider.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<ChatDbContext>();
                var ollama = scope.ServiceProvider.GetRequiredService<OllamaService>();
                var logger = scope.ServiceProvider.GetRequiredService<ILogger<ChatHub>>();

                // Отправляем индикатор "печатает"
                await Clients.Group(channelId).SendAsync("typing", new
                {
                    channelId = channelId,
                    username = "AI Assistant"
                });

                await Task.Delay(500);

                // Получаем контекст
                var contextMessages = await db.Messages
                    .Where(m => m.ChannelId == channelId)
                    .OrderByDescending(m => m.Timestamp)
                    .Take(20)
                    .OrderBy(m => m.Timestamp)
                    .Select(m => new { m.Username, m.Content })
                    .ToListAsync();

                var conversation = string.Join("\n", contextMessages.Select(m =>
                {
                    var displayName = m.Username == "AI Assistant" ? "Ассистент" : m.Username;
                    return $"{displayName}: {m.Content}";
                }));

                // Проверяем Ollama
                var isHealthy = await ollama.CheckHealthAsync();
                if (!isHealthy)
                {
                    await SendAIMessageAndBroadcast(db, channelId, "⚠️ AI ассистент временно недоступен. Убедитесь, что Ollama запущен.");
                    return;
                }

                // Генерируем ответ
                var response = await ollama.GenerateResponseAsync(userMessage, conversation);

                if (string.IsNullOrWhiteSpace(response))
                {
                    response = "Извините, не могу ответить на это сообщение.";
                }

                await SendAIMessageAndBroadcast(db, channelId, response);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[AI Error] {ex.Message}");

            try
            {
                using (var scope = _serviceProvider.CreateScope())
                {
                    var db = scope.ServiceProvider.GetRequiredService<ChatDbContext>();
                    await SendAIMessageAndBroadcast(db, channelId, "❌ Произошла ошибка. Попробуйте позже.");
                }
            }
            catch
            {
                // Игнорируем
            }
        }
    }

    private async Task SendAIMessageAndBroadcast(ChatDbContext db, string channelId, string content, string targetUsername = null)
    {
        var aiMsg = new Message
        {
            Id = Guid.NewGuid().ToString(),
            ChannelId = channelId,
            Username = "AI Assistant",
            Content = content,
            Timestamp = DateTime.UtcNow,
            Edited = false,
            Reactions = new List<ReactionInMessage>(),
            ReadBy = Array.Empty<string>(),
            DeliveredTo = new List<string>()
        };

        await db.Messages.AddAsync(aiMsg);
        await db.SaveChangesAsync();

        var messageObj = new
        {
            id = aiMsg.Id,
            channelId = aiMsg.ChannelId,
            username = aiMsg.Username,
            content = aiMsg.Content,
            fileUrl = (string?)null,
            timestamp = aiMsg.Timestamp.ToString("O"),
            edited = false,
            reactions = new List<ReactionInMessage>(),
            readBy = new List<string>(),
            deliveredTo = new List<string>(),
            replyTo = (object?)null
        };

        // Отправляем в группу канала
        await Clients.Group(channelId).SendAsync("new_message", messageObj);

        // Также отправляем конкретному пользователю для надежности
        if (!string.IsNullOrEmpty(targetUsername))
        {
            await Clients.Group($"user_{targetUsername}").SendAsync("new_message", messageObj);
        }
    }

    private async Task SendAIMessageAsync(ChatDbContext db, string channelId, string content)
    {
        var aiMsg = new Message
        {
            Id = Guid.NewGuid().ToString(),
            ChannelId = channelId,
            Username = "AI Assistant",
            Content = content,
            Timestamp = DateTime.UtcNow,
            Edited = false,
            Reactions = new List<ReactionInMessage>(),
            ReadBy = Array.Empty<string>(),
            DeliveredTo = new List<string>()
        };

        await db.Messages.AddAsync(aiMsg);
        await db.SaveChangesAsync();

        await Clients.Group(channelId).SendAsync("new_message", new
        {
            id = aiMsg.Id,
            channelId = aiMsg.ChannelId,
            username = aiMsg.Username,
            content = aiMsg.Content,
            fileUrl = (string?)null,
            timestamp = aiMsg.Timestamp.ToString("O"),
            edited = false,
            reactions = new List<ReactionInMessage>(),
            readBy = new List<string>(),
            deliveredTo = new List<string>(),
            replyTo = (object?)null
        });
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

        var reactions = row ?? new List<ReactionInMessage>();
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
            reactions.Add(new ReactionInMessage { Emoji = emoji, Users = new List<string> { username } });
        }

        await _db.Database.ExecuteSqlRawAsync(@"
            UPDATE messages SET reactions = {0}::jsonb WHERE id = {1}",
            JsonSerializer.Serialize(reactions), messageId);

        // Update Reactions table
        var reaction = await _db.Reactions
            .Where(r => r.UserId == username && r.MessageId == messageId && r.Emoji == emoji)
            .FirstOrDefaultAsync();

        if (reaction == null)
        {
            var newReaction = new Reaction
            {
                UserId = username,
                MessageId = messageId,
                Emoji = emoji,
                CreatedAt = DateTime.SpecifyKind(DateTime.UtcNow, DateTimeKind.Utc)
            };
            await _db.Reactions.AddAsync(newReaction);
        }
        else
        {
            _db.Reactions.Remove(reaction);
        }

        await _db.SaveChangesAsync();

        await Clients.All.SendAsync("message_reaction_updated", new { id = messageId, reactions });
    }

    public async Task Typing(string channelId)
    {
        var userInfo = _connections.GetValueOrDefault(Context.ConnectionId);
        if (userInfo == null) return;

        if (!string.IsNullOrEmpty(channelId))
        {
            await Clients.Group(channelId).SendAsync("typing",
                new { channelId = channelId, username = userInfo.Username });
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
        await Clients.Group($"user_{username}").SendAsync("unread_counts_updated",
            new { unread_counts = unreadCounts });
    }

    public async Task<string> GetServerTime()
    {
        var now = DateTime.UtcNow;
        return now.ToString("O");
    }

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