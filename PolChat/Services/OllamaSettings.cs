namespace ChatApp.Services;

public class OllamaSettings
{
    public string Url { get; set; } = "http://localhost:55551";
    public string Model { get; set; } = "gpt-oss:120b-cloud";
    public int TimeoutSeconds { get; set; } = 120;
    public double Temperature { get; set; } = 0.7;
    public int MaxTokens { get; set; } = 500;
}