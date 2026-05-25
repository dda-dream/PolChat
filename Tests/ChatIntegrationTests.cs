using ChatApp.Models;
using System.Net;
using System.Net.Http.Json;
using Xunit;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace Tests // 1. Явно помещаем всё в namespace "Tests"
{

    public class AlphabeticalOrderer : ITestCaseOrderer
    {
        public IEnumerable<TTestCase> OrderTestCases<TTestCase>(IEnumerable<TTestCase> testCases)
            where TTestCase : ITestCase
        {
            var result = testCases.ToList();
            // Просто сортируем тесты по имени метода (A-Z)
            result.Sort((x, y) => StringComparer.OrdinalIgnoreCase.Compare(
                x.TestMethod.Method.Name,
                y.TestMethod.Method.Name));
            return result;
        }
    }


    [CollectionDefinition("MyTests")]
    public class MyTestsCollection : ICollectionFixture<ChatDbWebApplicationFactory>
    {
        // Этот класс не содержит кода. 
        // Он нужен только для того, чтобы повесить атрибуты [CollectionDefinition] и ICollectionFixture.
    }





    [Collection("MyTests")]
    // Подключаем наш сортировщик. 
    // Первый параметр — полное имя класса с namespace, второй — название вашей тестовой сборки (обычно имя проекта тестов)
    [TestCaseOrderer("Tests.AlphabeticalOrderer", "Tests")]
    public class ChatIntegrationTests
    {
        private readonly HttpClient _client;

        public ChatIntegrationTests(ChatDbWebApplicationFactory factory)
        {
            // Берем один и тот же экземпляр клиента, который помнит куки!
            _client = factory.SharedClient;
        }

        [Fact]
        public async Task Step01_Login_ShouldAuthenticateAndSetCookie()
        {
            // Arrange
            var loginCredentials = new { Username = "dddMobile", Password = "123" };

            // Act - отправляем запрос на логин
            var response = await _client.PostAsJsonAsync("/api/auth/login", loginCredentials);

            // Assert
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            // На этом этапе сервер возвращает "Set-Cookie: SESSION_ID=...", 
            // и наш _client его автоматически запоминает внутри себя.
        }

        /*

        [Fact]
        public async Task Step02_ApiInitialData_ShouldWorkWithSessionCookie()
        {
            // Act - запрос идет на защищенный эндпоинт. 
            // _client автоматически прикрепит куку SESSION_ID, полученную на Шаге 1
            var response = await _client.GetAsync("/api/initial_data");

            // Assert
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);

            var messages = await response.Content.ReadFromJsonAsync<List<MessageDto>>();
            Assert.NotNull(messages);
            Assert.NotEmpty(messages);
        }

        [Fact]
        public async Task Step03_GetMessages_ShouldAlsoWork()
        {
            // Act - проверяем следующий шаг, кука всё еще жива
            var response = await _client.GetAsync("/api/messages/history");

            // Assert
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }

        */



    }
}




