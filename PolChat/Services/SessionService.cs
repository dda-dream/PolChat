using StackExchange.Redis;
using System.Text.Json;
using ChatApp.Models;
using ChatApp.Data;
using System.Security.Cryptography;

namespace ChatApp.Services;

public interface ISessionService
{
    Task<SessionData?> GetSessionAsync(string? sessionId);
    Task<string> CreateSessionAsync(SessionData data);
    Task DeleteSessionAsync(string sessionId);
}

public class SessionService : ISessionService
{
    private readonly IDatabase _redis;
    private readonly ILogger<SessionService> _logger;

    public SessionService(IConnectionMultiplexer redis, ILogger<SessionService> logger)
    {
        _redis = redis.GetDatabase();
        _logger = logger;
    }

    public async Task<SessionData?> GetSessionAsync(string? sessionId)
    {
        if (string.IsNullOrEmpty(sessionId)) return null;

        try
        {
            var data = await _redis.StringGetAsync($"session:{sessionId}");
            if (data.IsNullOrEmpty) return null;

            //TODO: Disambiguate JsonSerializer.Deserialize overloads by passing a string
            return JsonSerializer.Deserialize<SessionData>(data.ToString()!);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Redis error in GetSessionAsync");
            return null;
        }
    }

    public async Task<string> CreateSessionAsync(SessionData data)
    {
        var sessionId = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var json = JsonSerializer.Serialize(data);

        try
        {
            await _redis.StringSetAsync(
                $"session:{sessionId}",
                json,
                TimeSpan.FromDays(Constants.SessionTtlDays)
            );
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Redis error in CreateSessionAsync");
        }

        return sessionId;
    }

    public async Task DeleteSessionAsync(string sessionId)
    {
        try
        {
            await _redis.KeyDeleteAsync($"session:{sessionId}");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Redis error in DeleteSessionAsync");
        }
    }
}
