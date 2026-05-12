using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using ChatApp.Services;

namespace ChatApp.Controllers;

[Authorize]
[ApiController]
[Route("api/ai")]
public class AIChatController : ControllerBase
{
    private readonly OllamaService _ollamaService;
    private readonly ILogger<AIChatController> _logger;

    public AIChatController(OllamaService ollamaService, ILogger<AIChatController> logger)
    {
        _ollamaService = ollamaService;
        _logger = logger;
    }

    [HttpPost("chat")]
    public async Task<IActionResult> ChatWithAI([FromBody] AIChatRequest request)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(request.Message))
            {
                return BadRequest(new { error = "Сообщение не может быть пустым" });
            }

            var response = await _ollamaService.GenerateResponseAsync(
                request.Message,
                request.Context);

            return Ok(new { response });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in AI chat");
            return StatusCode(500, new { error = "Ошибка при обработке запроса" });
        }
    }

    [HttpGet("health")]
    public async Task<IActionResult> Health()
    {
        var isHealthy = await _ollamaService.CheckHealthAsync();
        return Ok(new { status = isHealthy ? "healthy" : "unhealthy" });
    }
}

public class AIChatRequest
{
    public string Message { get; set; } = string.Empty;
    public string? Context { get; set; }
}