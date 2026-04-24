using ChatApp.Data;
using ChatApp.Hubs;
using ChatApp.Services;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

// ===== Configuration =====
var connectionString = builder.Configuration.GetConnectionString("DefaultConnection")
    ?? "Host=localhost;Port=5432;Database=chat;Username=postgres;Password=1";
var redisConnection = builder.Configuration.GetConnectionString("Redis")
    ?? "localhost:6379";

// ===== Database =====
builder.Services.AddDbContext<ChatDbContext>(options =>
    options.UseNpgsql(connectionString));

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
    c.SwaggerDoc("v1", new()
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

// ===== Middleware =====
if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI(c => c.SwaggerEndpoint("/swagger/v1/swagger.json", "Chat API v1"));
}

app.UseCors();
app.UseStaticFiles();
app.UseAuthentication();
app.UseAuthorization();
app.MapControllers();
app.MapHub<ChatHub>("/chathub");

// ===== Startup =====
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<ChatDbContext>();
    await DbInitializer.InitializeAsync(db);
    Console.WriteLine("[OK] База данных инициализирована");
}

// ===== HTTPS Configuration =====
var port = builder.Configuration.GetValue<int>("Server:Port", 5555);
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
