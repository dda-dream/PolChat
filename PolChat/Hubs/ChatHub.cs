using ChatApp.Data;
using ChatApp.Models;
using ChatApp.Services;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using System.Collections.Concurrent;
using System.Text.Json;
using System.Threading.Channels;
using static System.Collections.Specialized.BitVector32;

namespace ChatApp.Hubs;

public class ChatHub : Hub
{
    private readonly ChatDbContext _db;
    private readonly ISessionService _sessionService;
    private readonly ILogger<ChatHub> _logger;
    private readonly IMemoryCache _cache;
    private readonly IHubContext<ChatHub> _hubContext;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IServiceProvider _serviceProvider;

    private static readonly Dictionary<string, SessionData> _connections = new();

    public ChatHub(
        ChatDbContext db,
        ISessionService sessionService,
        ILogger<ChatHub> logger,
        IMemoryCache cache,
        IHubContext<ChatHub> hubContext,
        IServiceScopeFactory scopeFactory,
        IServiceProvider serviceProvider)
    {
        _db = db;
        _sessionService = sessionService;
        _logger = logger;
        _cache = cache;
        _hubContext = hubContext;
        _scopeFactory = scopeFactory;
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

                // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Создаем независимый скоуп для базы данных
                using (var scope = _serviceProvider.CreateScope())
                {
                    var db = scope.ServiceProvider.GetRequiredService<ChatDbContext>();

                    try
                    {
                        // Явно передаем CancellationToken.None, чтобы отмена HTTP-запроса 
                        // в тесте не могла прервать запись в базу данных
                        await db.Users
                            .Where(u => u.Username == username)
                            .ExecuteUpdateAsync(s => s
                                .SetProperty(u => u.Status, "offline")
                                .SetProperty(u => u.LastSeen, now),
                                CancellationToken.None);
                    }
                    catch (Exception ex)
                    {
                        // Ошибки при отключении (например, если упала БД) 
                        // не должны приводить к падению всего SignalR-сервера
                        _logger.LogError(ex, "Не удалось обновить статус для пользователя {Username}", username);
                    }
                }

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

                        DoOllamaWork(channelId, content, Context.ConnectionId);

                    }
                }
            }
        }
    }

    public async Task DoOllamaWork(string channelId, string content, string connectionId)
    {
        try
        {
            using (var scope = _scopeFactory.CreateScope())
            {
                var ollama = scope.ServiceProvider.GetRequiredService<OllamaService>();
                var db = scope.ServiceProvider.GetRequiredService<ChatDbContext>();
                var hubContext = scope.ServiceProvider.GetRequiredService<IHubContext<ChatHub>>();

                // Получаем бота
                var botUser = await db.Users.FirstOrDefaultAsync(u => u.IsBot == true);
                if (botUser == null)
                {
                    _logger.LogWarning("Bot user not found");
                    return;
                }


                var rows = await db.Messages
                    .Where(m => m.ChannelId == channelId)
                    .OrderBy(m => m.Timestamp)
                    .Select(m => new { m.Content })
                    .ToListAsync();

                var context = "";
                var length = context.Length;
                foreach (var r in rows)
                {
                    context += r + "\n---\n";
                }



                var messageToSendAI = new
                {
                    id = Guid.NewGuid().ToString(),
                    channelId = channelId,
                    username = botUser.Username,
                    content = $"[INFO] Длинна текущего контекста: {context.Length} байт.",
                    fileUrl = (string?)null,
                    timestamp = DateTime.UtcNow.ToString("O"),
                    edited = false,
                    reactions = new List<ReactionInMessage>(),
                    readBy = new List<string>(),
                    deliveredTo = new List<string>(),
                    replyTo = (object?)null,
                    isBot = true
                };
                await hubContext.Clients.Group(channelId).SendAsync("new_message", messageToSendAI);



                var response = await ollama.GenerateResponseAsync(content, context, default, connectionId);

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
                messageToSendAI = new
                {
                    id = aiMsg.Id,
                    channelId = channelId,
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

                await hubContext.Clients.Group(channelId).SendAsync("new_message", messageToSendAI);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in background AI processing");

            try
            {
                using (var scope = _scopeFactory.CreateScope())
                {
                    var hubContext = scope.ServiceProvider.GetRequiredService<IHubContext<ChatHub>>();
                    var errorMsg = new
                    {
                        id = Guid.NewGuid().ToString(),
                        channelId = channelId,
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

        // Запускаем AI ответ в фоне
        var channelIdCopy = channelId;
        var usernameCopy = username;
        var contentCopy = content;
        var connectionIdCopy = Context.ConnectionId;

        _ = Task.Run(async () =>
        {
            try
            {
                using (var scope = _scopeFactory.CreateScope())
                {
                    var ollama = scope.ServiceProvider.GetRequiredService<OllamaService>();
                    var db = scope.ServiceProvider.GetRequiredService<ChatDbContext>();
                    var hubContext = scope.ServiceProvider.GetRequiredService<IHubContext<ChatHub>>();

                    var botUser = await db.Users.FirstOrDefaultAsync(u => u.IsBot == true);
                    if (botUser == null) return;


                    var rows = await db.Messages
                        .Where(m => m.ChannelId == channelId)
                        .OrderBy(m => m.Timestamp)
                        .Select(m => new { m.Content })
                        .ToListAsync();

                    var context = "";
                    var length = context.Length;
                    foreach (var r in rows)
                    {
                        context += r + "\n---\n";
                    }

                    var response = await ollama.GenerateResponseAsync(contentCopy, context, default, connectionIdCopy);

                    if (string.IsNullOrWhiteSpace(response))
                    {
                        response = "Извините, не могу ответить на это сообщение.";
                    }

                    var aiMsg = new Message
                    {
                        Id = Guid.NewGuid().ToString(),
                        ChannelId = channelIdCopy,
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

                    var messageToSend = new
                    {
                        id = aiMsg.Id,
                        channelId = channelIdCopy,
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

                    await hubContext.Clients.Group(channelIdCopy).SendAsync("new_message", messageToSend);
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in background AI processing for SendAIMessage");
            }
        });
    }

    private async Task ProcessAIResponseAsync(string channelId, string username, string userMessage, string connectionId)
    {
        _logger.LogInformation("ProcessAIResponseAsync START: channel={ChannelId}", channelId);

        try
        {
            using (var scope = _scopeFactory.CreateScope())
            {
                var db = scope.ServiceProvider.GetRequiredService<ChatDbContext>();
                var ollama = scope.ServiceProvider.GetRequiredService<OllamaService>();
                var hubContext = scope.ServiceProvider.GetRequiredService<IHubContext<ChatHub>>();

                // Получаем пользователя-бота
                var botUser = await db.Users.FirstOrDefaultAsync(u => u.IsBot == true);
                if (botUser == null)
                {
                    _logger.LogWarning("Bot user not found");
                    return;
                }

                // Передаем connectionId в OllamaService
                var response = await ollama.GenerateResponseAsync(userMessage, null, default, connectionId);

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
            _logger.LogError(ex, "Error in ProcessAIResponseAsync");

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

        //var row = await _db.Messages
        //    .Where(m => m.Id == messageId)
        //    .Select(m => m.Reactions)
        //    .FirstOrDefaultAsync();

        //if (row == null) return;

        //var reactions = row ?? new List<ReactionInMessage>();
        //var existing = reactions.FirstOrDefault(r => r.Emoji == emoji);

        //if (existing != null)
        //{
        //    if (existing.Users.Contains(username))
        //    {
        //        existing.Users.Remove(username);
        //        if (existing.Users.Count == 0)
        //            reactions.Remove(existing);
        //    }
        //    else
        //    {
        //        existing.Users.Add(username);
        //    }
        //}
        //else
        //{
        //    reactions.Add(new ReactionInMessage { Emoji = emoji, Users = new List<string> { username } });
        //}

        //await _db.Database.ExecuteSqlRawAsync(@"
        //    UPDATE messages SET reactions = {0}::jsonb WHERE id = {1}",
        //    JsonSerializer.Serialize(reactions), messageId);

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
        // Update Reactions table


        await _db.SaveChangesAsync();

        var reactions = await _db.Reactions
            .Where(r => r.MessageId == messageId)
            .ToListAsync();

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