using ChatApp.Models;
using System.Net;
using System.Net.Http.Json;
using Xunit;

public class ChatIntegrationTests : IClassFixture<ChatDbWebApplicationFactory>
{
    private readonly HttpClient _client;

    public ChatIntegrationTests(ChatDbWebApplicationFactory factory)
    {
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task GetMessages_ReturnsDataFromCopiedDatabase()
    {
        // Act - делаем запрос к вашему контроллеру (например, история чата)
        var response = await _client.GetAsync("/login");

        // Assert
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var messages = await response.Content.ReadFromJsonAsync<List<MessageDto>>();

        // База небольшая, проверяем, что данные успешно скопировались и эндпоинт их видит
        Assert.NotNull(messages);
        Assert.NotEmpty(messages);
    }
}