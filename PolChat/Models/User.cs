namespace ChatApp.Models;

public class User
{
    public string username { get; set; } = null!;
    public string password { get; set; } = null!;
    public string role { get; set; } = "user"; // "user" or "admin"
    public DateTime created_at { get; set; }
    public string avatar { get; set; } = "default.png";
    public string status { get; set; } = "offline"; // "online", "away", "offline"
    public DateTime? last_seen { get; set; }
}

public class UserDto
{
    public string Username { get; set; } = null!;
    public string Role { get; set; } = "user";
    public string Status { get; set; } = "offline";
    public DateTime? LastSeen { get; set; }
    public DateTime? CreatedAt { get; set; }
    public string? Avatar { get; set; }
    public bool IsDeleted { get; set; }
}

public class UserDisplayInfo
{
    public string? Username { get; set; }
    public string DisplayName { get; set; } = "Удаленный аккаунт";
    public string AvatarLetter { get; set; } = "?";
    public string Status { get; set; } = "deleted";
    public string Role { get; set; } = "deleted";
    public bool IsDeleted { get; set; } = true;
}
