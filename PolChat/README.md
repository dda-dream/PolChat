# ChatApp — ASP.NET Core

Чат-приложение на ASP.NET Core 9, переписанное с Python (aiohttp + Socket.IO).

## Технологии

| Компонент | Python (оригинал) | C# (переписано) |
|---|---|---|
| Веб-фреймворк | aiohttp | ASP.NET Core 9 |
| WebSocket | Socket.IO | SignalR |
| БД | asyncpg (raw SQL) | EF Core + Npgsql |
| Кэш/Сессии | redis.asyncio | StackExchange.Redis |
| Шаблоны | Jinja2 | Контроллеры (API) |
| Автозагрузка | run_https.py | dotnet watch |
| HTTPS | pyOpenSSL | Kestrel (appsettings) |

## Структура проекта

```
ChatApp/
├── ChatApp.csproj
├── Program.cs
├── appsettings.json
├── init_db.sql
├── Controllers/
│   ├── AuthController.cs          # Аутентификация (login/register/logout)
│   ├── ChannelsController.cs      # CRUD каналов
│   ├── MessagesController.cs      # Сообщения, начальные данные, прочитанные
│   ├── DMChannelsController.cs    # Личные сообщения (DM)
│   ├── UsersController.cs         # Пользователи, статус, heartbeat
│   └── UploadController.cs        # Загрузка файлов
├── Hubs/
│   └── ChatHub.cs                 # SignalR Hub (все WebSocket-события)
├── Models/
│   ├── User.cs                    # User, UserDto, UserDisplayInfo
│   ├── Channel.cs                 # Channel, ChannelDto
│   ├── Message.cs                 # Message, Reaction, MessageDto, ReplyToInfo
│   ├── DMChannel.cs              # DMChannel, DMChannelDto
│   ├── SessionData.cs            # SessionData, DTO запросов/ответов
│   └── UploadResponse.cs         # UploadResponse, ApiError
├── Data/
│   ├── ChatDbContext.cs           # EF Core DbContext
│   ├── DbInitializer.cs           # Инициализация БД (admin + general)
│   ├── Constants.cs               # Константы приложения
│   └── HtmlSanitizer.cs          # XSS-защита
├── Services/
│   ├── SessionService.cs          # Redis-сессии
│   └── InactiveUsersBackgroundService.cs  # Проверка неактивных
├── Properties/
│   └── launchSettings.json
└── wwwroot/
```

## Запуск

### 1. PostgreSQL

```bash
# Создайте базу данных
createdb chat

# Примените SQL-скрипт для создания таблиц
psql -d chat -f init_db.sql
```

### 2. Redis

```bash
redis-server
```

### 3. Запуск приложения

```bash
cd ChatApp
dotnet restore
dotnet run

# Или с автоперезагрузкой:
dotnet watch run
```

Сервер запустится на `http://localhost:5555`.

## API-эндпоинты

### Аутентификация
- `POST /api/auth/login` — Вход
- `POST /api/auth/register` — Регистрация
- `GET /logout` — Выход

### Каналы
- `GET /api/channels` — Список каналов
- `POST /api/channels` — Создать канал
- `DELETE /api/channels/{id}` — Удалить канал
- `PUT /api/channels/{id}/rename` — Переименовать
- `PUT /api/channels/{id}/description` — Обновить описание

### Сообщения
- `GET /api/initial_data` — Начальные данные
- `GET /api/messages/{channelId}` — Сообщения (пагинация)
- `PUT /api/messages/{messageId}` — Редактировать
- `DELETE /api/messages/{messageId}` — Удалить
- `POST /api/unread/{channelId}/read` — Пометить канал прочитанным
- `POST /api/messages/{messageId}/read` — Пометить сообщение прочитанным
- `GET /api/unread` — Счётчики непрочитанных

### Личные сообщения (DM)
- `GET /api/dm_channels` — Список DM-каналов
- `POST /api/dm_channels` — Создать DM
- `DELETE /api/dm_channels/{id}` — Удалить DM

### Пользователи
- `GET /api/users` — Список пользователей
- `POST /api/user/status` — Изменить статус
- `POST /api/user/heartbeat` — Heartbeat

### Файлы
- `POST /upload` — Загрузить файл
- `GET /uploads/{filename}` — Скачать файл

### SignalR Hub (`/chathub`)

| Метод | Описание |
|---|---|
| `SendMessage(data)` | Отправить сообщение |
| `JoinChannel(channelId)` | Присоединиться к каналу |
| `LeaveChannel(channelId)` | Покинуть канал |
| `AddReaction(messageId, emoji)` | Добавить реакцию |
| `Typing(channelId)` | Индикатор набора текста |
| `MarkChannelRead(channelId)` | Пометить прочитанным |

События (клиент получает):
- `new_message`, `message_sent`, `message_edited`, `message_deleted`
- `user_status`, `typing`, `message_reaction_updated`
- `channel_created`, `channel_deleted`, `channel_renamed`
- `unread_counts_updated`, `messages_delivered`, `unread_update_dm`

### Swagger
- `https://localhost:5555/swagger` — Документация API

## Настройка (appsettings.json)

```json
{
  "ConnectionStrings": {
    "DefaultConnection": "Host=localhost;Port=5432;Database=chat;Username=postgres;Password=1",
    "Redis": "localhost:6379"
  },
  "Server": {
    "Port": 5555,
    "UseHttps": false
  },
  "Registration": {
    "Disabled": true
  }
}
```

## Миграция с Python

Всё функциональное покрытие:

- ✅ Аутентификация (Redis-сессии через cookie)
- ✅ Каналы (CRUD + права доступа)
- ✅ Сообщения (пагинация, редактирование, удаление, ответы, реакции)
- ✅ Личные сообщения (DM)
- ✅ Статусы пользователей (online/away/offline)
- ✅ Счётчики непрочитанных сообщений
- ✅ Индикаторы доставки/прочтения (DM)
- ✅ Загрузка файлов
- ✅ XSS-защита (санитизация HTML)
- ✅ Фоновая проверка неактивности
- ✅ Swagger документация
