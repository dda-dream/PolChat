using Microsoft.EntityFrameworkCore;
using ChatApp.Models;

namespace ChatApp.Data;

public static class DbInitializer
{
    public static async Task InitializeAsync(ChatDbContext db)
    {
        // EnsureCreated will create tables if they don't exist.
        // Run init_db.sql manually for first-time setup if you prefer raw SQL.
        try
        {
            await db.Database.EnsureCreatedAsync();
        }
        catch (Exception ex)
        {
            Console.WriteLine($"[WARN] EnsureCreated failed (tables may already exist): {ex.Message}");
        }

        var userCount = await db.Users.CountAsync();
        if (userCount == 0)
        {
            var now = DateTime.UtcNow;
            var admin = new User
            {
                Username = "admin",
                Password = ComputeSha256Hash("admin123"),
                Role = "admin",
                CreatedAt = now,
                Avatar = "default.png",
                Status = "offline"
            };
            db.Users.Add(admin);

            var general = new Channel
            {
                Id = "general",
                Name = "Общий",
                Description = "Общий канал для всех пользователей",
                CreatedBy = "admin",
                CreatedAt = now,
                IsPrivate = false
            };
            db.Channels.Add(general);

            await db.SaveChangesAsync();
            Console.WriteLine("[OK] БД инициализирована: admin + general");
        }

        var aiUser = await db.Users.FirstOrDefaultAsync(u => u.Username == "AI Assistant");
        if (aiUser == null)
        {
            db.Users.Add(new User
            {
                Username = "AI Assistant",
                Password = Guid.NewGuid().ToString(),
                Role = "system",
                Status = "online",
                CreatedAt = DateTime.UtcNow,
                LastSeen = DateTime.UtcNow
            });
            await db.SaveChangesAsync();
        }

        Console.WriteLine("[OK] Индексы созданы/проверены");
    }

    public static string ComputeSha256Hash(string raw)
    {
        using var sha = System.Security.Cryptography.SHA256.Create();
        var bytes = System.Text.Encoding.UTF8.GetBytes(raw);
        var hash = sha.ComputeHash(bytes);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
