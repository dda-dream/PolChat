using System.Text.RegularExpressions;

namespace ChatApp.Data;

public static class HtmlSanitizer
{
    public static string Sanitize(string? content)
    {
        if (string.IsNullOrEmpty(content)) return content ?? "";

        // Remove all HTML tags
        content = Regex.Replace(content, @"<[^>]*>", "");

        // Remove dangerous patterns
        var patterns = new[]
        {
            @"javascript:", @"data:text/html", @"vbscript:",
            @"onclick\s*=", @"onload\s*=", @"onerror\s*=",
            @"<script", @"</script", @"<iframe"
        };

        foreach (var pattern in patterns)
        {
            content = Regex.Replace(content, pattern, "", RegexOptions.IgnoreCase);
        }

        return content;
    }

    public static string EscapeHtml(string? text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        return System.WebUtility.HtmlEncode(text);
    }
}
