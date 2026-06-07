using ChatApp.Data;
using ChatApp.Hubs;
using ChatApp.Middleware;
using ChatApp.Models;
using ChatApp.Services;
using Microsoft.AspNetCore.HttpLogging;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using Serilog;
using StackExchange.Redis;
using System.Net;
using System.Security.Cryptography.X509Certificates;
using System.Text;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseSerilog();

// Настройка Serilog
// Serilog — только нужные логи
Log.Logger = new LoggerConfiguration()
    .MinimumLevel.Information()
    .MinimumLevel.Override("Microsoft", Serilog.Events.LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.AspNetCore", Serilog.Events.LogEventLevel.Warning)
    .MinimumLevel.Override("Microsoft.EntityFrameworkCore", Serilog.Events.LogEventLevel.Warning)
    .MinimumLevel.Override("System", Serilog.Events.LogEventLevel.Warning)
    .WriteTo.Console(outputTemplate: "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{NewLine}{Exception}")
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


//NGINX config
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders =
        ForwardedHeaders.XForwardedFor |
        ForwardedHeaders.XForwardedProto;

    options.KnownNetworks.Clear();
    options.KnownProxies.Clear();

    // Указываем IP самого Nginx — только ему доверяем заголовки
    options.KnownProxies.Add(IPAddress.Parse("10.66.66.1")); // ← IP Nginx
});

// ===== HTTPS Configuration =====
var port = builder.Configuration.GetValue<int>("Server:Port", 5555);

Console.WriteLine($"[START] Chat: https://127.0.0.1:{port}");
Console.WriteLine($"[START] Chat: http://127.0.0.1:5554");


//получение сертификата:
//sudo apt install -y certbot
//sudo certbot certonly --standalone -d fbdda.duckdns.org
builder.WebHost.ConfigureKestrel(options =>
{
    options.Listen(IPAddress.Any, 5554);
    options.Listen(IPAddress.Any, port, listenOptions =>
    {
        var cert = X509Certificate2.CreateFromPemFile(
            "fullchain.pem",
            "privkey.pem"
        );

        if (OperatingSystem.IsWindows())
        {
            using var original = cert;
            cert = new X509Certificate2(
                original.Export(X509ContentType.Pfx)
            );
        }

        listenOptions.UseHttps(
            cert
        );
    });
});





builder.Services.AddHttpContextAccessor();
builder.Services.AddMemoryCache();

// ===== HTTP Client Factory (НУЖНО для OllamaService) =====
builder.Services.AddHttpClient();

// Ollama Configuration
builder.Services.Configure<OllamaSettings>(builder.Configuration.GetSection("Ollama"));
builder.Services.AddSingleton<WebSearchService>();
builder.Services.AddScoped<OllamaService>();

// ===== Database =====
builder.Services.AddDbContext<ChatDbContext>(options =>
{
    options.UseNpgsql(postgreSQLConnection)
       .UseSnakeCaseNamingConvention();
});

builder.Services.AddSingleton<ISessionService, SessionService>();

// ===== SignalR (НАСТРОЙКА ДО app.Build) =====
if (!string.IsNullOrEmpty(redisConnection))
{
    builder.Services.AddSignalR(options =>
    {
        options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
        options.HandshakeTimeout = TimeSpan.FromSeconds(15);
        options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        options.MaximumParallelInvocationsPerClient = 1;
    })
    .AddStackExchangeRedis(redisConnection, options =>
    {
        options.Configuration.ChannelPrefix = RedisChannel.Literal("PolChatApp:");
    });
}
else
{
    builder.Services.AddSignalR(options =>
    {
        options.ClientTimeoutInterval = TimeSpan.FromSeconds(30);
        options.HandshakeTimeout = TimeSpan.FromSeconds(15);
        options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        options.MaximumParallelInvocationsPerClient = 1;
    });
}

builder.Services.AddControllers();

// ===== Background Services =====
builder.Services.AddHostedService<InactiveUsersBackgroundService>();

// ===== Controllers JSON Options =====
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

app.UseForwardedHeaders();
// Одна строка лога: время | метод | путь | IP-цепочка
app.Use(async (ctx, next) =>
{
    var ip = ctx.Request.Headers["X-Forwarded-For"].ToString();
    if (string.IsNullOrEmpty(ip))
        ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";

    Console.WriteLine($"[{DateTime.Now:HH:mm:ss}] {ctx.Request.Method} {ctx.Request.Path} | {ip}");

    await next();
});


// ===== Middleware =====
app.UseRouting();
app.UseStaticFiles();
app.UseCors();
app.UseMiddleware<SessionAuthenticationMiddleware>();
app.MapControllers();
app.MapHub<ChatHub>("/chathub");




app.MapGet("/debug/ip", (HttpContext ctx) => new {
    // Должен показать реальный IP клиента
    remoteIp = ctx.Connection.RemoteIpAddress?.ToString(),
    // Цепочка прокси: "клиент, прокси1, прокси2..."
    xForwardedFor = ctx.Request.Headers["X-Forwarded-For"].ToString(),
    // Реальный IP (от Nginx)
    xRealIp = ctx.Request.Headers["X-Real-IP"].ToString(),
    // Должен быть "https"
    xForwardedProto = ctx.Request.Headers["X-Forwarded-Proto"].ToString(),

    scheme = ctx.Request.Scheme,
});




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

// ===== Startup - Инициализация бота =====
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<ChatDbContext>();
    var aiUser = db.Users.FirstOrDefault(u => u.Username == "AI Assistant");
    if (aiUser == null)
    {
        db.Users.Add(new User
        {
            Username = "AI Assistant",
            Role = "bot",
            Status = "offline",
            IsBot = true,
            CreatedAt = DateTime.UtcNow
        });
        db.SaveChanges();
        Console.WriteLine("[OK] AI Assistant user created with IsBot=true");
    }
    else if (!aiUser.IsBot)
    {
        aiUser.IsBot = true;
        db.SaveChanges();
        Console.WriteLine("[OK] Fixed IsBot flag for AI Assistant");
    }
    else
    {
        Console.WriteLine("[OK] AI Assistant already exists with IsBot=true");
    }

    // Check Ollama health
    var ollamaService = scope.ServiceProvider.GetService<OllamaService>();
    if (ollamaService != null)
    {
        try
        {
            var isOllamaHealthy = await ollamaService.CheckHealthAsync();
            if (isOllamaHealthy)
                Console.WriteLine("[OK] Ollama service is available");
            else
                Console.WriteLine("[WARNING] Ollama service is not available. Make sure Ollama is running on http://localhost:11434");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[WARNING] Cannot connect to Ollama: {ex.Message}");
        }
    }
}


app.Run();//$"https://0.0.0.0:{port}");
