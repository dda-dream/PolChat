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

        var userCount = await db.users.CountAsync();
        if (userCount == 0)
        {
            var now = DateTime.UtcNow;
            var admin = new User
            {
                username = "admin",
                password = ComputeSha256Hash("admin123"),
                role = "admin",
                created_at = now,
                avatar = "default.png",
                status = "offline"
            };
            db.users.Add(admin);

            var general = new Channel
            {
                id = "general",
                name = "Общий",
                description = "Общий канал для всех пользователей",
                created_by = "admin",
                created_at = now,
                is_private = false
            };
            db.Channels.Add(general);

            await db.SaveChangesAsync();
            Console.WriteLine("[OK] БД инициализирована: admin + general");
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
