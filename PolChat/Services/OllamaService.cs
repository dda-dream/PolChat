using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Microsoft.OpenApi;
using System.Collections.Concurrent;
using System.ComponentModel.DataAnnotations;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using static System.Net.Mime.MediaTypeNames;

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
        _searchHttpClient.DefaultRequestHeaders.Add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");
        _searchHttpClient.DefaultRequestHeaders.Add("Accept", "application/json, text/plain, */*");
        _searchHttpClient.DefaultRequestHeaders.Add("Accept-Language", "ru-RU,ru;q=0.9,en;q=0.8");

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

            var message = new List<object>
                {
                    new
                    {
                        role = "system",
                        content = @"проверь, требуется ли поиск в интернете для промта user. 
                                    если поиск нужен: выведи только список запросов через ';'.
                                    если поиск не нужен, выведи 'поиск не нужен'
                                    если user спрашивает о сообщениях чата, выведи 'поиск не нужен'
                                    никаких других вариантов ответа не выводи"
                    },
                    new
                    {
                        role = "assistant",
                        content = @"проверь, требуется ли поиск в интернете для промта user. 
                                    если поиск нужен: выведи только список запросов через ';'.
                                    если поиск не нужен, выведи 'поиск не нужен'
                                    если user спрашивает о сообщениях чата, выведи 'поиск не нужен'
                                    никаких других вариантов ответа не выводи"
                    },
                    new
                    {
                        role = "user",
                        content = userMessage
                    }
                };

            
            message.Insert(1, new { role = "assistant", content = context });

            await _webSearch.NotifySearchStatus(connectionId, "Проверяется необходимость поиска в интернете...", "info");

            // 1. получаем ссылки для поиска через CallOllamaApiAsync
            string a = await CallOllamaApiAsync(message, cancellationToken);

            

            if (a.Contains("поиск не нужен"))
            {
                await _webSearch.NotifySearchStatus(connectionId, "Поиск не нужен", "info");
                var messageForAI = new List<object>
                {
                    new
                    {
                        role = "system",
                        content = @"ответь на сообщение. если нужно, используй system(контекст чата)"
                    },
                    new
                    {
                        role = "system",
                        content = context
                    },
                    new
                    {
                        role = "user",
                        content = userMessage
                    }
                };
                //await _webSearch.NotifySearchStatus(connectionId, $"[Сообщение ИИ] {context}", "info");
                await _webSearch.NotifySearchStatus(connectionId, "Отправляем сообщение в ИИ...", "info");
                string messageFromAI = await CallOllamaApiAsync(messageForAI, cancellationToken);

                return messageFromAI;
            }
            else
            {
                await _webSearch.NotifySearchStatus(connectionId, "Поиск нужен", "info");
                char[] delimiters = { ';', '\r', '\n' };
                string[] parts = a.Split(
                    delimiters,
                    StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                //2. из полученной строки - получаем List<string> запросов
                List<string> listZaprosov = parts.ToList();

                
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

                await _webSearch.NotifySearchStatus(connectionId, "[Все поисковые запросы] " + "\n" + str, "info");
                if (listZaprosov.Count > 10)
                {
                    return "Произошла ошибка: поисковых запросов больше 10";
                }
                await _webSearch.NotifySearchStatus(connectionId, "Получаем ссылки по каждому запросу...", "info");
                // в цикле по запросам получсать по кажому запросу набор ссылок
                // и добпавлять их в Liast<strng>
                var allUrls = new List<string>();
                foreach (var zapros in listZaprosov)
                {
                    var searchUrls = await LookUrlForSearch(zapros, connectionId);
                    allUrls = allUrls.Union(searchUrls).ToList();
                }
                await _webSearch.NotifySearchStatus(connectionId, "Читаем ссылки...", "info");
                var searchResults = await MySearchAsync(allUrls, connectionId);
                foreach (SearchResult result in searchResults)
                {
                    await _webSearch.NotifySearchStatus(connectionId, $"[Ссылка] {result.Url}, [Контент] {result.Content}", "info");
                    slovar.Add(result.Url, result.Content);
                }
                //foreach (var zapros in listZaprosov)
                //{
                //    await _webSearch.NotifySearchStatus(connectionId, "[ZAPROS] " + "\n" + zapros, "info");
                //    var searchResults = await PerformDeepWebSearchAsync(zapros, cancellationToken, connectionId);
                //    slovar.Add(zapros, searchResults);
                //    await _webSearch.NotifySearchStatus(connectionId, "[INFO] " + "\n" + searchResults, "info");
                //}

                await _webSearch.NotifySearchStatus(connectionId, $"[INFO] Поиск завершен. Подготовка данных для отправки в ИИ.", "info");


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
                        content = @"Отформатируй и структурируй информацию от user."
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
                await _webSearch.NotifySearchStatus(connectionId, $"[INFO] Длина текущего контекста: {content.Length} байт.", "info");

                string answer = await CallOllamaApiAsync(mess, cancellationToken);
                return answer;
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error in GenerateResponseAsync");
            return "Произошла ошибка при обработке запроса.";
        }
    }

    public async Task<List<string>> LookUrlForSearch(string query, string? connectionId = null, int maxConcurrency = 10)
    {
        var results = new ConcurrentBag<SearchResult>();

        try
        {
            _logger.LogInformation("Searching for: {Query}", query);

            string url = $"https://html.duckduckgo.com/html/search?q={Uri.EscapeDataString(query)}";


            var urls = await _webSearch.ExtractUrlsStepByStepAsync(url);

            return urls;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Search failed for query: {Query}", query);

            return new List<string>();
        }
    }

    public async Task<List<SearchResult>> MySearchAsync(List<string> urls, string? connectionId = null, int maxConcurrency = 5)
    {
        var results = new ConcurrentBag<SearchResult>();

        try
        {

            // Создаем Semaphore для ограничения параллелизма
            using var semaphore = new SemaphoreSlim(maxConcurrency);

            // Создаем задачи для параллельной обработки
            var tasks = urls.Select((resultUrl, index) => _webSearch.ProcessUrlAsync(
                resultUrl,
                index + 1,
                urls.Count,
                connectionId,
                semaphore,
                results)).ToList();

            // Ожидаем завершения всех задач
            await Task.WhenAll(tasks);


            _logger.LogInformation("Found {Count} results", results.Count);
            return results.ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Search failed for query: {Query}", urls);
            return results.ToList();
        }
    }

    private async Task<string> PerformDeepWebSearchAsync(string query, CancellationToken cancellationToken, string? connectionId = null)
    {
        try
        {
            _logger.LogInformation("Starting deep web search for: {Query}", query);

            // Передаем connectionId в SearchAsync
            var searchResults = await _webSearch.SearchAsync(query, connectionId);

            if (!searchResults.Any())
            {
                return "По вашему запросу ничего не найдено.";
            }

            var pageContents = new List<string>();
            foreach (var result in searchResults)
            {
                if (!string.IsNullOrEmpty(result.Content))
                {
                    pageContents.Add(result.Content);
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