using ChatApp.Data;
using ChatApp.Hubs;
using ChatApp.Services;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.EntityFrameworkCore;
using Serilog;
using StackExchange.Redis;
using System.Text;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseSerilog();

// Настройка Serilog
Log.Logger = new LoggerConfiguration()
    .WriteTo.Console()
    .CreateLogger();

// ===== Configuration =====
var postgreSQLConnection = builder.Configuration.GetConnectionString("PostgreSQL");
var redisConnection = builder.Configuration.GetConnectionString("Redis");

if (!string.IsNullOrEmpty(redisConnection))
{
    builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
    {
        var config = ConfigurationOptions.Parse(redisConnection);
        config.AbortOnConnectFail = false;
        return ConnectionMultiplexer.Connect(config);
    });
}
else
{
    Console.WriteLine($"[WARNING] Redis connection string is NULL.");
}

builder.Services.AddHttpContextAccessor();
builder.Services.AddMemoryCache();

// Ollama Configuration
builder.Services.Configure<OllamaSettings>(builder.Configuration.GetSection("Ollama"));
builder.Services.AddHttpClient();
builder.Services.AddScoped<OllamaService>();

// ===== Database =====
builder.Services.AddDbContext<ChatDbContext>(options =>
{
    options.UseNpgsql(postgreSQLConnection)
       .UseSnakeCaseNamingConvention();
});

builder.Services.AddSingleton<ISessionService, SessionService>();

// ===== SignalR =====
if (!string.IsNullOrEmpty(redisConnection))
{
    builder.Services.AddSignalR()
        .AddStackExchangeRedis(redisConnection, options =>
        {
            options.Configuration.ChannelPrefix = RedisChannel.Literal("PolChatApp:");
        });
}
else
{
    builder.Services.AddSignalR();
}

// ===== Background Services =====
builder.Services.AddHostedService<InactiveUsersBackgroundService>();

// ===== Controllers =====
builder.Services.AddControllers()
    .AddJsonOptions(options =>
    {
        options.JsonSerializerOptions.DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull;
    });

// ===== CORS =====
builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
    {
        policy.SetIsOriginAllowed(_ => true)
              .AllowAnyMethod()
              .AllowAnyHeader()
              .AllowCredentials();
    });
});

var app = builder.Build();

// ===== Middleware =====
app.UseRouting();
app.UseStaticFiles();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.MapHub<ChatHub>("/chathub");

// Health check endpoint for Ollama
app.MapGet("/api/ai/health", async (OllamaService ollamaService) =>
{
    try
    {
        var isHealthy = await ollamaService.CheckHealthAsync();
        return Results.Ok(new { status = isHealthy ? "healthy" : "unhealthy", service = "ollama" });
    }
    catch
    {
        return Results.Ok(new { status = "error", service = "ollama", message = "Cannot connect to Ollama" });
    }
});

// Debug routes
app.MapGet("/_debug/routes/details", (IEnumerable<EndpointDataSource> endpointSources) =>
{
    var sb = new StringBuilder();
    sb.AppendLine("Registered Routes:");
    sb.AppendLine("==================");

    foreach (var endpoint in endpointSources.SelectMany(x => x.Endpoints))
    {
        if (endpoint is RouteEndpoint routeEndpoint)
        {
            sb.AppendLine($"DisplayName: {routeEndpoint.DisplayName}");
            sb.AppendLine($"Pattern: {routeEndpoint.RoutePattern.RawText}");
            sb.AppendLine($"Order: {routeEndpoint.Order}");

            var httpMethods = routeEndpoint.Metadata
                .OfType<HttpMethodMetadata>()
                .FirstOrDefault()?.HttpMethods;

            if (httpMethods != null)
            {
                sb.AppendLine($"Methods: {string.Join(", ", httpMethods)}");
            }

            sb.AppendLine("---");
        }
    }

    return Results.Text(sb.ToString(), "text/plain");
});

// ===== Startup =====
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<ChatDbContext>();
    await DbInitializer.InitializeAsync(db);
    Console.WriteLine("[OK] Database initialized");

    // Check Ollama
    var ollamaService = scope.ServiceProvider.GetService<OllamaService>();
    if (ollamaService != null)
    {
        try
        {
            var isOllamaHealthy = await ollamaService.CheckHealthAsync();
            if (isOllamaHealthy)
            {
                Console.WriteLine("[OK] Ollama service is available");
            }
            else
            {
                Console.WriteLine("[WARNING] Ollama service is not available. Make sure Ollama is running on http://localhost:11434");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[WARNING] Cannot connect to Ollama: {ex.Message}");
        }
    }
}

// ===== HTTPS Configuration =====
var port = builder.Configuration.GetValue<int>("Server:Port", 5000);
var useHttps = builder.Configuration.GetValue<bool>("Server:UseHttps", false);

Console.WriteLine($"[START] Chat: {(useHttps ? "https" : "http")}://127.0.0.1:{port}");

if (useHttps)
{
    app.Run($"https://0.0.0.0:{port}");
}
else
{
    app.Run($"http://0.0.0.0:{port}");
}