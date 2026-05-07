using System.ComponentModel.DataAnnotations.Schema;
using System.Text.Json.Serialization;

namespace ChatApp.Models;

public class Reaction
{
    public string MessageId { get; set; } = null!;
    public string UserId { get; set; } = null!;
    public string Emoji { get; set; } = null!;
    public DateTime CreatedAt { get; set; }


    public Message? Message { get; set; }
    public User? User { get; set; }

}

