using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ChatApp.Services;
using Microsoft.AspNetCore.SignalR;
using ChatApp.Hubs;
using ChatApp.Data;
using ChatApp.Models;
using System.Security.Claims;

namespace ChatApp.Controllers;

// Класс запроса
public class AIChatRequest
{
    public string Message { get; set; } = string.Empty;
    public string? Context { get; set; }
    public string ChannelId { get; set; } = string.Empty;
    public string Username { get; set; } = string.Empty;
}

//[Authorize]
[ApiController]
[Route("api/ai")]
public class AIChatController : ControllerBase
{
    private readonly OllamaService _ollamaService;
    private readonly ILogger<AIChatController> _logger;
    private readonly IHubContext<ChatHub> _hubContext;
    private readonly ChatDbContext _db;

    public AIChatController(
        OllamaService ollamaService,
        ILogger<AIChatController> logger,
        IHubContext<ChatHub> hubContext,
        ChatDbContext db)
    {
        _ollamaService = ollamaService;
        _logger = logger;
        _hubContext = hubContext;
        _db = db;
    }

    [HttpPost("chat")]
    public async Task<IActionResult> ChatWithAI([FromBody] AIChatRequest request)
    {
        try
        {
            var username = request.Username;
            if (string.IsNullOrEmpty(username))
            {
                return BadRequest(new { error = "Username обязателен" });
            }

            if (string.IsNullOrWhiteSpace(request.Message))
            {
                return BadRequest(new { error = "Сообщение не может быть пустым" });
            }

            if (string.IsNullOrEmpty(request.ChannelId))
            {
                return BadRequest(new { error = "ID канала обязателен" });
            }

            _logger.LogInformation("AI request from {Username} in channel {ChannelId}: {Message}",
                username, request.ChannelId, request.Message);

            // Получаем ответ от Ollama
            var aiResponse = await _ollamaService.GenerateResponseAsync(
                request.Message,
                request.Context);

            // Создаём сообщение для сохранения в БД
            var message = new Message
            {
                Id = Guid.NewGuid().ToString(),
                ChannelId = request.ChannelId,
                Username = "AI Assistant",
                Content = aiResponse,
                FileUrl = null,
                Timestamp = DateTime.UtcNow,
                Edited = false,
                EditedAt = null,
                Reactions = new List<ReactionInMessage>(), // пустой список реакций
                ReadBy = new[] { username },     // List<string>, а не string[]
                DeliveredTo = new List<string> { username },
                ReplyTo = null,
            };

            // Сохраняем в базу данных
            await _db.Messages.AddAsync(message);
            await _db.SaveChangesAsync();

            // Подготавливаем объект для SignalR (анонимный, с правильными типами)
            var signalRMessage = new
            {
                id = message.Id,
                channelId = message.ChannelId,
                username = message.Username,
                content = message.Content,
                fileUrl = message.FileUrl,
                timestamp = message.Timestamp.ToString("o"),
                edited = message.Edited,
                reactions = message.Reactions.Select(r => new { emoji = r.Emoji, users = r.Users }),
                readBy = message.ReadBy.ToArray(),        // преобразуем List<string> в string[]
                deliveredTo = message.DeliveredTo.ToArray(),
                replyTo = (object?)null,
            };

            // Отправляем через SignalR всем в канале
            await _hubContext.Clients.Group(request.ChannelId).SendAsync("new_message", signalRMessage);

            return Ok(new { success = true, response = aiResponse });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in AI chat");
            return StatusCode(500, new { error = "Ошибка при обработке запроса: " + ex.Message });
        }
    }

    [HttpGet("health")]
    public async Task<IActionResult> Health()
    {
        var isHealthy = await _ollamaService.CheckHealthAsync();
        return Ok(new { status = isHealthy ? "healthy" : "unhealthy" });
    }
}