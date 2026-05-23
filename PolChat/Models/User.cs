using System.ComponentModel.DataAnnotations;

namespace ChatApp.Models;

public class User
{
    [Key]
    [MaxLength(50)]
    public string Username { get; set; } = null!;  // Первичный ключ

    public string Password { get; set; } = null!;
    public string Role { get; set; } = "user";
    public DateTime CreatedAt { get; set; }
    public string? Avatar { get; set; }
    public string Status { get; set; } = "offline";
    public DateTime? LastSeen { get; set; }
    public bool IsBot { get; set; } = false;
    public bool? NotificationsEnabled { get; set; } = true;
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
