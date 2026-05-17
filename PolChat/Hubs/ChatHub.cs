using ChatApp.Data;
using ChatApp.Models;
using ChatApp.Services;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using System.Collections.Concurrent;
using System.Text.Json;

namespace ChatApp.Hubs;

public class ChatHub : Hub
{
    private readonly ChatDbContext _db;
    private readonly ISessionService _sessionService;
    private readonly ILogger<ChatHub> _logger;
    private readonly IMemoryCache _cache;
    private readonly IHubContext<ChatHub> _hubContext;
    private readonly IServiceScopeFactory _scopeFactory;

    private static readonly Dictionary<string, SessionData> _connections = new();

    public ChatHub(
        ChatDbContext db,
        ISessionService sessionService,
        ILogger<ChatHub> logger,
        IMemoryCache cache,
        IHubContext<ChatHub> hubContext,
        IServiceScopeFactory scopeFactory)
    {
        _db = db;
        _sessionService = sessionService;
        _logger = logger;
        _cache = cache;
        _hubContext = hubContext;
        _scopeFactory = scopeFactory;
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

        var now = DateTime.UtcNow;
        await _db.Users
            .Where(u => u.Username == username)
            .ExecuteUpdateAsync(s => s
                .SetProperty(u => u.Status, "online")
                .SetProperty(u => u.LastSeen, now));

        await _hubContext.Clients.All.SendAsync("user_status", new { username });

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

                await _hubContext.Clients.All.SendAsync("user_status", new { username });
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
        _logger.LogInformation("🔵 SendMessage: Channel={ChannelId}, User={Username}",
            data.ChannelId,
            _connections.GetValueOrDefault(Context.ConnectionId)?.Username ?? "unknown");

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

        var sender = await _db.Users
            .Where(u => u.Username == username)
            .Select(u => new { u.IsBot })
            .FirstOrDefaultAsync();

        var isBot = sender?.IsBot ?? false;

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

        var messageToSend = new
        {
            id = msgId,
            channelId,
            username,
            content,
            fileUrl,
            timestamp = now.ToString("O"),
            edited = false,
            reactions = new List<ReactionInMessage>(),
            readBy = new List<string>(),
            deliveredTo = new List<string>(),
            replyTo = (object?)null,
            isBot
        };

        await _hubContext.Clients.Group(channelId).SendAsync("new_message", messageToSend);

        if (tempId != null)
        {
            await Clients.Caller.SendAsync("message_sent", new { tempId, id = msgId });
        }

        // AI Response - запускаем через отдельный scope
        if (channelId.Contains('-'))
        {
            var dm = await _db.DmChannels.FirstOrDefaultAsync(d => d.Id == channelId);
            if (dm != null)
            {
                var otherUser = dm.Participants?.FirstOrDefault(p => p != username);
                if (otherUser != null)
                {
                    var receiver = await _db.Users
                        .Where(u => u.Username == otherUser)
                        .Select(u => new { u.IsBot })
                        .FirstOrDefaultAsync();

                    if (receiver?.IsBot == true)
                    {
                        _logger.LogInformation("✅ AI RESPONSE TRIGGERED");
                        _ = Task.Run(() => ProcessAIResponseAsync(channelId, username, content));
                    }
                }
            }
        }
    }

    public async Task SendAIMessage(string channelId, string content, string tempId)
    {
        _logger.LogInformation("🤖 SendAIMessage: Channel={ChannelId}, Content={Content}", channelId, content);

        var userInfo = _connections.GetValueOrDefault(Context.ConnectionId);
        if (userInfo == null) return;

        var username = userInfo.Username;
        var now = DateTime.UtcNow;
        var realId = Guid.NewGuid().ToString();

        // Сохраняем сообщение пользователя в БД
        var userMessage = new Message
        {
            Id = realId,
            ChannelId = channelId,
            Username = username,
            Content = HtmlSanitizer.Sanitize(content),
            Timestamp = now,
            Edited = false,
            Reactions = new List<ReactionInMessage>(),
            ReadBy = Array.Empty<string>(),
            DeliveredTo = new List<string>()
        };

        _db.Messages.Add(userMessage);
        await _db.SaveChangesAsync();

        // Отправляем подтверждение клиенту
        if (!string.IsNullOrEmpty(tempId))
        {
            await Clients.Caller.SendAsync("message_sent", new { tempId = tempId, id = realId });
        }

        // Запускаем AI ответ
        _ = Task.Run(() => ProcessAIResponseAsync(channelId, username, content));
    }

