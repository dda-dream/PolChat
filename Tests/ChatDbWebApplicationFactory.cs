using ChatApp.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Npgsql;
using Xunit;


namespace Tests // 1. Явно помещаем всё в namespace "Tests"
{


    public class ChatDbWebApplicationFactory : WebApplicationFactory<Program>, IAsyncLifetime
    {
        private const string MasterConnectionString = "Host=192.168.2.35;Port=5432;Database=postgres;Username=postgres;Password=1;";
        private const string TestConnectionString = "Host=192.168.2.35;Port=5432;Database=chat_test;Username=postgres;Password=1;";

        public HttpClient SharedClient { get; private set; }

        // ГЛОБАЛЬНЫЙ СТАТИЧЕСКИЙ ЗАМОК И ФЛАГ КОНТРОЛЯ
        private static readonly SemaphoreSlim _semaphore = new SemaphoreSlim(1, 1);
        private static bool _isDatabaseCreated = false;

        public async Task InitializeAsync()
        {
            // 1. Входим в замок. Если другой поток уже создает базу, текущий будет послушно ждать.
            await _semaphore.WaitAsync();
            try
            {
                // 2. Проверяем, не создал ли базу кто-то до нас
                if (!_isDatabaseCreated)
                {
                    using var connection = new NpgsqlConnection(MasterConnectionString);
                    await connection.OpenAsync();

                    // Отключаем активные соединения от шаблона 'chat'
                    var terminateSql = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'chat' AND pid <> pg_backend_pid();";
                    using var terminateCmd = new NpgsqlCommand(terminateSql, connection);
                    await terminateCmd.ExecuteNonQueryAsync();

                    // Удаляем старую тестовую базу
                    using var dropCmd = new NpgsqlCommand("DROP DATABASE IF EXISTS chat_test WITH (FORCE);", connection);
                    await dropCmd.ExecuteNonQueryAsync();

                    // Создаем ровно ОДНУ тестовую базу на всю сессию запуска тестов
                    using var cloneCmd = new NpgsqlCommand("CREATE DATABASE chat_test WITH TEMPLATE chat;", connection);
                    await cloneCmd.ExecuteNonQueryAsync();

                    // Переключаем флаг, чтобы следующие потоки сюда не заходили
                    _isDatabaseCreated = true;
                }
            }
            finally
            {
                // 3. Обязательно освобождаем замок
                _semaphore.Release();
            }

            // Клиент создается для каждого тест-класса свой, но смотрит в одну и ту же базу
            SharedClient = CreateClient();
        }

        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            builder.ConfigureServices(services =>
            {
                var descriptor = services.SingleOrDefault(d => d.ServiceType == typeof(DbContextOptions<ChatDbContext>));
                if (descriptor != null) services.Remove(descriptor);

                services.AddDbContext<ChatDbContext>(options => options.UseNpgsql(TestConnectionString));

                services.AddSignalR(options =>
                {
                    options.EnableDetailedErrors = true;
                });
            });
        }

        public new async Task DisposeAsync()
        {
            SharedClient?.Dispose();

            using var connection = new NpgsqlConnection(MasterConnectionString);
            await connection.OpenAsync();

            using var dropCmd = new NpgsqlCommand("DROP DATABASE IF EXISTS chat_test WITH (FORCE);", connection);
            await dropCmd.ExecuteNonQueryAsync();
        }
    }
}