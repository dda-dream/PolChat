// WebSearchService.cs
using Microsoft.Playwright;
using System.Text.RegularExpressions;

namespace ChatApp.Services;

public class WebSearchService : IAsyncDisposable
{
    private readonly ILogger<WebSearchService> _logger;
    private IPlaywright? _playwright;
    private IBrowser? _browser;
    private readonly SemaphoreSlim _semaphore = new(1, 1);

    public WebSearchService(ILogger<WebSearchService> logger)
    {
        _logger = logger;
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
                        Headless = true,
                        Args = new[]
                        {
                            "--disable-blink-features=AutomationControlled",
                            "--no-sandbox",
                            "--disable-dev-shm-usage"
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

    public async Task<List<SearchResult>> SearchAsync(string query, int maxResults = 5)
    {
        var results = new List<SearchResult>();

        try
        {
            _logger.LogInformation("Searching DuckDuckGo for: {Query}", query);

            string url = $"https://html.duckduckgo.com/html/?q={Uri.EscapeDataString(query)}";
            var searchResults = await GetFullPageTextAsync(url);

            results.Add(new SearchResult
            {
                Url = url,
                Title = "",
                Snippet = searchResults
            });

            _logger.LogInformation("Found {Count} results", results.Count);
            return results;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Search failed for query: {Query}", query);
            return results;
        }
        finally
        {
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
            
            // Разбиваем на предложения и группируем
            const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
            
            // Возвращаем первые 50 предложений (примерно 3000-5000 символов)
            return sentences.slice(0, 50).join(' ');
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
            if (fullText.Length > 3000)
                fullText = fullText.Substring(0, 3000);

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
    public string Snippet { get; set; } = string.Empty;
}