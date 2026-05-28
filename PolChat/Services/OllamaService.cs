using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Microsoft.OpenApi;
using System.ComponentModel.DataAnnotations;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace ChatApp.Services;

public class OllamaService
{
    private readonly HttpClient _httpClient;
    private readonly ILogger<OllamaService> _logger;
    private readonly IMemoryCache _cache;
    private readonly OllamaSettings _settings;
    private readonly HttpClient _searchHttpClient;
    private readonly WebSearchService _webSearch;

    public OllamaService(
        IOptions<OllamaSettings> settings,
        IHttpClientFactory httpClientFactory,
        ILogger<OllamaService> logger,
        IMemoryCache memoryCache,
        WebSearchService webSearch)
    {
        _webSearch = webSearch;
        _settings = settings.Value;
        _httpClient = httpClientFactory.CreateClient();
        _httpClient.BaseAddress = new Uri(_settings.Url);
        _httpClient.Timeout = TimeSpan.FromSeconds(_settings.TimeoutSeconds);

        _searchHttpClient = httpClientFactory.CreateClient();
        _searchHttpClient.Timeout = TimeSpan.FromSeconds(30);
        _searchHttpClient.DefaultRequestHeaders.Add("User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
        _searchHttpClient.DefaultRequestHeaders.Add("Accept",
            "application/json, text/plain, */*");
        _searchHttpClient.DefaultRequestHeaders.Add("Accept-Language",
            "ru-RU,ru;q=0.9,en;q=0.8");

        if (!string.IsNullOrEmpty(_settings.ApiKey))
        {
            _httpClient.DefaultRequestHeaders.Add("Authorization", $"Bearer {_settings.ApiKey}");
        }

        _logger = logger;
        _cache = memoryCache;
    }

    public async Task<string> GenerateResponseAsync(
        string userMessage,
        string? context = null,
        CancellationToken cancellationToken = default,
        string? connectionId = null) 
    {
        try
        {
            if (NeedsWebSearch(userMessage) || true)
            {

                var message = new List<object>
                {
                    new
                    {
                        role = "system",
                        content = @"проверь, требуется ли поиск в интернете для промта user. если поиск нужен: выведи только список запросов в интернет без лишних слов."
                    },
                    new
                    {
                        role = "user",
                        content = userMessage
                    }
                };

                if (!string.IsNullOrEmpty(context))
                {
                    message.Insert(1, new { role = "assistant", content = context });
                }
                // 1. получаем ссылки для поиска через CallOllamaApiAsync
                string a = await CallOllamaApiAsync(message, cancellationToken);
                //2. из полученной строки - получаем List<string> запросов
                List<string> listZaprosov = a.Split("\n").ToList();
                if (listZaprosov.Count > 10)
                    return "Произошла ошибка: поисковых запросов больше 10";
                
                //3. по каждому элементу в коллекции вызываем GenerateResponseWithContextAsync и получаем результат поиска
                //по одному запросу.
                //Сохраняем результат поиска в словаре Dictionary<string, string>  где ключ - это запрос,
                //а значение - результат поиска через GenerateResponseWithContextAsync
                Dictionary<string, string> slovar = new Dictionary<string, string>();
                string str = string.Empty;
                foreach (var zapros in listZaprosov)
                {
                    str += zapros + "\n";
                }
                await _webSearch.NotifySearchStatus(connectionId, str, "info");
                foreach (var zapros in listZaprosov)
                {
                    var searchResults = await PerformDeepWebSearchAsync(zapros, cancellationToken, connectionId);
                    slovar.Add(zapros, searchResults);
                }

                //4. собираем словарь в 1 строку и отправляем в CallOllamaApiAsync
                String content = string.Empty; 
                foreach (var slova in slovar)
                {
                    content += slova.Value + "\n";
                }
                List<object> mess = new List<object>
                {
                    new
                    {
                        role = "system",
                        content = @"Отформатируй и структурируй информацию от user и представь в виде подробного сообщения."
                    },
                    new
                    {
                        role = "user",
                        content = content
                    },
                    new
                    {
                        role = "user",
                        content = userMessage
                    }
                }
                    ;
                string answer = await CallOllamaApiAsync(mess, cancellationToken);
                return answer;

            }
            else
            {
                return ":(";
            }


            //_logger.LogInformation("Web search needed for: {UserMessage}", userMessage);
            //        var searchResults = await PerformDeepWebSearchAsync(userMessage, cancellationToken, connectionId);
            //        var l = searchResults.Length;
            //        if (!string.IsNullOrEmpty(searchResults))
            //        {
            //            return await GenerateResponseWithContextAsync(userMessage, searchResults, cancellationToken);
            //        }


            //    var messages = new List<object>
            //    {
            //        new
            //        {
            //            role = "system",
            //            content = @"Ты - полезный AI-ассистент в чате. Отвечай дружелюбно и по делу. Будь кратким и понятным."
            //        },
            //        new
            //        {
            //            role = "user",
            //            content = userMessage
            //        }
            //    };

            //    if (!string.IsNullOrEmpty(context))
            //    {
            //        messages.Insert(1, new { role = "assistant", content = context });
            //    }

            //    return await CallOllamaApiAsync(messages, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GenerateResponseAsync");
            return "Произошла ошибка при обработке запроса.";
        }
    }

    private async Task<string> PerformDeepWebSearchAsync(string query, CancellationToken cancellationToken, string? connectionId = null)
    {
        try
        {
            _logger.LogInformation("Starting deep web search for: {Query}", query);

            // Передаем connectionId в SearchAsync
            var searchResults = await _webSearch.SearchAsync(query, 3, connectionId);

            if (!searchResults.Any())
            {
                return "По вашему запросу ничего не найдено.";
            }

            var pageContents = new List<string>();
            foreach (var result in searchResults)
            {
                if (!string.IsNullOrEmpty(result.Snippet))
                {
                    pageContents.Add(result.Snippet);
                }
            }

            var allContent = string.Join("\n\n---\n\n", pageContents);

            return allContent;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Deep web search failed");
            return $"Ошибка при поиске: {ex.Message}";
        }
    }


    private bool NeedsWebSearch(string userMessage)
    {
        var keywords = new[]
        {
            "ищи", "искать", "найди"
        };

        var lowerMessage = userMessage.ToLower();
        return keywords.Any(k => lowerMessage.Contains(k));
    }


    private async Task<string> CallOllamaApiAsync(List<object> messages, CancellationToken cancellationToken)
    {
        var request = new
        {
            model = _settings.Model,
            messages = messages,
            stream = false,
            temperature = _settings.Temperature,
            max_tokens = _settings.MaxTokens,
            think = _settings.ReasoningEffort
        };

        var jsonRequest = JsonSerializer.Serialize(request);
        var content = new StringContent(jsonRequest, Encoding.UTF8, "application/json");
        var response = await _httpClient.PostAsync("/api/chat", content, cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(cancellationToken);
            _logger.LogError("Ollama API error: {StatusCode}, Body: {ErrorBody}",
                response.StatusCode, errorBody);
            return "Извините, AI-ассистент временно недоступен.";
        }

        var responseJson = await response.Content.ReadAsStringAsync(cancellationToken);
        var result = JsonSerializer.Deserialize<OllamaChatResponse>(responseJson);

        return result?.message?.content ?? "Не удалось получить ответ от AI.";
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

    private class OllamaChatResponse
    {
        public OllamaMessage? message { get; set; }
        public bool done { get; set; }
    }

    private class OllamaMessage
    {
        public string? role { get; set; }
        public string? content { get; set; }
    }
}