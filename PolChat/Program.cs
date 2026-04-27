using ChatApp.Data;
using ChatApp.Hubs;
using ChatApp.Services;
using Microsoft.AspNetCore.Rewrite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.FileProviders;
using Microsoft.OpenApi;
using Serilog;
using StackExchange.Redis;
using System.Text;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseSerilog();

// Настройка самого Serilog
Log.Logger = new LoggerConfiguration()
    .WriteTo.Console()
    .CreateLogger();

// Подключение к хосту
builder.Host.UseSerilog();

// ===== Configuration =====
var connectionString = builder.Configuration.GetConnectionString("DefaultConnection");
var redisConnection = builder.Configuration.GetConnectionString("Redis");

// ===== Database =====
builder.Services.AddDbContext<ChatDbContext>(options =>
    {
        options.UseNpgsql(connectionString);
           //.UseSnakeCaseNamingConvention()
    });

// ===== Redis =====
builder.Services.AddSingleton<IConnectionMultiplexer>(sp =>
{
    var config = ConfigurationOptions.Parse(redisConnection);
    return ConnectionMultiplexer.Connect(config);
});
builder.Services.AddSingleton<ISessionService, SessionService>();

// ===== SignalR =====
builder.Services.AddSignalR();

// ===== Background Services =====
builder.Services.AddHostedService<InactiveUsersBackgroundService>();

// ===== Controllers =====
builder.Services.AddControllers()
    .AddJsonOptions(options =>
    {
        options.JsonSerializerOptions.DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull;
    });

// ===== Swagger =====
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(c =>
{
    c.SwaggerDoc("v1", new OpenApiInfo
    {
        Title = "Chat API",
        Version = "1.0.0",
        Description = "Chat REST API (ASP.NET Core + PostgreSQL + Redis + SignalR)"
    });
});

// ===== CORS (for development) =====
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


app.UseRouting();

app.UseStaticFiles();
/*
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(@"C:\0\PolChat\uploads\"),
    RequestPath = "/uploads"
});
*/







// ===== Middleware =====
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI(c => c.SwaggerEndpoint("/swagger/v1/swagger.json", "Chat API v1"));
}

app.UseCors();



app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.MapHub<ChatHub>("/chathub");




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
    Console.WriteLine("[OK] База данных инициализирована");
}

// ===== HTTPS Configuration =====
var port = builder.Configuration.GetValue<int>("Server:Port");
var useHttps = builder.Configuration.GetValue<bool>("Server:UseHttps", false);

Console.WriteLine($"[START] Chat: {(useHttps ? "https" : "http")}://localhost:{port} (ASP.NET Core + Redis + SignalR)");

if (useHttps)
{
    app.Run($"https://0.0.0.0:{port}");
}
else
{
    app.Run($"http://0.0.0.0:{port}");
}
