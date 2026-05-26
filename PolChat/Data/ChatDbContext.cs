using Microsoft.EntityFrameworkCore;
using ChatApp.Models;
using System.Text.Json;

namespace ChatApp.Data;

public class ChatDbContext : DbContext
{
    public ChatDbContext(DbContextOptions<ChatDbContext> options) : base(options)
    {
    }

    public DbSet<User> Users => Set<User>();
    public DbSet<Channel> Channels => Set<Channel>();
    public DbSet<Message> Messages => Set<Message>();
    public DbSet<MessageLog> MessagesLog => Set<MessageLog>();



    public DbSet<DMChannel> DmChannels => Set<DMChannel>();
    public DbSet<Reaction> Reactions => Set<Reaction>();



    public override async Task<int> SaveChangesAsync(CancellationToken cancellationToken = default)
    {
        // 1. Находим все измененные, добавленные или удаленные записи типа Message
        var entries = ChangeTracker.Entries<Message>()
            .Where(e => e.State == EntityState.Added ||
                        e.State == EntityState.Modified ||
                        e.State == EntityState.Deleted)
            .ToList();

        var logsToCreate = new List<MessageLog>();

        foreach (var entry in entries)
        {
            // 2. Определяем тип операции
            string logType = entry.State switch
            {
                EntityState.Added => "INSERT",
                EntityState.Modified => "UPDATE",
                EntityState.Deleted => "DELETE",
                _ => "UNKNOWN"
            };

            // 3. Берем объект (для удаленных сущностей берем старые значения)
            var message = entry.Entity;

            // 4. Создаем запись для лога
            var log = new MessageLog
            {
                // Если Id в логе генерируется базой (Identity), это поле можно опустить
                // или записать оригинальный Id в отдельную колонку, например, OriginalMessageId
                Id = message.Id,
                ChannelId = message.ChannelId,
                Username = message.Username,
                Content = message.Content,
                FileUrl = message.FileUrl,
                ReplyToId = message.ReplyToId,
                Reactions = message.Reactions.ToString(),
                ReadBy = message.ReadBy,    
                DeliveredTo = message.DeliveredTo,
                Timestamp = DateTime.UtcNow, // Время создания лога
                LogType = logType,

            };

            /*
    id text COLLATE pg_catalog."default" NOT NULL,
    channel_id text COLLATE pg_catalog."default" NOT NULL,
    username text COLLATE pg_catalog."default",
    content text COLLATE pg_catalog."default",
    file_url text COLLATE pg_catalog."default",
    reply_to_id text COLLATE pg_catalog."default",
    "timestamp" timestamp without time zone NOT NULL,
    edited boolean DEFAULT false,
    edited_at timestamp without time zone,
    reactions jsonb DEFAULT '[]'::jsonb,
    read_by text[] COLLATE pg_catalog."default" DEFAULT '{}'::text[],
    delivered_to text[] COLLATE pg_catalog."default" DEFAULT '{}'::text[],
    log_type text COLLATE pg_catalog."default"
             */


            logsToCreate.Add(log);
        }

        // 5. Добавляем логи в контекст перед сохранением
        if (logsToCreate.Any())
        {
            //await MessagesLog.AddRangeAsync(logsToCreate, cancellationToken);

            foreach (var log in logsToCreate)
            {
                Entry(log).State = EntityState.Added;
            }
        }




        // 6. Сохраняем всё одной транзакцией
        return await base.SaveChangesAsync(cancellationToken);
    }



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

        modelBuilder.Entity<Reaction>(o =>
            {
                o.HasKey(r => new { r.UserId, r.MessageId, r.Emoji });
            }
        );



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
