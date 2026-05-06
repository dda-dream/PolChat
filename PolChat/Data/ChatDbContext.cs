using Microsoft.EntityFrameworkCore;
using ChatApp.Models;
using System.Text.Json;

namespace ChatApp.Data;

public class ChatDbContext : DbContext
{
    public ChatDbContext(DbContextOptions<ChatDbContext> options) : base(options) { }

    public DbSet<User> users => Set<User>();
    public DbSet<Channel> channels => Set<Channel>();
    public DbSet<Message> messages => Set<Message>();
    public DbSet<DMChannel> dm_channels => Set<DMChannel>();


    public DbSet<Reaction> Reactions=> Set<Reaction>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Users
        modelBuilder.Entity<User>(e =>
        {
            e.HasKey(u => u.Username);
            e.Property(u => u.Username).HasMaxLength(50);
            e.Property(u => u.Password).HasMaxLength(256);
            e.Property(u => u.Role).HasMaxLength(20).HasDefaultValue("user");
            e.Property(u => u.Avatar).HasMaxLength(500).HasDefaultValue("default.png");
            e.Property(u => u.Status).HasMaxLength(20).HasDefaultValue("offline");
            e.HasIndex(u => u.Username).IsUnique();
        });

        // Channels
        modelBuilder.Entity<Channel>(e =>
        {
            e.HasKey(c => c.Id);
            e.Property(c => c.Id).HasMaxLength(100);
            e.Property(c => c.Name).HasMaxLength(200);
            e.Property(c => c.Description).HasMaxLength(500);
            e.Property(c => c.CreatedBy).HasMaxLength(50);
            e.HasIndex(c => c.Name);
            e.HasIndex(c => c.CreatedAt);
        });

        // Messages
        modelBuilder.Entity<Message>(e =>
        {
            e.HasKey(m => m.Id);
            e.Property(m => m.Id).HasMaxLength(100);
            e.Property(m => m.ChannelId).HasMaxLength(100);
            e.Property(m => m.Username).HasMaxLength(50);
            e.Property(m => m.Content).HasColumnType("text");
            e.Property(m => m.FileUrl).HasMaxLength(1000);
            e.Property(m => m.ReplyToId).HasMaxLength(100);

            // JSONB column for reactions
            e.Property(m => m.Reactions)
                .HasColumnType("jsonb")
                .HasDefaultValueSql("'[]'::jsonb");

            // PostgreSQL array columns
            e.Property(m => m.ReadBy)
                .HasColumnType("text[]")
                .HasDefaultValueSql("'{}'::text[]");
            e.Property(m => m.DeliveredTo)
                .HasColumnType("text[]")
                .HasDefaultValueSql("'{}'::text[]");

            e.HasIndex(m => m.ChannelId);
            e.HasIndex(m => m.Timestamp);
            e.HasIndex(m => m.Username);
            e.HasIndex(m => m.ReplyToId);
            e.HasIndex(m => new { m.ChannelId, m.Timestamp }).IsDescending(false, true);

            // Explicit FK: Message.User -> User.Username (using existing Username property)
            e.HasOne(m => m.User)
             .WithMany()
             .HasForeignKey(m => m.Username)
             .OnDelete(DeleteBehavior.SetNull);

            // Self-referencing FK for replies
            e.HasOne(m => m.ReplyTo)
             .WithMany()
             .HasForeignKey(m => m.ReplyToId)
             .OnDelete(DeleteBehavior.SetNull);

            
            e.Property(x => x.Reactions)
            .HasConversion(
                v => JsonSerializer.Serialize(v, JsonSerializerOptions.Default),
                v => JsonSerializer.Deserialize<List<ReactionInMessage>>(v, JsonSerializerOptions.Default)!
            );


        });

        // DM Channels
        modelBuilder.Entity<DMChannel>(e =>
        {
            e.HasKey(d => d.Id);
            e.Property(d => d.Id).HasMaxLength(100);
            e.Property(d => d.CreatedBy).HasMaxLength(50);

            // PostgreSQL array column for participants
            e.Property(d => d.Participants)
                .HasColumnType("text[]");
        });

        


    }
}
