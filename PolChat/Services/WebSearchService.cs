// WebSearchService.cs
using ChatApp.Hubs;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Playwright;
using System.Collections.Concurrent;
using System.Text.RegularExpressions;

namespace ChatApp.Services;

public class WebSearchService : IAsyncDisposable
{
    private readonly ILogger<WebSearchService> _logger;
    private IPlaywright? _playwright;
    private IBrowser? _browser;
    private readonly SemaphoreSlim _semaphore = new(1, 1);
    IHubContext<ChatHub> _hubContext;

    public WebSearchService(ILogger<WebSearchService> logger, IHubContext<ChatHub> hubContext)
    {
        _logger = logger;
        _hubContext = hubContext;
    }

    private async Task<IBrowser> GetBrowserAsync()
    {
        if (_browser == null || !_browser.IsConnected)
        {
            await _semaphore.WaitAsync();
            try
            {
                if (_browser == null || !_browser.IsConnected)
                {
                    _playwright = await Playwright.CreateAsync();
                    _browser = await _playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
                    {
                        Channel = "chromium",
                        Headless = true,
                        SlowMo = 100,
                        Args = new[]
                        {
                        "--disable-blink-features=AutomationControlled", 
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--disable-features=IsolateOrigins,site-per-process",
                        "--disable-web-security",
                        "--disable-features=BlockInsecurePrivateNetworkRequests",
                        "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                        }
                    });
                    _logger.LogInformation("Browser launched");
                }
            }
            finally
            {
                _semaphore.Release();
            }
        }
        return _browser;
    }

    public async Task<List<SearchResult>> SearchAsync(string query, string? connectionId = null, int maxConcurrency = 10)
    {
        var results = new ConcurrentBag<SearchResult>();

        try
        {
            // Отправляем статус начала поиска
            await NotifySearchStatus(connectionId, " Начинаем поиск в интернете...", "searching");

            _logger.LogInformation("Searching DuckDuckGo for: {Query}", query);

            string url = $"https://html.duckduckgo.com/html/search?q={Uri.EscapeDataString(query)}";

            

            // Отправляем статус получения ссылок
            await NotifySearchStatus(connectionId, " Получаем ссылки из поисковой выдачи...", "fetching_links");

            var urls = await ExtractUrlsStepByStepAsync(url);

            string result = string.Join("\n", urls);
            await NotifySearchStatus(connectionId, "[URLS] " + "\n" + result, "info");

            var urlsToProcess = urls.ToList();
            var totalToProcess = urlsToProcess.Count;

            await NotifySearchStatus(connectionId, $" Найдено {totalToProcess} ссылок. Начинаем параллельный анализ...", "links_found", totalToProcess);

            // Создаем Semaphore для ограничения параллелизма
            using var semaphore = new SemaphoreSlim(maxConcurrency);

            // Создаем задачи для параллельной обработки
            var tasks = urlsToProcess.Select((resultUrl, index) => ProcessUrlAsync(
                resultUrl,
                index + 1,
                totalToProcess,
                connectionId,
                semaphore,
                results)).ToList();

            // Ожидаем завершения всех задач
            await Task.WhenAll(tasks);

            // Отправляем статус завершения
            await NotifySearchStatus(connectionId, $" Поиск завершен. Найдено {results.Count} страниц с информацией.", "completed", results.Count);

            _logger.LogInformation("Found {Count} results", results.Count);
            return results.ToList();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Search failed for query: {Query}", query);
            await NotifySearchStatus(connectionId, $" Ошибка поиска: {ex.Message}", "error");
            return results.ToList();
        }
    }

