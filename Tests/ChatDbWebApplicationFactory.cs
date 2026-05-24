using ChatApp.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Xunit;

public class ChatDbWebApplicationFactory : WebApplicationFactory<Program>, IAsyncLifetime
{
    // Строка подключения к служебной базе 'postgres' на том же сервере (чтобы управлять другими БД)
    private const string MasterConnectionString = "Host=192.168.2.35;Port=5432;Database=postgres;Username=postgres;Password=1;";

    // Строка подключения к нашей будущей временной тестовой базе
    private const string TestConnectionString = "Host=192.168.2.35;Port=5432;Database=chat_test;Username=postgres;Password=1;";

    // Метод выполнится ОДИН РАЗ ПЕРЕД запуском всех тестов в классе
    public async Task InitializeAsync()
    {
        using var connection = new NpgsqlConnection(MasterConnectionString);
        await connection.OpenAsync();

        // 1. Важный нюанс: Postgres не разрешит клонировать базу 'chat', если к ней кто-то подключен.
        // Этот запрос принудительно разрывает все активные соединения с рабочей базой 'chat'.
        var terminateConnectionsSql = @"
            SELECT pg_terminate_backend(pg_stat_activity.pid)
            FROM pg_stat_activity
            WHERE pg_stat_activity.datname = 'chat' AND pid <> pg_backend_pid();";

        using var terminateCmd = new NpgsqlCommand(terminateConnectionsSql, connection);
        await terminateCmd.ExecuteNonQueryAsync();

        // 2. Удаляем старую тестовую базу, если она осталась от предыдущего упавшего теста.
        // WITH (FORCE) принудительно закроет соединения, если они успели появиться.
        using var dropCmd = new NpgsqlCommand("DROP DATABASE IF EXISTS chat_test WITH (FORCE);", connection);
        await dropCmd.ExecuteNonQueryAsync();

        // 3. Клонируем рабочую базу 'chat' в тестовую 'chat_test' (копируются и схемы, и данные)
        using var cloneCmd = new NpgsqlCommand("CREATE DATABASE chat_test WITH TEMPLATE chat;", connection);
        await cloneCmd.ExecuteNonQueryAsync();
    }

    // Подменяем контекст приложения на тестовую базу данных
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureServices(services =>
        {
            // Находим оригинальную регистрацию DbContext вашего приложения
            var descriptor = services.SingleOrDefault(
                d => d.ServiceType == typeof(DbContextOptions<ChatDbContext>));

            if (descriptor != null)
            {
                services.Remove(descriptor);
            }

            // Регистрируем DbContext заново, но уже с адресом 'chat_test'
            services.AddDbContext<ChatDbContext>(options =>
            {
                options.UseNpgsql(TestConnectionString);
            });
        });
    }

    // Метод выполнится ОДИН РАЗ ПОСЛЕ завершения всех тестов в классе
    public new async Task DisposeAsync()
    {
        using var connection = new NpgsqlConnection(MasterConnectionString);
        await connection.OpenAsync();

        // Полностью удаляем временную базу данных, чтобы не засорять сервер
        using var dropCmd = new NpgsqlCommand("DROP DATABASE IF EXISTS chat_test WITH (FORCE);", connection);
        await dropCmd.ExecuteNonQueryAsync();
    }
}