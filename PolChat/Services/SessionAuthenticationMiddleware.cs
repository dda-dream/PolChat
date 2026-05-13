using System.Security.Claims;
using ChatApp.Services;

namespace ChatApp.Middleware;

public class SessionAuthenticationMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<SessionAuthenticationMiddleware> _logger;

    public SessionAuthenticationMiddleware(RequestDelegate next, ILogger<SessionAuthenticationMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context, ISessionService sessionService)
    {
        // Пытаемся получить SESSION_ID из куки
        if (context.Request.Cookies.TryGetValue("SESSION_ID", out var sessionId) && !string.IsNullOrEmpty(sessionId))
        {
            var session = await sessionService.GetSessionAsync(sessionId);
            if (session != null)
            {
                // Создаём ClaimsPrincipal из сессии
                var claims = new List<Claim>
                {
                    new Claim(ClaimTypes.Name, session.Username),
                    new Claim(ClaimTypes.Role, session.Role ?? "user"),
                    new Claim("SessionId", sessionId)
                };

                var identity = new ClaimsIdentity(claims, "Session");
                context.User = new ClaimsPrincipal(identity);

                _logger.LogDebug("User {Username} authenticated via session", session.Username);
            }
        }

        await _next(context);
    }
}