    public async Task ProcessUrlAsync(
        string resultUrl,
        int processed,
        int totalToProcess,
        string? connectionId,
        SemaphoreSlim semaphore,
        ConcurrentBag<SearchResult> results)
    {
        await semaphore.WaitAsync();
        try
        {
            // Отправляем статус обработки каждой ссылки
            await NotifySearchStatus(
                connectionId,
                $" Анализируем страницу {processed} из {totalToProcess}: {resultUrl[..Math.Min(50, resultUrl.Length)]}...",
                "processing_page",
                processed,
                totalToProcess);

            var content = await GetFullPageTextAsync(resultUrl);

            results.Add(new SearchResult
            {
                Url = resultUrl,
                Title = "",
                Content = content
            });

            _logger.LogDebug("Processed {Processed}/{Total}: {Url}", processed, totalToProcess, resultUrl);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to process URL: {Url}", resultUrl);

            // Добавляем результат с ошибкой
            results.Add(new SearchResult
            {
                Url = resultUrl,
                Title = "",
                Content = $"[Ошибка загрузки: {ex.Message}]"
            });
        }
        finally
        {
            semaphore.Release();
        }
    }

    public async Task NotifySearchStatus(string? connectionId, string message, string status, int? current = null, int? total = null)
    {
        if (string.IsNullOrEmpty(connectionId))
            return;

        try
        {
            await _hubContext.Clients.Client(connectionId).SendAsync("search_status", new
            {
                message = message,
                status = status,
                current = current,
                total = total,
                timestamp = DateTime.UtcNow
            });
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to send search status to client");
        }
    }


    public async Task<List<string>> ExtractUrlsStepByStepAsync(string url)
    {
        var browser = await GetBrowserAsync();
        var context = await browser.NewContextAsync();
        var page = await context.NewPageAsync();
        var urls = new List<string>();

        try
        {
            await page.GotoAsync(url);

            // Ждем загрузки
            await page.WaitForLoadStateAsync(LoadState.NetworkIdle);

            // Получаем количество результатов
            var resultCount = await page.Locator(".result").CountAsync();
            _logger.LogInformation("Found {Count} result elements", resultCount);

            if (resultCount == 0)
            {
                _logger.LogWarning("No result elements found");
                return urls;
            }

            // Проходим по каждому результату
            for (int i = 0; i < resultCount; i++)
            {
                try
                {
                    // Получаем ссылку из каждого результата
                    var href = await page.Locator(".result").Nth(i).Locator(".result__a").GetAttributeAsync("href");

                    if (!string.IsNullOrEmpty(href))
                    {
                        // Очищаем URL
                        string cleanUrl = href;
                        if (href.Contains("uddg="))
                        {
                            var match = System.Text.RegularExpressions.Regex.Match(href, @"uddg=(https?[^&]+)");
                            if (match.Success)
                            {
                                cleanUrl = System.Web.HttpUtility.UrlDecode(match.Groups[1].Value);
                            }
                        }

                        if (cleanUrl.StartsWith("http"))
                        {
                            urls.Add(cleanUrl);
                            _logger.LogDebug("Found URL: {Url}", cleanUrl);
                        }
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to extract URL for result {Index}", i);
                }
            }

            _logger.LogInformation("Successfully extracted {Count} URLs", urls.Count);
            return urls;
        }
        finally
        {
            await page.CloseAsync();
            await context.CloseAsync();
        }
    }

    public async Task<string> GetFullPageTextAsync(string url)
    {
        var browser = await GetBrowserAsync();
        var context = await browser.NewContextAsync();
        var page = await context.NewPageAsync();

        try
        {
            _logger.LogInformation("Getting full page text from: {Url}", url);

            await page.GotoAsync(url, new PageGotoOptions { Timeout = 30000 });

            // Эмулируем Ctrl+A (выделить всё) и Ctrl+C (копировать)
            // Вариант 1: Через JavaScript (самый надежный)
            var fullText = await page.EvaluateAsync<string>(@"(function() {
            // Удаляем скрипты, стили, навигацию, футеры
            const removeElements = (selector) => {
                document.querySelectorAll(selector).forEach(el => el.remove());
            };
            removeElements('script, style, nav, footer, header, aside, .ad, .cookie, .popup, .modal');
            
            // Получаем текст из body
            const body = document.body;
            let text = body.innerText || body.textContent || '';
            
            // Очищаем лишние пробелы и пустые строки
            text = text.replace(/\s+/g, ' ').trim();
            
            return text;
        })()");

            // Вариант 2: Эмуляция реальных нажатий клавиш Ctrl+A, Ctrl+C
            // (раскомментируйте, если нужен именно этот способ)
            /*
            // Нажимаем Ctrl+A
            await page.Keyboard.PressAsync("Control+A");

            // Небольшая задержка для выделения
            await Task.Delay(100);

            // Нажимаем Ctrl+C
            await page.Keyboard.PressAsync("Control+C");

            // Получаем текст из буфера обмена (требуется доступ к clipboard)
            var fullText = await page.EvaluateAsync<string>("navigator.clipboard.readText()");
            */

            // Очищаем и форматируем текст
            fullText = CleanExtractedText(fullText);

            // Обрезаем до разумного размера (3000 символов)
            //if (fullText.Length > 3000)
            //    fullText = fullText.Substring(0, 3000);

            _logger.LogDebug("Extracted {Length} characters from {Url}", fullText.Length, url);

            return $"[Источник: {url}]\n{fullText}";
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to get full page text from {Url}", url);
            return string.Empty;
        }
        finally
        {
            await page.CloseAsync();
            await context.CloseAsync();
        }
    }

