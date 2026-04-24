namespace ChatApp.Models;

public class Channel
{
    public string id { get; set; } = null!;
    public string name { get; set; } = null!;
    public string? description { get; set; }
    public string? created_by { get; set; }
    public DateTime created_at { get; set; }
    public bool is_private { get; set; }
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
