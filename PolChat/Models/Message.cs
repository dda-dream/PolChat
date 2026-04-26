using System.ComponentModel.DataAnnotations.Schema;
using System.Text.Json.Serialization;

namespace ChatApp.Models;

public class Message
{
    public string id { get; set; } = null!;

    [ForeignKey(nameof(Channel))]
    [Column("channel_id")]
    public string channel_id { get; set; } = null!;
    public string username { get; set; } = null!;
    public string? content { get; set; }
    public string? file_url { get; set; }
    public DateTime timestamp { get; set; }
    public bool edited { get; set; }
    public DateTime? edited_at { get; set; }
    public string? reply_to_id { get; set; }

    // PostgreSQL arrays
    public List<Reaction> reactions { get; set; } = new();


    public string[] read_by { get; set; } = Array.Empty<string>();


    public List<string> delivered_to { get; set; } = new();

    // Navigation
    [JsonIgnore]
    public Channel? Channel { get; set; }
    [JsonIgnore]
    public Message? ReplyTo { get; set; }
    [JsonIgnore]
    public User? User { get; set; }
}

public class Reaction
{
    public string Emoji { get; set; } = null!;
    public List<string> Users { get; set; } = new();
}

public class MessageDto
{
    public string Id { get; set; } = null!;
    public string ChannelId { get; set; } = null!;
    public string Username { get; set; } = null!;
    public string? Content { get; set; }
    public string? FileUrl { get; set; }
    public string Timestamp { get; set; } = null!;
    public bool Edited { get; set; }
    public DateTime? EditedAt { get; set; }
    public List<Reaction> Reactions { get; set; } = new List<Reaction>();
    public string[] ReadBy { get; set; } = Array.Empty<string>();
    public List<string> DeliveredTo { get; set; } = new();
    public ReplyToInfo? ReplyTo { get; set; }
    public bool IsDeletedSender { get; set; }
    public bool IsTemp { get; set; }
}

public class ReplyToInfo
{
    public string Id { get; set; } = null!;
    public string Username { get; set; } = null!;
    public string? Content { get; set; }
    public string? FileUrl { get; set; }
    public bool IsDeleted { get; set; }
}

public class PaginationInfo
{
    public int Page { get; set; }
    public int Limit { get; set; }
    public int Total { get; set; }
    public bool HasMore { get; set; }
}

public class MessagesResponse
{
    public List<MessageDto> Messages { get; set; } = new();
    public PaginationInfo Pagination { get; set; } = new();
}