    private string CleanExtractedText(string text)
    {
        // Удаляем лишние пробелы
        text = Regex.Replace(text, @"\s+", " ");

        // Удаляем строки с типичным мусором
        var lines = text.Split(new[] { '.', '!', '?' }, StringSplitOptions.RemoveEmptyEntries);
        var cleanedLines = new List<string>();

        foreach (var line in lines)
        {
            var trimmed = line.Trim();
            if (trimmed.Length < 20) continue; // Слишком короткие
            if (trimmed.Contains("cookie", StringComparison.OrdinalIgnoreCase)) continue;
            if (trimmed.Contains("реклам", StringComparison.OrdinalIgnoreCase)) continue;
            if (trimmed.Contains("copyright", StringComparison.OrdinalIgnoreCase)) continue;
            if (trimmed.Contains("подпишись", StringComparison.OrdinalIgnoreCase)) continue;
            if (trimmed.Contains("subscribe", StringComparison.OrdinalIgnoreCase)) continue;

            cleanedLines.Add(trimmed);
        }

        return string.Join(". ", cleanedLines);
    }

    public async Task<string> FetchPageContentAsync(string url)
    {
        var browser = await GetBrowserAsync();
        var context = await browser.NewContextAsync();
        var page = await context.NewPageAsync();

        try
        {
            _logger.LogDebug("Fetching content from: {Url}", url);

            await page.GotoAsync(url, new PageGotoOptions { Timeout = 30000 });

            // Удаляем скрипты и стили, извлекаем текст
            var text = await page.EvaluateAsync<string>(@"
                const removeElements = (selector) => {
                    document.querySelectorAll(selector).forEach(el => el.remove());
                };
                removeElements('script, style, nav, footer, header, aside, .ad, .cookie, .popup');
                
                // Получаем текст из body
                const body = document.body;
                return body.innerText || body.textContent || '';
            ");

            // Очищаем и обрезаем текст
            text = Regex.Replace(text, @"\s+", " ");
            text = text.Trim();

            if (text.Length > 2000)
                text = text.Substring(0, 2000);

            return $"[Источник: {url}]\n{text}";
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to fetch page content from {Url}", url);
            return string.Empty;
        }
        finally
        {
            await page.CloseAsync();
            await context.CloseAsync();
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_browser != null)
        {
            await _browser.CloseAsync();
            await _browser.DisposeAsync();
        }
        _playwright?.Dispose();
        _semaphore.Dispose();
    }
}

public class SearchResult
{
    public string Url { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string Content { get; set; } = string.Empty;
}