    private async Task ProcessAIResponseAsync(string channelId, string username, string userMessage)
    {
        _logger.LogInformation("ProcessAIResponseAsync START: channel={ChannelId}", channelId);

        try
        {
            using (var scope = _scopeFactory.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<ChatDbContext>();
                var ollama = scope.ServiceProvider.GetRequiredService<OllamaService>();
                var hubContext = scope.ServiceProvider.GetRequiredService<IHubContext<ChatHub>>();

                var botUser = await db.Users.FirstOrDefaultAsync(u => u.IsBot == true);
                if (botUser == null)
                {
                    _logger.LogWarning("Bot user not found");
                    return;
                }

                var response = await ollama.GenerateResponseAsync(userMessage, "");
                if (string.IsNullOrWhiteSpace(response))
                {
                    response = "Извините, не могу ответить на это сообщение.";
                }

                // Сохраняем сообщение
                var aiMsg = new Message
                {
                    Id = Guid.NewGuid().ToString(),
                    ChannelId = channelId,
                    Username = botUser.Username,
                    Content = response,
                    Timestamp = DateTime.UtcNow,
                    Edited = false,
                    Reactions = new List<ReactionInMessage>(),
                    ReadBy = Array.Empty<string>(),
                    DeliveredTo = new List<string>()
                };

                await db.Messages.AddAsync(aiMsg);
                await db.SaveChangesAsync();

                // Отправляем клиенту
                var messageToSend = new
                {
                    id = aiMsg.Id,
                    channelId,
                    username = botUser.Username,
                    content = response,
                    fileUrl = (string?)null,
                    timestamp = aiMsg.Timestamp.ToString("O"),
                    edited = false,
                    reactions = new List<ReactionInMessage>(),
                    readBy = new List<string>(),
                    deliveredTo = new List<string>(),
                    replyTo = (object?)null,
                    isBot = true
                };

                _logger.LogInformation("Sending AI response to channel {ChannelId}", channelId);
                await hubContext.Clients.Group(channelId).SendAsync("new_message", messageToSend);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in ProcessAIResponseAsync for channel {ChannelId}", channelId);

            // Отправляем сообщение об ошибке
            try
            {
                using (var scope = _scopeFactory.CreateScope())
                {
                    var hubContext = scope.ServiceProvider.GetRequiredService<IHubContext<ChatHub>>();
                    var errorMsg = new
                    {
                        id = Guid.NewGuid().ToString(),
                        channelId,
                        username = "AI Assistant",
                        content = "❌ Произошла ошибка. Попробуйте позже.",
                        fileUrl = (string?)null,
                        timestamp = DateTime.UtcNow.ToString("O"),
                        edited = false,
                        reactions = new List<ReactionInMessage>(),
                        readBy = new List<string>(),
                        deliveredTo = new List<string>(),
                        replyTo = (object?)null,
                        isBot = true
                    };
                    await hubContext.Clients.Group(channelId).SendAsync("new_message", errorMsg);
                }
            }
            catch (Exception sendEx)
            {
                _logger.LogError(sendEx, "Failed to send error message");
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

        await _db.SaveChangesAsync();

        await _hubContext.Clients.All.SendAsync("message_reaction_updated", new { id = messageId, reactions });
    }

    public async Task Typing(string channelId)
    {
        var userInfo = _connections.GetValueOrDefault(Context.ConnectionId);
        if (userInfo == null) return;

        if (!string.IsNullOrEmpty(channelId))
        {
            await _hubContext.Clients.Group(channelId).SendAsync("typing",
                new { channelId, username = userInfo.Username });
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
    }

    public async Task<string> GetServerTime()
    {
        return DateTime.UtcNow.ToString("O");
    }

    private async Task<SessionData?> GetSessionFromContext()
    {
        var httpContext = Context.GetHttpContext();
        if (httpContext == null) return null;

        httpContext.Request.Cookies.TryGetValue("SESSION_ID", out var sessionId);
        if (string.IsNullOrEmpty(sessionId)) return null;

        return await _sessionService.GetSessionAsync(sessionId);
    }
}