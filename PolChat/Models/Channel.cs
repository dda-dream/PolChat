namespace ChatApp.Models;

public class Channel
{
    public string Id { get; set; } = null!;
    public string Name { get; set; } = null!;
    public string? Description { get; set; }
    public string? CreatedBy { get; set; }
    public DateTime CreatedAt { get; set; }
    public bool IsPrivate { get; set; }
}

public class ChannelDto
{
    public string Id { get; set; } = null!;
    public string Name { get; set; } = null!;
    public string? Description { get; set; }
    public string? CreatedBy { get; set; }
    public string? CreatedByDisplay { get; set; }
    public bool CreatedByDeleted { get; set; }
    public DateTime CreatedAt { get; set; }
    public bool IsPrivate { get; set; }
}
