namespace ChatApp.Models;

public class User
{
    public string Username { get; set; } = null!;
    public string Password { get; set; } = null!;
    public string Role { get; set; } = "user"; // "user" or "admin"
    public DateTime CreatedAt { get; set; }
    public string Avatar { get; set; } = "default.png";
    public string Status { get; set; } = "offline"; // "online", "away", "offline"
    public DateTime? LastSeen { get; set; }
    public bool IsBot { get; set; } = false;
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
