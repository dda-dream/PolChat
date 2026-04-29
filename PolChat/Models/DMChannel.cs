namespace ChatApp.Models;

public class DMChannel
{
    public string Id { get; set; } = null!;
    public List<string> Participants { get; set; } = new();
    public string? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; }
}

public class DMChannelDto
{
    public string Id { get; set; } = null!;
    public string Name { get; set; } = null!;
    public string? OriginalName { get; set; }
    public List<string> Participants { get; set; } = new();
    public string? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; }
    public bool IsDeleted { get; set; }
}
