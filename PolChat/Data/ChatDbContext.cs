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
            e.HasKey(m => m.id);
            e.Property(m => m.id).HasMaxLength(100);
            e.Property(m => m.channel_id).HasMaxLength(100);
            e.Property(m => m.username).HasMaxLength(50);
            e.Property(m => m.content).HasColumnType("text");
            e.Property(m => m.file_url).HasMaxLength(1000);
            e.Property(m => m.reply_to_id).HasMaxLength(100);

            // JSONB column for reactions
            e.Property(m => m.reactions)
                .HasColumnType("jsonb")
                .HasDefaultValueSql("'[]'::jsonb");

            // PostgreSQL array columns
            e.Property(m => m.read_by)
                .HasColumnType("text[]")
                .HasDefaultValueSql("'{}'::text[]");
            e.Property(m => m.delivered_to)
                .HasColumnType("text[]")
                .HasDefaultValueSql("'{}'::text[]");

            e.HasIndex(m => m.channel_id);
            e.HasIndex(m => m.timestamp);
            e.HasIndex(m => m.username);
            e.HasIndex(m => m.reply_to_id);
            e.HasIndex(m => new { m.channel_id, m.timestamp }).IsDescending(false, true);

            // Explicit FK: Message.User -> User.Username (using existing Username property)
            e.HasOne(m => m.User)
             .WithMany()
             .HasForeignKey(m => m.username)
             .OnDelete(DeleteBehavior.SetNull);

            // Self-referencing FK for replies
            e.HasOne(m => m.ReplyTo)
             .WithMany()
             .HasForeignKey(m => m.reply_to_id)
             .OnDelete(DeleteBehavior.SetNull);

            
            e.Property(x => x.reactions)
            .HasConversion(
                v => JsonSerializer.Serialize(v, JsonSerializerOptions.Default),
                v => JsonSerializer.Deserialize<List<Reaction>>(v, JsonSerializerOptions.Default)!
            );


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
