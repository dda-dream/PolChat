using ChatApp.Models;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.Net.Http.Headers;
using Microsoft.Playwright;
using System.Net;
using System.Net.Http.Json;
using Tests;
using Xunit;

namespace Tests
{
    [Collection("MyTests")]
    public class ChatHubIntegrationTests
    {
        private readonly ChatDbWebApplicationFactory _factory;
        private readonly HttpClient _client;
        public System.Net.Cookie signalrCookie = null;

        public ChatHubIntegrationTests(ChatDbWebApplicationFactory factory)
        {
            _factory = factory;
            _client = factory.SharedClient; // Используем наш живой клиент
        }

        [Fact]
        public async Task Step1_Hub_Connect_And_Authorize()
        {
            // 1. ШАГ: Авторизуемся (если кука еще не установлена в прошлых тестах)
            var loginCredentials = new { Username = "dddMobile", Password = "123" };
            var loginResponse = await _client.PostAsJsonAsync("/api/auth/login", loginCredentials);
            Assert.Equal(HttpStatusCode.OK, loginResponse.StatusCode);

            // Извлекаем куку SESSION_ID из HttpClient, чтобы отдать её SignalR клиенту
            var cookieContainer = new CookieContainer();
            var uri = new Uri("http://localhost"); // Базовый адрес TestServer по умолчанию


            if (loginResponse.Headers.TryGetValues(HeaderNames.SetCookie, out var setCookieHeaders))
            {
                foreach (var header in setCookieHeaders)
                {
                    // Парсим строку заголовка во встроенную структуру ASP.NET Core
                    if (SetCookieHeaderValue.TryParse(header, out var parsedCookie))
                    {
                        // Проверяем, что это именно наша кука сессии
                        if (parsedCookie.Name == "SESSION_ID")
                        {
                            // Создаем стандартный System.Net.Cookie, который поймет SignalR клиент
                            signalrCookie = new System.Net.Cookie(
                                parsedCookie.Name.ToString(),
                                parsedCookie.Value.ToString(),
                                parsedCookie.Path.ToString() ?? "/",
                                "localhost" // ОБЯЗАТЕЛЬНО: укажите хост, иначе кука не прикрепится к запросу
                            );
                            break;
                        }
                    }
                }
            }

            string cookieHeaderValue = null;
            if (loginResponse.Headers.TryGetValues("Set-Cookie", out var cookies))
            {
                // Находим заголовок нашей сессии (он выглядит как "SESSION_ID=значение; path=/; ...")
                var sessionCookie = cookies.FirstOrDefault(c => c.StartsWith("SESSION_ID="));
                if (sessionCookie != null)
                {
                    // Нам нужна только первая часть до точки с запятой: "SESSION_ID=наш_токен"
                    cookieHeaderValue = sessionCookie.Split(';')[0];
                }
            }

            // Если вы используем стандартный CookieContainer в HttpClientHandler:
            // (Или вы можете вытащить её вручную из заголовка 'Set-Cookie' ответа loginResponse)
            var authCookie = new System.Net.Cookie("SESSION_ID", signalrCookie.Value, "/", "localhost");

            // 2. ШАГ: Настраиваем подключение к Хабу
            var hubConnection = new HubConnectionBuilder()
                .WithUrl("http://localhost/chatHub", options => // Укажите ваш route к хабу
                {
                    // Подсовываем хэндлер нашего тестового сервера (КРИТИЧНО)
                    options.HttpMessageHandlerFactory = _ => _factory.Server.CreateHandler();

                    // Переключаем на Long Polling, так как WebSockets в памяти не заведутся
                    options.Transports = HttpTransportType.LongPolling;

                    // Передаем нашу куку авторизации
                    //options.Cookies.Add(authCookie);
                    options.Headers.Add("Cookie", cookieHeaderValue);
                })
                .Build();

            // 3. ШАГ: Настраиваем перехват ответа от сервера
            // Используем TaskCompletionSource, чтобы тест подождал, пока сервер пришлет сообщение назад
            var tcs = new TaskCompletionSource<string>();

            hubConnection.On<string>("ReceiveMessage", (message) =>
            {
                // Метод-клиент на сервере вызвал: Clients.All.SendAsync("ReceiveMessage", ...)
                tcs.SetResult(message);
            });

            // Открываем соединение
            await hubConnection.StartAsync();

            // 4. ШАГ: Вызываем метод Хаба (ЗДЕСЬ МОЖНО СТАВИТЬ БРЕЙКПОИНТ В КОД ХАБА)
            // Допустим, у вас в хабе есть метод: public async Task SendMessage(string msg)
            await hubConnection.InvokeAsync("LeaveChannel", "ChannelId--");

            // 5. ШАГ: Проверяем, что сообщение дошло до клиентов
            // Ждем максимум 3 секунды, чтобы тест не завис навсечь в случае ошибки
            var receivedMessage = await tcs.Task.WaitAsync(TimeSpan.FromSeconds(60));

            Assert.Equal("Привет из xUnit!", receivedMessage);

            // Чистим за собой
            await hubConnection.StopAsync();
        }
    }
}