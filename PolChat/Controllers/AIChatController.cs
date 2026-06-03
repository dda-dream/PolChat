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


    [HttpGet("health")]
    public async Task<IActionResult> Health()
    {
        var isHealthy = await _ollamaService.CheckHealthAsync();
        return Ok(new { status = isHealthy ? "healthy" : "unhealthy" });
    }
}