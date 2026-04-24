using Microsoft.EntityFrameworkCore;
using ChatApp.Data;

namespace ChatApp.Services;

public class InactiveUsersBackgroundService : BackgroundService
{
    private readonly IServiceProvider _serviceProvider;
    private readonly ILogger<InactiveUsersBackgroundService> _logger;

    public InactiveUsersBackgroundService(IServiceProvider serviceProvider, ILogger<InactiveUsersBackgroundService> logger)
    {
        _serviceProvider = serviceProvider;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);

                using var scope = _serviceProvider.CreateScope();
                var db = scope.ServiceProvider.GetRequiredService<ChatDbContext>();

                // Set users to 'away' if inactive for 2 minutes
                await db.Database.ExecuteSqlRawAsync(@"
                    UPDATE users SET status = 'away'
                    WHERE status = 'online'
                      AND last_seen IS NOT NULL
                      AND (NOW() - last_seen) > INTERVAL '2 minutes'", stoppingToken);

                // Set users to 'offline' if away for 5 minutes
                await db.Database.ExecuteSqlRawAsync(@@"
                    UPDATE users SET status = 'offline'
                    WHERE status = 'away'
                      AND last_seen IS NOT NULL
                      AND (NOW() - last_seen) > INTERVAL '5 minutes'", stoppingToken);

                _logger.LogDebug("Inactive users check completed");
            }
            catch (Exception ex) when (ex is not TaskCanceledException)
            {
                _logger.LogError(ex, "Error checking inactive users");
            }
        }
    }
}
