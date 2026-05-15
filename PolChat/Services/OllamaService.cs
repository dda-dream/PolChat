using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using System.Text;
using System.Text.Json;

namespace ChatApp.Services;

public class OllamaService
{
    private readonly HttpClient _httpClient;
    private readonly ILogger<OllamaService> _logger;
    private readonly IMemoryCache _cache;
    private readonly OllamaSettings _settings;

    public OllamaService(
        IOptions<OllamaSettings> settings,
        IHttpClientFactory httpClientFactory,
        ILogger<OllamaService> logger,
        IMemoryCache memoryCache)
    {
        _settings = settings.Value;
        _httpClient = httpClientFactory.CreateClient();
        _httpClient.BaseAddress = new Uri(_settings.Url);
        _httpClient.Timeout = TimeSpan.FromSeconds(_settings.TimeoutSeconds);
        _logger = logger;
        _cache = memoryCache;
    }

    public async Task<string> GenerateResponseAsync(
        string userMessage,
        string? context = null,
        CancellationToken cancellationToken = default)
    {
        try
        {
            // Проверяем кэш
            string cacheKey = $"ollama_{userMessage}_{context?.GetHashCode()}";
            if (_cache.TryGetValue(cacheKey, out string? cachedResponse) && cachedResponse != null)
            {
                return cachedResponse;
            }

            var request = new
            {
                model = _settings.Model,
                prompt = BuildPrompt(userMessage, context),
                stream = false,
                options = new
                {
                    temperature = _settings.Temperature,
                    top_p = 0.9,
                    max_tokens = _settings.MaxTokens
                }
            };

            var content = new StringContent(
                JsonSerializer.Serialize(request),
                Encoding.UTF8,
                "application/json");

            var response = await _httpClient.PostAsync("/api/generate", content, cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogError("Ollama API error: {StatusCode}", response.StatusCode);
                return "Извините, AI-ассистент временно недоступен.";
            }

            var responseJson = await response.Content.ReadAsStringAsync(cancellationToken);
            var result = JsonSerializer.Deserialize<OllamaResponse>(responseJson);

            string aiResponse = result?.response ?? "Не удалось получить ответ от AI.";

            // Кэшируем на 5 минут
            _cache.Set(cacheKey, aiResponse, TimeSpan.FromMinutes(5));

            return aiResponse;
        }
        catch (TaskCanceledException)
        {
            _logger.LogWarning("Ollama request timeout after {Timeout} seconds", _settings.TimeoutSeconds);
            return "AI-ассистент не ответил в течение допустимого времени.";
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error calling Ollama API");
            return "Произошла ошибка при обращении к AI-ассистенту.";
        }
    }

    private string BuildPrompt(string userMessage, string? context)
    {
        var prompt = new StringBuilder();

        prompt.AppendLine("Ты - полезный AI-ассистент в чате. Отвечай дружелюбно и по делу.");
        prompt.AppendLine("Будь кратким и понятным. Без лишних эмодзи, но с хорошим юмором - шути побольше.");
        prompt.AppendLine();

        if (!string.IsNullOrEmpty(context))
        {
            prompt.AppendLine($"Контекст: {context}");
            prompt.AppendLine();
        }

        prompt.AppendLine($"Пользователь: {userMessage}");
        prompt.AppendLine("Ассистент:");

        return prompt.ToString();
    }

    public async Task<bool> CheckHealthAsync()
    {
        try
        {
            var response = await _httpClient.GetAsync("/api/tags");
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private class OllamaResponse
    {
        public string? response { get; set; }
        public bool done { get; set; }
    }
}