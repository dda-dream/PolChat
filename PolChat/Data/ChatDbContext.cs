using Microsoft.EntityFrameworkCore;
using ChatApp.Models;

namespace ChatApp.Data;

public class ChatDbContext : DbContext
{
    public ChatDbContext(DbContextOptions<ChatDbContext> options) : base(options) { }

    public DbSet<User> users => Set<User>();
    public DbSet<Channel> Channels => Set<Channel>();
    public DbSet<Message> Messages => Set<Message>();
    public DbSet<DMChannel> DMChannels => Set<DMChannel>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        // Users
        modelBuilder.Entity<User>(e =>
        {
            e.HasKey(u => u.username);
            e.Property(u => u.username).HasMaxLength(50);
            e.Property(u => u.password).HasMaxLength(256);
            e.Property(u => u.role).HasMaxLength(20).HasDefaultValue("user");
            e.Property(u => u.avatar).HasMaxLength(500).HasDefaultValue("default.png");
            e.Property(u => u.status).HasMaxLength(20).HasDefaultValue("offline");
            e.HasIndex(u => u.username).IsUnique();
        });

        // Channels
        modelBuilder.Entity<Channel>(e =>
        {
            e.HasKey(c => c.id);
            e.Property(c => c.id).HasMaxLength(100);
            e.Property(c => c.name).HasMaxLength(200);
            e.Property(c => c.description).HasMaxLength(500);
            e.Property(c => c.created_by).HasMaxLength(50);
            e.HasIndex(c => c.name);
            e.HasIndex(c => c.created_at);
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
        });

        // DM Channels
        modelBuilder.Entity<DMChannel>(e =>
        {
            e.HasKey(d => d.id);
            e.Property(d => d.id).HasMaxLength(100);
            e.Property(d => d.created_by).HasMaxLength(50);

            // PostgreSQL array column for participants
            e.Property(d => d.participants)
                .HasColumnType("text[]");
        });
    }
}
