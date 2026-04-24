namespace ChatApp.Models;

public class SessionData
{
    public string UserId { get; set; } = null!;
    public string Username { get; set; } = null!;
    public string Role { get; set; } = "user";
}

public class InitialDataResponse
{
    public List<ChannelDto> Channels { get; set; } = new();
    public List<DMChannelDto> DMChannels { get; set; } = new();
    public List<UserDto> Users { get; set; } = new();
    public Dictionary<string, int> UnreadCounts { get; set; } = new();
}

public class LoginRequest
{
    public string Username { get; set; } = null!;
    public string Password { get; set; } = null!;
}

public class RegisterRequest
{
    public string Username { get; set; } = null!;
    public string Password { get; set; } = null!;
}

public class CreateChannelRequest
{
    public string Name { get; set; } = null!;
    public string? Description { get; set; }
    public bool IsPrivate { get; set; }
}

public class RenameChannelRequest
{
    public string Name { get; set; } = null!;
}

public class UpdateDescriptionRequest
{
    public string? Description { get; set; }
}

public class EditMessageRequest
{
    public string Content { get; set; } = null!;
}

public class CreateDMChannelRequest
{
    public string OtherUser { get; set; } = null!;
}

public class SetStatusRequest
{
    public string Status { get; set; } = null!; // "online", "away", "offline"
}

public class SendMessageRequest
{
    public string? TempId { get; set; }
    public string ChannelId { get; set; } = null!;
    public string? Content { get; set; }
    public string? FileUrl { get; set; }
    public ReplyToInfo? ReplyTo { get; set; }
}

public class AddReactionRequest
{
    public string MessageId { get; set; } = null!;
    public string Emoji { get; set; } = null!;
}
