namespace ChatApp.Services;

public class OllamaSettings
{
    public string Url { get; set; } = "https://ollama.com";
    public string Model { get; set; } = "gpt-oss:120b-cloud";
    public int TimeoutSeconds { get; set; } = 120;
    public double Temperature { get; set; } = 0.7;
    public int MaxTokens { get; set; } = 500;
    public string ApiKey { get; set; } = string.Empty;
    public string BraveApiKey { get; set; } = string.Empty;
    public string ReasoningEffort { get; set; } = "high";
}