
//<reference path="./global.d.ts" />
"use strict";


const isChatPage = document.querySelector('.chat-container') !== null;
const isSettingsPage = document.querySelector('.settings-container') !== null;
const isLoginPage = document.getElementById('loginForm') !== null;
const isRegisterPage = document.getElementById('registerForm') !== null;
const isUserManagementPage = document.getElementById('users-list') !== null && (window.location.pathname.includes('user_management') || window.location.pathname.includes('/user_management'));



// ============ ОБЩИЕ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ (для всех страниц) ============

function escapeHtml(t: string | null | undefined): string {
    if (!t) return '';
    const d = document.createElement('div');
    d.textContent = t;
    return d.innerHTML;
}

function sanitizeHtml(t: string | null | undefined): string {
    if (!t) return '';
    return escapeHtml(t).replace(/javascript:/gi, 'blocked:').replace(/data:text\/html/gi, 'blocked:').replace(/vbscript:/gi, 'blocked:');
}

function sanitizeInput(t: string | null | undefined): string {
    return t ? t.replace(/<[^>]*>/g, '') : '';
}

function showGlobalNotification(message: string, type: 'info' | 'success' | 'danger' = 'info') {
    // Универсальная функция уведомлений для всех страниц
    const toast = document.createElement('div');
    const bgColor = type === 'danger' ? 'danger' : type === 'success' ? 'success' : 'dark';
    toast.className = `notification-toast bg-${bgColor}`;
    toast.innerHTML = `
        <i class="fas ${type === 'danger' ? 'fa-exclamation-triangle' : type === 'success' ? 'fa-check-circle' : 'fa-info-circle'} me-2"></i>
        ${escapeHtml(message)}
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ============ КОД ТОЛЬКО ДЛЯ СТРАНИЦЫ ЧАТА ============
if (isChatPage) {
    // ============ СОЗДАНИЕ SIGNALR CONNECTION ============
    // SignalR connection to ASP.NET Core backend

    const connection = new signalR.HubConnectionBuilder()
        .withUrl("/chathub", {
            withCredentials: true,
            transport: signalR.HttpTransportType.WebSockets | signalR.HttpTransportType.LongPolling
        })
        .withAutomaticReconnect({
            nextRetryDelayInMilliseconds: (retryContext: { previousRetryCount: number }) => {
                // Первые 4 попытки с разными интервалами
                if (retryContext.previousRetryCount === 0) return 0;
                if (retryContext.previousRetryCount === 1) return 2000;
                if (retryContext.previousRetryCount === 2) return 5000;
                if (retryContext.previousRetryCount === 3) return 10000;

                console.error("withAutomaticReconnect - reconecting.")
                return 30000;
            }
        })
        .configureLogging(signalR.LogLevel.Information)
        .build();

    // Start connection
    connection.start()
        .then(() => {
            console.log('SignalR Connected');
            updateConnectionStatus(true);
            updateUserStatusOnServer(STATUS.ONLINE);
            loadUsersWithStatus();
            forceRefreshUnreadCounts();
        })
        .catch(err => {
            console.error('SignalR connection error:', err);
            updateConnectionStatus(false);
        })
        .finally(() => {
            // ВАЖНО: запускаем обновление времени даже если соединение не установлено
            startServerTimeUpdater();
        });

    function toggleSidebar() {
        // Проверка на неотправленный файл
        if (pendingFileBlob) {
            const confirmSwitch = confirm('У вас есть неотправленный файл. Отменить его и закрыть боковую панель?');
            if (confirmSwitch) {
                cancelFilePreview();
            } else {
                return; // Не закрываем боковую панель, если файл не отменён
            }
        }
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        if (sidebar) sidebar.classList.toggle('open');
        if (overlay) overlay.classList.toggle('active');
    }

    function closeSidebar() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('active');
    }

    function showNotification(message: string, type: string) {
        const nd = document.createElement('div');
        nd.className = `alert alert-${type} notification alert-dismissible fade show`;
        nd.innerHTML = `${escapeHtml(message)}<button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
        const notificationArea = document.getElementById('notification-area');
        if (notificationArea) {
            notificationArea.appendChild(nd);
        } else {
            // Если нет notification-area, используем глобальное уведомление
            showGlobalNotification(message, type as any);
        }
        setTimeout(() => nd.remove(), 3000);
    }

    function showFullNotification(title: string, message: string) {
        if (!notificationsEnabled) return;
        const nd = document.createElement('div');
        nd.className = 'alert alert-info notification alert-dismissible fade show';
        // Используем title и message
        nd.innerHTML = `<strong>${escapeHtml(title)}</strong><br>${escapeHtml(message)} <button type="button" class="btn-close" data-bs-dismiss="alert"></button>`;
        const notificationArea = document.getElementById('notification-area');
        if (notificationArea) {
            notificationArea.appendChild(nd);
        } else {
            // Если нет notification-area, используем глобальное уведомление (можно доработать showGlobalNotification для поддержки заголовка, если нужно)
            showGlobalNotification(`${title}: ${message}`, 'info');
        }
        setTimeout(() => nd.remove(), 3000);
    }

    // ============ ОБЪЯВЛЕНИЕ ПЕРЕМЕННЫХ ============
    let currentChannel: string | null = null;
    let currentChannelType: 'dm' | 'channel' | null = null;
    let currentChannelName = '';
    let currentUsername = '';
    let editingMessageData: { id: string; channelId: string; channelType: 'dm' | 'channel' | null; content: string } | null = null;
    let editingIndicator: HTMLElement | null = null;
    let typingTimeout: number | null = null;
    let isTyping = false;
    let receivedMessages = new Set<string>();
    let isSending = false;
    let isLoadingMessages = false;
    let isUploading = false;

    let unreadCounts: UnreadCounts = {};
    let notificationsEnabled = true;
    let audio: HTMLAudioElement | null = null;
    let channelNamesCache = new Map<string, string>();
    let activeReactionPanel: HTMLElement | null = null;
    let currentlyActiveMessageActions: HTMLElement | null = null;

    let replyToMessageData: { id: string; username: string; content: string } | null = null;

    const MESSAGE_STATUS = { SENDING: 'sending', SENT: 'sent', DELIVERED: 'delivered', READ: 'read' } as const;
    type MessageStatusType = typeof MESSAGE_STATUS[keyof typeof MESSAGE_STATUS];
    let messageStatuses = new Map<string, MessageStatusType>();

    let usersCache: User[] = [];
    let usersCacheTime: number | null = null;
    const USERS_CACHE_TTL = 30000;

    let currentPage = 1;
    let hasMoreMessages = true;
    let isLoadingMore = false;
    let messagesPerPage = 50;

    let channelsCache: Channel[] | null = null;
    let channelsCacheTime: number | null = null;
    const CHANNELS_CACHE_TTL = 30000;

    let pendingScrollToBottom = false;
    let isFirstLoad = true;
    let scrollLockTimeout: number | null = null;

    let messageReadBy = new Map<string, string[]>();

    let pendingMessages = new Map<string, Partial<Message>>();


    let lastMessageTimestamp: string | null = null;

    const DELETED_USER_DISPLAY = "Удаленный аккаунт";
    const DELETED_USER_AVATAR = "?";

    let currentJoinToken = 0;

    // ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ЧАТА ============

    // ============ КНОПКИ ПРОКРУТКИ ЧАТА ============
    let scrollButtons: { top: HTMLElement | null; bottom: HTMLElement | null } = {
        top: null,
        bottom: null
    };

    function initScrollButtons() {
        scrollButtons.top = document.getElementById('scrollToTopBtn');
        scrollButtons.bottom = document.getElementById('scrollToBottomBtn');

        if (!scrollButtons.top || !scrollButtons.bottom) return;

        // Обработчики кнопок
        scrollButtons.top.addEventListener('click', () => {
            scrollToTop();
        });

        scrollButtons.bottom.addEventListener('click', () => {
            scrollToBottom();
        });

        // Скрываем кнопки при скролле
        const messagesDiv = document.getElementById('messages-area');
        if (messagesDiv) {
            messagesDiv.addEventListener('scroll', () => {
                updateScrollButtonsVisibility();
            });
        }

        // Изначально скрываем кнопки
        updateScrollButtonsVisibility();
    }

    function scrollToTop() {
        const messagesDiv = document.getElementById('messages-area');
        if (messagesDiv) {
            messagesDiv.scrollTo({
                top: 0,
                behavior: 'smooth'
            });
        }
    }

    function scrollToBottom() {
        const messagesDiv = document.getElementById('messages-area');
        if (messagesDiv) {
            messagesDiv.scrollTo({
                top: messagesDiv.scrollHeight,
                behavior: 'smooth'
            });
        }
    }

    function updateScrollButtonsVisibility() {
        const messagesDiv = document.getElementById('messages-area');
        if (!messagesDiv || !scrollButtons.top || !scrollButtons.bottom) return;

        const scrollTop = messagesDiv.scrollTop;
        const maxScroll = messagesDiv.scrollHeight - messagesDiv.clientHeight;

        // Определяем положение скролла с погрешностью в 10px
        const isAtTop = scrollTop <= 10;
        const isAtBottom = Math.abs(maxScroll - scrollTop) <= 10;

        // Показываем кнопку "вверх" только если не в начале
        if (!isAtTop && scrollTop > 100) {
            scrollButtons.top.classList.add('show');
        } else {
            scrollButtons.top.classList.remove('show');
        }

        // Показываем кнопку "вниз" только если не в конце
        if (!isAtBottom && maxScroll > 0) {
            scrollButtons.bottom.classList.add('show');
        } else {
            scrollButtons.bottom.classList.remove('show');
        }
    }

    async function loadCurrentUser(): Promise<string> {
        try {
            const response = await fetch('/api/users/me');
            if (!response.ok) {
                throw new Error('Failed to load user info');
            }
            const userData = await response.json();
            currentUsername = userData.username;

            // Обновляем отображение имени в сайдбаре
            const sidebarUsername = document.getElementById('sidebar-username');
            if (sidebarUsername) {
                sidebarUsername.innerHTML = `<i class="fas fa-user"></i> ${escapeHtml(currentUsername)}`;
            }

            // Сохраняем в window для других частей кода
            window.CURRENT_USER = currentUsername;

            console.log('Current user loaded:', currentUsername);
            return currentUsername;
        } catch (error) {
            console.error('Error loading current user:', error);
            // Если не удалось загрузить пользователя, перенаправляем на логин
            window.location.href = '/login';
            throw error;
        }
    }

    function initMessageStatuses(messages: Message[]) {
        if (!messages || currentChannelType !== 'dm') return;
        const myUser = currentUsername.trim().toLowerCase();

        for (const msg of messages) {
            if (msg.username !== currentUsername) continue;

            const readers = (msg.readBy as string[]) || [];
            const delivered = (msg.deliveredTo as string[]) || [];

            // Прочитано: кто-то кроме отправителя добавил себя в read_by
            const isRead = readers.some(u => u.trim().toLowerCase() !== myUser);
            // ✅ ИСПРАВЛЕНО: delivered_to содержит получателей. Если массив не пуст, сообщение доставлено.
            const isDelivered = delivered.length > 0;

            let s: MessageStatusType = MESSAGE_STATUS.SENT;
            if (isRead) s = MESSAGE_STATUS.READ;
            else if (isDelivered) s = MESSAGE_STATUS.DELIVERED;

            messageStatuses.set(msg.id, s);
        }
    }

    function getSafeUsername(username: string | null | undefined, isDeleted: boolean): string {
        if (isDeleted || username === null || username === undefined) return DELETED_USER_DISPLAY;
        return username;
    }

    function getUserAvatarLetter(username: string | null | undefined, isDeleted: boolean): string {
        if (isDeleted || username === null || username === undefined) return DELETED_USER_AVATAR;
        return username.charAt(0).toUpperCase();
    }

    async function syncMessageStatuses() {
        if (!currentChannel) return;
        try {
            const res = await fetch(`/api/messages/${currentChannel}/status`);
            if (!res.ok) return;

            const statuses = await res.json();
            let updatedCount = 0;

            for (const [msgId, data] of Object.entries(statuses)) {
                const info = data as { delivered: boolean; read: boolean };
                const currentStatus = messageStatuses.get(msgId);

                if (info.read && currentStatus !== MESSAGE_STATUS.READ) {
                    messageStatuses.set(msgId, MESSAGE_STATUS.READ);
                    updateMessageStatus(msgId, MESSAGE_STATUS.READ);
                    updatedCount++;
                } else if (info.delivered && currentStatus !== MESSAGE_STATUS.READ) {
                    messageStatuses.set(msgId, MESSAGE_STATUS.DELIVERED);
                    updateMessageStatus(msgId, MESSAGE_STATUS.DELIVERED);
                    updatedCount++;
                }
            }

            if (updatedCount > 0) console.log(`[StatusSync] Обновлено ${updatedCount} галочек`);
        } catch (e) {
            console.warn('[StatusSync] Ошибка синхронизации:', e);
        }
    }

    function observeMessagesForScrollButtons() {
        const messagesDiv = document.getElementById('messages-area');
        if (!messagesDiv) return;

        const observer = new MutationObserver(() => {
            updateScrollButtonsVisibility();
        });

        observer.observe(messagesDiv, {
            childList: true,
            subtree: true,
            attributes: false
        });
    }

    async function scrollToBottomSafely(force = false) {
        const messagesDiv = document.getElementById('messages-area');
        if (!messagesDiv) return;

        if (pendingScrollToBottom && !force) return;

        pendingScrollToBottom = true;

        if (force || isFirstLoad) {
            messagesDiv.classList.add('no-scroll');
            if (scrollLockTimeout) clearTimeout(scrollLockTimeout);
            scrollLockTimeout = window.setTimeout(() => {
                messagesDiv.classList.remove('no-scroll');
            }, 500);
        }

        setTimeout(() => {
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
            messagesDiv.classList.remove('no-scroll');
            if (scrollLockTimeout) clearTimeout(scrollLockTimeout);
            pendingScrollToBottom = false;
            if (force) {
                setTimeout(() => { isFirstLoad = false; }, 500);
            }
        }, 50);
    }

    function observeImageLoading(): MutationObserver | null {
        const messagesDiv = document.getElementById('messages-area');
        if (!messagesDiv) return null;

        const observer = new MutationObserver((mutations) => {
            let hasNewMedia = false;

            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            const el = node as Element;
                            if (el.querySelectorAll &&
                                (el.querySelectorAll('img.message-image, video').length > 0 ||
                                    (el.tagName === 'IMG' && el.classList.contains('message-image')) ||
                                    (el.tagName === 'VIDEO'))) {
                                hasNewMedia = true;
                                break;
                            }
                        }
                    }
                }
            }

            if (hasNewMedia && isFirstLoad === false) {
                const isNearBottom = messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < 100;
                if (isNearBottom) {
                    scrollToBottomSafely(false);
                }
            }
        });

        observer.observe(messagesDiv, { childList: true, subtree: true });
        return observer;
    }

    function getFileTypeFromUrl(url: string): 'image' | 'video' | 'audio' | 'file' {
        const ext = url.split('.').pop()?.toLowerCase() || '';
        if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'].includes(ext)) return 'image';
        if (['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv'].includes(ext)) return 'video';
        if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio';
        return 'file';
    }

    function formatFileMessage(fileUrl: string, fileName: string): string {
        const type = getFileTypeFromUrl(fileUrl);
        const safeUrl = fileUrl.replace(/'/g, "\\'");
        if (type === 'image') {
            return `<div class="message-file mt-2"><img class="message-image" src="${escapeHtml(fileUrl)}" onclick="event.stopPropagation(); openMediaModal('${safeUrl}', 'image')" loading="lazy" style="max-width:100%; max-height:400px; border-radius:12px; cursor:pointer;"></div>`;
        } else if (type === 'video') {
            return `<div class="message-file mt-2 video-preview-container" style="position: relative; display: inline-block; cursor: pointer;" onclick="event.stopPropagation(); openMediaModal('${safeUrl}', 'video')">
            <video class="message-video" style="max-width:100%; max-height:400px; border-radius:8px; background:#000; display: block;" preload="metadata">
                <source src="${escapeHtml(fileUrl)}">
            </video>
            <div class="video-play-button" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 60px; height: 60px; background: rgba(0,0,0,0.6); border-radius: 50%; display: flex; align-items: center; justify-content: center; pointer-events: none; transition: all 0.2s ease;">
                <i class="fas fa-play" style="color: white; font-size: 24px; margin-left: 4px;"></i>
            </div>
        </div>`;
        } else {
            return `<div class="message-file mt-2"><a href="${escapeHtml(fileUrl)}" target="_blank" class="btn btn-sm btn-outline-primary"><i class="fas fa-download"></i> Скачать: ${escapeHtml(fileName)}</a></div>`;
        }
    }

    function formatFileMessageWithLoading(fileUrl: string, fileName: string): string {
        const type = getFileTypeFromUrl(fileUrl);
        const safeUrl = fileUrl.replace(/'/g, "\\'");
        const isTempUrl = fileUrl.startsWith('blob:');

        if (type === 'image') {
            if (isTempUrl) {
                return `<div class="message-file mt-2">
                <img class="message-image" src="${escapeHtml(fileUrl)}" 
                    onclick="event.stopPropagation(); openMediaModal('${safeUrl}', 'image')" 
                    style="max-width:100%; max-height:300px; min-height:300px; border-radius:12px; cursor:pointer; object-fit:contain; background:#f0f2f5;">
            </div>`;
            }
            return `<div class="message-file mt-2" style="min-height: 200px; background: #f0f2f5; border-radius: 12px; display: flex; align-items: center; justify-content: center;">
            <img class="message-image loading" src="${escapeHtml(fileUrl)}" 
                data-src="${escapeHtml(fileUrl)}"
                onload="this.classList.remove('loading'); this.parentElement.style.background = 'transparent';" 
                onclick="event.stopPropagation(); openMediaModal('${safeUrl}', 'image')" 
                loading="lazy" 
                style="max-width:100%; max-height:300px; min-height:300px; border-radius:12px; cursor:pointer; object-fit:contain; display:block;">
        </div>`;
        } else if (type === 'video') {
            return `<div class="message-file mt-2 video-preview-container" style="min-height: 300px; background: #000; border-radius: 8px; display: flex; align-items: center; justify-content: center; position: relative; cursor: pointer;" onclick="event.stopPropagation(); openMediaModal('${safeUrl}', 'video')">
            <video class="message-video" style="max-width:100%; max-height:300px; min-height:300px; border-radius:8px; background:#000; display: block;" preload="metadata">
                <source src="${escapeHtml(fileUrl)}">
            </video>
            <div class="video-play-button" style="position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 60px; height: 60px; background: rgba(0,0,0,0.6); border-radius: 50%; display: flex; align-items: center; justify-content: center; pointer-events: none; transition: all 0.2s ease;">
                <i class="fas fa-play" style="color: white; font-size: 24px; margin-left: 4px;"></i>
            </div>
        </div>`;
        } else {
            return `<div class="message-file mt-2"><a href="${escapeHtml(fileUrl)}" target="_blank" class="btn btn-sm btn-outline-primary"><i class="fas fa-download"></i> Скачать: ${escapeHtml(fileName)}</a></div>`;
        }
    }

    function getMessageStatusHtml(message: Message): string {
        const isOwn = message.username === currentUsername;
        if (!isOwn) return '';
        if (currentChannelType !== 'dm') return '';

        // Сначала берём из кэша
        let status = messageStatuses.get(message.id);

        // Если кэш пуст (первичный рендер), вычисляем безопасно
        if (!status) {
            const myUser = currentUsername.trim().toLowerCase();
            const readers = (message.readBy as string[]) || [];
            const delivered = (message.deliveredTo as string[]) || [];

            const isRead = readers.some(u => u.trim().toLowerCase() !== myUser);
            const isDelivered = delivered.length > 0;

            if (isRead) status = MESSAGE_STATUS.READ;
            else if (isDelivered) status = MESSAGE_STATUS.DELIVERED;
            else status = MESSAGE_STATUS.SENT;

            messageStatuses.set(message.id, status);
        }

        switch (status) {
            case MESSAGE_STATUS.SENDING:
                return `<span class="message-status"><i class="fas fa-clock" style="color: #95a5a6; font-size: 11px;"></i></span>`;
            case MESSAGE_STATUS.SENT:
                return `<span class="message-status"><i class="fas fa-check" style="color: #95a5a6; font-size: 11px;"></i></span>`;
            case MESSAGE_STATUS.DELIVERED:
                return `<span class="message-status"><i class="fas fa-check-double" style="color: #95a5a6; font-size: 11px;"></i></span>`;
            case MESSAGE_STATUS.READ:
                return `<span class="message-status"><i class="fas fa-check-double" style="color: #34b7f1; font-size: 11px;"></i></span>`;
            default:
                return '';
        }
    }

    async function showReactionUsers(messageId: string, clickedEmoji: string, mouseEvent?: MouseEvent) {
        console.log('=== showReactionUsers START ===');
        console.log('messageId:', messageId);
        console.log('clickedEmoji:', clickedEmoji);

        try {
            // Получаем ВСЕ реакции на сообщение
            const response = await fetch(`/api/message/${messageId}/reactions`);

            if (!response.ok) {
                console.error('Failed to fetch reactions:', response.status);
                showNotification('Не удалось загрузить информацию о реакции', 'danger');
                return;
            }

            const allReactions = await response.json() as Reaction[];
            console.log('All reactions for message:', allReactions);

            if (!allReactions || allReactions.length === 0) {
                showNotification('Нет реакций на этом сообщении', 'info');
                return;
            }

            // Группируем реакции по эмодзи
            const reactionsByEmoji = new Map<string, string[]>();

            for (const reaction of allReactions) {
                if (!reactionsByEmoji.has(reaction.emoji)) {
                    reactionsByEmoji.set(reaction.emoji, []);
                }
                const users = reactionsByEmoji.get(reaction.emoji)!;
                if (!users.includes(reaction.userId)) {
                    users.push(reaction.userId);
                }
            }

            // Показываем всплывающую панель со сгруппированными реакциями
            await showReactionsGroupedPopup(reactionsByEmoji, allReactions, mouseEvent);

        } catch (error) {
            console.error('Error loading reaction users:', error);
            showNotification('Ошибка загрузки списка пользователей', 'danger');
        }
    }

    async function showReactionsGroupedPopup(reactionsByEmoji: Map<string, string[]>, allReactions: Reaction[], mouseEvent?: MouseEvent) {
        if (!reactionsByEmoji || reactionsByEmoji.size === 0) {
            showNotification('Нет реакций', 'info');
            return;
        }

        // Создаем мапу для быстрого доступа к дате реакции пользователя
        const userReactionDateMap = new Map<string, Map<string, string>>();
        for (const reaction of allReactions) {
            if (!userReactionDateMap.has(reaction.emoji)) {
                userReactionDateMap.set(reaction.emoji, new Map());
            }
            const emojiMap = userReactionDateMap.get(reaction.emoji)!;
            emojiMap.set(reaction.userId, reaction.createdAt);
        }

        // Удаляем старую панель, если есть
        const existingPopup = document.getElementById('reactionUsersPopup');
        if (existingPopup) existingPopup.remove();

        // Создаём панель
        const popup = document.createElement('div');
        popup.id = 'reactionUsersPopup';
        popup.className = 'reaction-users-popup';

        // Минимальные стили для компактной панели
        popup.style.cssText = `
        position: fixed;
        background: white;
        border-radius: 12px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15);
        z-index: 10000;
        min-width: 260px;
        max-width: 320px;
        max-height: 350px;
        overflow-y: auto;
        font-size: 12px;
        border: 1px solid #e0e0e0;
    `;

        let html = '<div style="padding: 0px 0;">';

        // Для каждого эмодзи выводим список пользователей
        for (const [emoji, users] of Array.from(reactionsByEmoji.entries())) {
            // Сортируем пользователей: текущий пользователь сверху
            const sortedUsers = [...users].sort((a, b) => {
                if (a === currentUsername) return -1;
                if (b === currentUsername) return 1;
                return 0;
            });

            html += `
            <div style="padding: 3px 5px; border-bottom: 1px solid #f0f0f0;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                    <span style="font-size: 1.2rem;">${escapeHtml(emoji)}</span>
                    <span style="font-size: 11px; color: #666; font-weight: 500;">${users.length}</span>
                </div>
                <div style="display: flex; flex-direction: column; gap: 6px; padding-left: 4px;">
        `;

            for (const username of sortedUsers) {
                const isCurrentUser = username === currentUsername;
                const displayName = isCurrentUser ? `${username} (Вы)` : username;

                // Получаем дату реакции для этого пользователя и эмодзи
                const emojiDateMap = userReactionDateMap.get(emoji);
                const reactionDate = emojiDateMap ? emojiDateMap.get(username) : null;
                const formattedDate = reactionDate ? formatReactionDate(reactionDate) : '';

                html += `
                <div class="reaction-user-item" data-username="${escapeHtml(username)}" style="
                    display: flex; 
                    align-items: center;
                    justify-content: space-between;
                    padding: 4px 6px;
                    border-radius: 6px;
                    transition: background 0.2s;
                    cursor: pointer;
                    font-size: 11px;
                    ${isCurrentUser ? 'background: #e8f0fe;' : ''}
                ">
                    <div style="display: flex; align-items: center; gap: 6px; flex: 1;">
                        <span style="color: #333;">${escapeHtml(displayName)}</span>
                        ${formattedDate ? `<span style="color: #999; font-size: 10px;">- ${formattedDate}</span>` : ''}
                    </div>
                    ${isCurrentUser ? '<i class="fas fa-check-circle" style="color: #007bff; font-size: 10px;"></i>' : ''}
                </div>
            `;
            }

            html += `
                </div>
            </div>
        `;
        }

        html += `</div>`;
        popup.innerHTML = html;

        document.body.appendChild(popup);

        // Позиционирование рядом с курсором
        const positionX = mouseEvent ? mouseEvent.clientX : window.innerWidth / 2;
        const positionY = mouseEvent ? mouseEvent.clientY : window.innerHeight / 2;

        const rect = popup.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Определяем оптимальную позицию
        let left = positionX + 15;
        let top = positionY - 20;

        // Корректировка по горизонтали
        if (left + rect.width > viewportWidth - 10) {
            left = positionX - rect.width - 15;
        }
        if (left < 10) {
            left = 10;
        }

        // Корректировка по вертикали
        if (top + rect.height > viewportHeight - 10) {
            top = positionY - rect.height - 10;
        }
        if (top < 10) {
            top = 10;
        }

        popup.style.left = left + 'px';
        popup.style.top = top + 'px';

        // Добавляем hover-эффект для элементов
        popup.querySelectorAll('.reaction-user-item').forEach(item => {
            const username = item.getAttribute('data-username');
            const isCurrent = username === currentUsername;

            (item as HTMLElement).addEventListener('mouseenter', () => {
                (item as HTMLElement).style.background = '#f5f5f5';
            });

            (item as HTMLElement).addEventListener('mouseleave', () => {
                (item as HTMLElement).style.background = isCurrent ? '#e8f0fe' : '';
            });

            // Клик по пользователю - открываем DM
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const userName = item.getAttribute('data-username');
                if (userName && userName !== currentUsername) {
                    startDMWithUser(userName);
                    popup.remove();
                }
            });
        });

        // Закрытие при клике вне
        const closePopup = (e: Event) => {
            if (popup && !popup.contains(e.target as Node)) {
                popup.remove();
                document.removeEventListener('click', closePopup);
                document.removeEventListener('scroll', closePopup);
            }
        };

        setTimeout(() => {
            document.addEventListener('click', closePopup);
            document.addEventListener('scroll', closePopup);
        }, 100);
    }

    function formatReactionDate(dateString: string): string {
        const date = new Date(dateString);
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const options: Intl.DateTimeFormatOptions = {
            day: 'numeric',
            month: 'long',
            hour: '2-digit',
            minute: '2-digit'
        };

        // Если сегодня
        if (date >= today) {
            return `сегодня ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        }
        // Если вчера
        else if (date >= yesterday) {
            return `вчера ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
        }
        // Иначе полная дата
        else {
            return date.toLocaleDateString('ru-RU', options);
        }
    }



    function updateMessageStatus(messageId: string, status: MessageStatusType) {
        // Обновляем кэш
        messageStatuses.set(messageId, status);

        // Ищем элемент в DOM
        const msgDiv = document.getElementById(`msg-${messageId}`);
        if (!msgDiv) return;

        // Находим span статуса
        const statusSpan = msgDiv.querySelector('.message-status');
        if (statusSpan) {
            let html = '';
            if (status === MESSAGE_STATUS.SENDING) {
                html = '<i class="fas fa-clock" style="color: #95a5a6; font-size: 11px;"></i>';
            } else if (status === MESSAGE_STATUS.SENT) {
                html = '<i class="fas fa-check" style="color: #95a5a6; font-size: 11px;"></i>';
            } else if (status === MESSAGE_STATUS.DELIVERED) {
                html = '<i class="fas fa-check-double" style="color: #95a5a6; font-size: 11px;"></i>';
            } else if (status === MESSAGE_STATUS.READ) {
                html = '<i class="fas fa-check-double" style="color: #34b7f1; font-size: 11px;"></i>';
            }
            if (html) statusSpan.innerHTML = html;
        }
    }

    function formatMessage(msg: Message): string {
        const isDeletedSender = msg.isDeletedSender === true || msg.username === DELETED_USER_DISPLAY;
        const isOwn = (!isDeletedSender && msg.username === currentUsername);
        const displayUsername = getSafeUsername(msg.username, isDeletedSender);
        const avatarLetter = getUserAvatarLetter(msg.username, isDeletedSender);
        const time = new Date(msg.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const date = new Date(msg.timestamp).toLocaleDateString('ru-RU');
        const fullTime = `${date} ${time}`;

        let replyHtml = '';
        if (msg.replyTo) {
            const replyIsDeleted = msg.replyTo.isDeleted === true;
            const replyDisplayName = getSafeUsername(msg.replyTo.username, replyIsDeleted);
            const replyContent = msg.replyTo.content
                ? (msg.replyTo.content.length > 50 ? msg.replyTo.content.substring(0, 47) + '...' : msg.replyTo.content)
                : (msg.replyTo.fileUrl ? '📎 Файл' : '');
            replyHtml = `<div class="message-reply" data-reply-id="${escapeHtml(msg.replyTo.id)}">
            <div class="reply-header"><i class="fas fa-reply"></i> ${escapeHtml(replyDisplayName)}</div>
            <div class="reply-content">${escapeHtml(replyContent)}</div>
        </div>`;
        }

        let fileHtml = '';
        if (msg.fileUrl) {
            const fileName = msg.fileUrl.split('/').pop() || 'file';
            if (msg.isTemp && msg.fileUrl.startsWith('blob:')) {
                fileHtml = formatFileMessage(msg.fileUrl, fileName);
            } else {
                fileHtml = formatFileMessageWithLoading(msg.fileUrl, fileName);
            }
        }

        let reactionsHtml = '';
        if (msg.reactions && msg.reactions.length) {
            reactionsHtml = `<div class="message-reactions">${msg.reactions.map(r => `<span class="reaction-badge" data-msg-id="${escapeHtml(msg.id)}" data-emoji="${escapeHtml(r.emoji)}" style="cursor: pointer;"><span class="reaction-emoji">${escapeHtml(r.emoji)}</span> <span class="reaction-count">${r.users.length}</span></span>`).join('')}</div>`;
        }

        const safeUsername = escapeHtml(displayUsername);
        const safeContent = msg.content ? formatText(msg.content) : '';
        const messageStatus = getMessageStatusHtml(msg);

        const editedIndicator = msg.edited ? '<span class="message-time">(ред.)</span>' : '';

        let readCounterHtml = '';
        if (currentChannelType === 'channel') {
            const readByList = messageReadBy.get(msg.id) || [];
            const otherReaders = readByList.filter(u => u !== msg.username);
            const readCount = otherReaders.length;

            if (readCount > 0) {
                readCounterHtml = `<span class="read-counter ms-2" data-msg-id="${escapeHtml(msg.id)}" style="cursor: pointer; font-size: 10px; color: #6c757d; display: inline-flex; align-items: center; gap: 3px;">
                <i class="fas fa-eye"></i> ${readCount}
            </span>`;
            }
        }

        const actionButtons = `<div class="message-actions" id="actions-${escapeHtml(msg.id)}">
        <button class="message-action-btn" data-action="reply" data-msg-id="${escapeHtml(msg.id)}" data-username="${escapeHtml(msg.username)}" data-content='${JSON.stringify(msg.content || "").replace(/'/g, "&#39;")}'>
            <i class="fas fa-reply"></i> Ответить
        </button>
        ${isOwn ? `<button class="message-action-btn" data-action="edit" data-msg-id="${escapeHtml(msg.id)}" data-content='${JSON.stringify(msg.content || "").replace(/'/g, "&#39;")}'>
            <i class="fas fa-edit"></i> Редактировать
        </button>
        <button class="message-action-btn" data-action="delete" data-msg-id="${escapeHtml(msg.id)}">
            <i class="fas fa-trash"></i> Удалить
        </button>` : ''}
        <button class="message-action-btn" data-action="reaction" data-msg-id="${escapeHtml(msg.id)}">
            <i class="far fa-smile"></i> Реакция
        </button>
    </div>`;

        return `<div class="message ${isOwn ? 'message-own' : ''}" id="msg-${escapeHtml(msg.id)}" data-channel-id="${escapeHtml(msg.channelId || currentChannel || '')}" data-channel-type="${escapeHtml(currentChannelType || 'channel')}">
        <div class="message-wrapper">
            <div class="message-avatar">${escapeHtml(avatarLetter)}</div>
            <div class="message-content-wrapper">
                <div class="message-bubble">
                    <div class="message-header">
                        <span class="message-username">${safeUsername}</span>
                        <span class="message-time">${escapeHtml(fullTime)}</span>
                        ${editedIndicator}
                        ${currentChannelType === 'dm' ? messageStatus : ''}
                        ${readCounterHtml}
                    </div>
                    ${replyHtml}
                    ${safeContent ? `<div class="message-text">${safeContent}</div>` : ''}
                    ${fileHtml}
                    ${reactionsHtml}
                </div>
                ${actionButtons}
            </div>
        </div>
    </div>`;
    }

    function formatText(c: string | null | undefined): string {
        if (!c) return '';
        let f = sanitizeHtml(c);
        f = f.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/`(.*?)`/g, '<code>$1</code>')
            // Сохраняем переносы строк - НЕ заменяем <br> на \n
            .replace(/\n/g, '<br>')
            .replace(/(https?:\/\/[^\s]+)/g, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
            .replace(/([\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}])/gu, '<span style="font-size:2.0em;">$1</span>');
        return f;
    }

    function bindMessageEvents() {
        // Привязываем обработчики для всех кнопок действий в сообщениях
        const messagesArea = document.getElementById('messages-area');
        if (!messagesArea) return;

        // Используем делегирование событий вместо onclick атрибутов
        messagesArea.removeEventListener('click', handleMessageActions);
        messagesArea.addEventListener('click', handleMessageActions);
    }

    function handleMessageActions(e: MouseEvent) {
        const target = e.target as HTMLElement;

        console.log('Click detected on:', target.className, target.tagName); // Добавьте это

        // Обработка клика по реакции
        const reactionBadge = target.closest('.reaction-badge');


        if (reactionBadge) {
            const msgId = reactionBadge.getAttribute('data-msg-id');
            const emoji = reactionBadge.getAttribute('data-emoji');
            e.preventDefault();
            e.stopPropagation();
            if (msgId && emoji) {
                // Проверяем, был ли клик по счётчику (числу)
                const countElement = target.closest('.reaction-count');
                const emojiElement = target.closest('.reaction-emoji');
                const isEmojiClick = emojiElement !== null;
                const isCountClick = countElement !== null;

                if (isCountClick) {
                    // Передаём mouseEvent для позиционирования рядом с курсором
                    showReactionUsers(msgId, emoji, e);
                }
                if (isEmojiClick){
                    // Добавляем/убираем реакцию (стандартное поведение)
                    addReaction(msgId, emoji);
                }
            }

        


            return;
        }

        // Обработка кнопок действий
        const actionButton = target.closest('.message-action-btn');
        if (actionButton) {
            e.preventDefault();
            e.stopPropagation();

            const action = actionButton.getAttribute('data-action');
            const msgId = actionButton.getAttribute('data-msg-id');
            if (!msgId) return;

            switch (action) {
                case 'reply':
                    const username = actionButton.getAttribute('data-username') || '';
                    const content = actionButton.getAttribute('data-content') || '';
                    replyToMessage(msgId, username, content);
                    closeAllMessageActions();
                    break;
                case 'edit':
                    editMessage(msgId);
                    closeAllMessageActions();
                    break;
                case 'delete':
                    deleteMessage(msgId);
                    closeAllMessageActions();
                    break;
                case 'reaction':
                    showReactionPanel(msgId, e);
                    closeAllMessageActions();
                    break;
                default:
                    break;
            }
            return;
        }

        // Обработка клика по сообщению (для показа действий)
        const messageBubble = target.closest('.message-bubble');
        if (messageBubble) {
            const msgDiv = messageBubble.closest('.message');
            if (msgDiv) {
                const msgId = msgDiv.id.replace('msg-', '');
                toggleMessageActions(msgId);
            }
            return;
        }

        

        // Обработка клика по счетчику прочитавших
        const readCounter = target.closest('.read-counter');
        if (readCounter) {
            e.preventDefault();
            e.stopPropagation();
            const msgId = readCounter.getAttribute('data-msg-id');
            if (msgId) {
                showReadByList(msgId);
            }
            return;
        }

        // Обработка клика по ответу (reply) - используем переменную replyId
        const messageReply = target.closest('.message-reply');
        if (messageReply) {
            e.preventDefault();
            e.stopPropagation();
            const replyToMsgId = messageReply.getAttribute('data-reply-id');
            if (replyToMsgId) {
                scrollToMessage(replyToMsgId);
            }
            return;
        }

        // Закрываем панель действий при клике вне
        if (!target.closest('.message-actions')) {
            closeAllMessageActions();
        }
    }

    function displayMessages(msgs: Message[]) {
        initMessageStatuses(msgs);

        const div = document.getElementById('messages-area');
        if (!msgs || msgs.length === 0) {
            if (div) div.innerHTML = '<div class="text-center text-muted mt-5">Нет сообщений. Напишите первое!</div>';
            return;
        }

        msgs.forEach((msg: Message) => {
            if (msg.readBy) messageReadBy.set(msg.id, msg.readBy);
        });

        if (div) div.innerHTML = msgs.map((m: Message) => formatMessage(m)).join('');

        msgs.forEach((msg: Message) => {
            if (currentChannelType === 'channel') {
                updateReadByDisplay(msg.id);
            }
        });

        attachReadCounterHandlers();
        bindMessageEvents();
        scrollToBottomSafely(true);
        setTimeout(() => markVisibleMessagesAsRead(), 500);
        setTimeout(() => updateScrollButtonsVisibility(), 100);
    }

    function prependMessages(messages: Message[]) {
        const messagesDiv = document.getElementById('messages-area');
        if (!messagesDiv) return;

        const oldScrollHeight = messagesDiv.scrollHeight;
        const oldScrollTop = messagesDiv.scrollTop;

        const newMessages = messages.filter((msg: Message) => !receivedMessages.has(msg.id));
        if (newMessages.length === 0) return;


        initMessageStatuses(newMessages);

        for (const msg of newMessages) {
            if (msg.readBy) messageReadBy.set(msg.id, msg.readBy);
        }
        let newMessagesHtml = '';
        for (const msg of newMessages) {
            receivedMessages.add(msg.id);
            newMessagesHtml += formatMessage(msg);
        }
        if (newMessagesHtml) {
            messagesDiv.insertAdjacentHTML('afterbegin', newMessagesHtml);
            attachReadCounterHandlers();
            for (const msg of newMessages) {
                if (msg.username === currentUsername) {
                    updateReadByDisplay(msg.id);
                }
            }
            const newScrollHeight = messagesDiv.scrollHeight;
            const heightDiff = newScrollHeight - oldScrollHeight;
            messagesDiv.scrollTop = oldScrollTop + heightDiff;
        }
        bindMessageEvents();
        setTimeout(() => updateScrollButtonsVisibility(), 100);
    }

    function updateReadByDisplay(messageId: string) {
        if (currentChannelType !== 'channel') return;

        const msgDiv = document.getElementById(`msg-${messageId}`);
        if (!msgDiv) return;

        const msgUsernameElem = msgDiv.querySelector('.message-username');
        const msgUsername = msgUsernameElem ? msgUsernameElem.textContent : null;

        const readBy = messageReadBy.get(messageId) || [];
        const otherReaders = msgUsername ? readBy.filter(u => u !== msgUsername) : readBy;
        const readCount = otherReaders.length;

        let readCounter = msgDiv.querySelector('.read-counter') as HTMLElement | null;

        if (readCount > 0) {
            if (!readCounter) {
                const headerDiv = msgDiv.querySelector('.message-header');
                if (headerDiv) {
                    readCounter = document.createElement('span');
                    readCounter.className = 'read-counter ms-2';
                    readCounter.style.cssText = 'cursor: pointer; font-size: 10px; color: #6c757d; display: inline-flex; align-items: center; gap: 3px;';
                    readCounter.setAttribute('data-msg-id', messageId);
                    readCounter.onclick = (e) => {
                        e.stopPropagation();
                        showReadByList(messageId);
                    };
                    headerDiv.appendChild(readCounter);
                }
            }
            if (readCounter) {
                readCounter.innerHTML = `<i class="fas fa-eye"></i> ${readCount}`;
                readCounter.style.display = 'inline-flex';
            }
        } else {
            if (readCounter) {
                readCounter.style.display = 'none';
            }
        }
    }

    function showReadByList(messageId: string) {
        console.log('=== showReadByList called ===');
        console.log('messageId:', messageId);

        const msgDiv = document.getElementById(`msg-${messageId}`);
        if (!msgDiv) {
            console.error('Message div not found for id:', messageId);
            showNotification('Сообщение не найдено', 'danger');
            return;
        }

        const msgUsernameElem = msgDiv.querySelector('.message-username');
        const msgUsername = msgUsernameElem?.textContent;
        console.log('Message username:', msgUsername);

        // Получаем readBy из локального кэша
        let readBy = messageReadBy.get(messageId) || [];
        console.log('readBy from cache:', readBy);

        // Всегда делаем запрос к серверу для получения актуальных данных
        console.log('Fetching read status from server...');
        fetch(`/api/message/${messageId}/read_status`)
            .then(res => {
                console.log('Response status:', res.status);
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                return res.json();
            })
            .then(data => {
                console.log('Server response:', data);
                let serverReadBy = data.read_by || [];
                console.log('readBy from server:', serverReadBy);

                // Обновляем локальный кэш
                messageReadBy.set(messageId, serverReadBy);

                // Фильтруем автора сообщения
                if (msgUsername) {
                    serverReadBy = serverReadBy.filter((u: string) => u !== msgUsername);
                }

                console.log('Filtered readBy (without author):', serverReadBy);

                if (serverReadBy.length === 0) {
                    showNotification('Никто ещё не прочитал это сообщение', 'info');
                    return;
                }

                // Показываем всплывающую панель
                showReadByModal(serverReadBy);
            })
            .catch(err => {
                console.error('Error fetching read status:', err);
                // Если сервер вернул ошибку, пробуем использовать локальный кэш
                if (readBy.length === 0) {
                    showNotification('Не удалось загрузить список прочитавших', 'danger');
                } else {
                    // Фильтруем автора
                    if (msgUsername) {
                        readBy = readBy.filter(u => u !== msgUsername);
                    }
                    if (readBy.length > 0) {
                        showReadByModal(readBy);
                    } else {
                        showNotification('Никто ещё не прочитал это сообщение', 'info');
                    }
                }
            });
    }

    function showReadByModal(readBy: string[]) {
        console.log('=== showReadByModal called ===');
        console.log('Users to display:', readBy);

        if (!readBy || readBy.length === 0) {
            console.warn('No users to display');
            return;
        }

        // Удаляем старую панель, если есть
        const existingPopup = document.getElementById('readByPopup');
        if (existingPopup) existingPopup.remove();

        // Создаём панель
        const popup = document.createElement('div');
        popup.id = 'readByPopup';
        popup.className = 'reaction-users-popup'; // используем те же стили

        popup.style.cssText = `
        position: fixed;
        background: white;
        border-radius: 16px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.2);
        z-index: 10000;
        min-width: 220px;
        max-width: 280px;
        max-height: 350px;
        overflow-y: auto;
        font-size: 13px;
        border: 1px solid #e0e0e0;
    `;

        // Заголовок
        let html = `
        <div style="padding: 12px 16px; border-bottom: 1px solid #e0e0e0; background: #f8f9fa; border-radius: 16px 16px 0 0; position: sticky; top: 0; z-index: 1;">
            <div style="display: flex; align-items: center; gap: 8px;">
                <i class="fas fa-eye" style="color: #007bff; font-size: 18px;"></i>
                <span style="font-weight: 600; color: #333;">Прочитали сообщение (${readBy.length})</span>
            </div>
        </div>
        <div style="padding: 8px 0;">
    `;

        for (const username of readBy) {
            const isCurrentUser = username === currentUsername;

            html += `
            <div class="readby-popup-item" style="
                display: flex; 
                align-items: center; 
                justify-content: space-between; 
                padding: 10px 16px;
                transition: background 0.2s;
                cursor: pointer;
                ${isCurrentUser ? 'background: #e8f0fe;' : ''}
            ">
                <div style="display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0;">
                    <div style="
                        width: 36px; 
                        height: 36px; 
                        border-radius: 50%; 
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); 
                        display: flex; 
                        align-items: center; 
                        justify-content: center; 
                        color: white; 
                        font-weight: bold;
                        font-size: 14px;
                        flex-shrink: 0;
                    ">
                        ${escapeHtml(username.charAt(0).toUpperCase())}
                    </div>
                    <div style="min-width: 0; flex: 1;">
                        <div style="font-weight: 500; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                            <span style="word-break: break-word;">${escapeHtml(username)}</span>
                            ${isCurrentUser ? '<span style="background: #007bff; color: white; font-size: 10px; padding: 2px 6px; border-radius: 12px;">Вы</span>' : ''}
                        </div>
                    </div>
                </div>
                ${isCurrentUser ? '<i class="fas fa-check-circle" style="color: #007bff; font-size: 14px;"></i>' : '<i class="fas fa-check-double" style="color: #34b7f1; font-size: 14px;"></i>'}
            </div>
        `;
        }

        html += `</div>`;
        popup.innerHTML = html;

        document.body.appendChild(popup);

        // Позиционирование по центру экрана (для глаза - центрируем)
        const rect = popup.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        let left = (viewportWidth - rect.width) / 2;
        let top = (viewportHeight - rect.height) / 2;

        // Корректировка, чтобы не выходило за границы
        if (left < 10) left = 10;
        if (top < 10) top = 10;

        popup.style.left = left + 'px';
        popup.style.top = top + 'px';

        // Добавляем hover-эффект для элементов
        popup.querySelectorAll('.readby-popup-item').forEach(item => {
            (item as HTMLElement).addEventListener('mouseenter', () => {
                (item as HTMLElement).style.background = '#f5f5f5';
            });
            (item as HTMLElement).addEventListener('mouseleave', () => {
                const isCurrent = (item as HTMLElement).querySelector('span')?.textContent === currentUsername;
                (item as HTMLElement).style.background = isCurrent ? '#e8f0fe' : '';
            });

            // Клик по пользователю - открываем DM
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const nameElement = item.querySelector('.readby-popup-item > div > div > div:first-child > span:first-child');
                if (nameElement && nameElement.textContent !== currentUsername) {
                    startDMWithUser(nameElement.textContent || '');
                    popup.remove();
                }
            });
        });

        // Закрытие при клике вне
        const closePopup = (e: Event) => {
            if (popup && !popup.contains(e.target as Node)) {
                popup.remove();
                document.removeEventListener('click', closePopup);
                document.removeEventListener('scroll', closePopup);
            }
        };

        setTimeout(() => {
            document.addEventListener('click', closePopup);
            document.addEventListener('scroll', closePopup);
        }, 100);
    }

    // ============ АВТО-РАСШИРЕНИЕ TEXTAREA ============

    function autoResizeTextarea() {
        const textarea = document.getElementById('messageInput') as HTMLTextAreaElement | null;
        if (!textarea) return;
        textarea.style.height = 'auto';
        const scrollHeight = textarea.scrollHeight;
        const newHeight = Math.min(scrollHeight, 120);
        textarea.style.height = newHeight + 'px';
        textarea.style.overflowY = scrollHeight > 120 ? 'auto' : 'hidden';
    }

    // ============ ЭМОДЗИ ============

    const commonEmojis = ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿', '👹', '👺', '🤡', '💩', '👻', '💀', '☠️', '👽', '👾', '🤖', '🎃'];
    const heartEmojis = ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝'];
    const gestureEmojis = ['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👊', '✊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🦷', '🦴', '👀', '👁️', '👅', '👄'];
    const symbolEmojis = ['⭐', '🌟', '✨', '⚡', '🔥', '💧', '❄️', '☀️', '🌈', '☁️', '⛅', '🌤️', '🌥️', '🌦️', '🌧️', '🌨️', '🌩️', '🌪️', '🌫️', '🌬️', '🌀', '🌊', '💨', '💫', '💥', '💢', '💦', '💤', '🎉', '🎊', '🎈', '🎁', '🎀', '🎄', '🎃', '🎆', '🎇'];

    function insertEmoji(emoji: string) {
        const input = document.getElementById('messageInput') as HTMLTextAreaElement | null;
        if (!input) return;
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const text = input.value;
        input.value = text.substring(0, start) + emoji + text.substring(end);
        input.focus();
        input.selectionStart = input.selectionEnd = start + emoji.length;
        input.dispatchEvent(new Event('input'));
        autoResizeTextarea();
    }

    function renderEmojiPicker() {
        const container = document.getElementById('emojiPickerContainer');
        if (!container) return;

        const categories = [
            { name: '😊 Смайлы', emojis: commonEmojis },
            { name: '❤️ Сердца', emojis: heartEmojis },
            { name: '👍 Жесты', emojis: gestureEmojis },
            { name: '⭐ Символы', emojis: symbolEmojis }
        ];

        let html = '<div class="emoji-categories">';
        categories.forEach((cat, idx) => {
            html += `<button class="emoji-category ${idx === 0 ? 'active' : ''}" data-cat="${idx}">${cat.name}</button>`;
        });
        html += '</div><div class="emoji-grid" id="emojiGrid">';

        categories[0].emojis.forEach(emoji => {
            html += `<div class="emoji-item" data-emoji="${emoji}">${emoji}</div>`;
        });
        html += '</div>';

        container.innerHTML = html;

        container.querySelectorAll('.emoji-category').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const catIdx = parseInt(btn.getAttribute('data-cat') || '0');
                container.querySelectorAll('.emoji-category').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const grid = document.getElementById('emojiGrid');
                if (grid && categories[catIdx]) {
                    grid.innerHTML = categories[catIdx].emojis.map(emoji =>
                        `<div class="emoji-item" data-emoji="${emoji}">${emoji}</div>`
                    ).join('');

                    grid.querySelectorAll('.emoji-item').forEach(item => {
                        item.addEventListener('click', (e) => {
                            e.stopPropagation();
                            const em = item.getAttribute('data-emoji');
                            if (em) insertEmoji(em);
                            container.style.display = 'none';
                        });
                    });
                }
            });
        });

        container.querySelectorAll('.emoji-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                const em = item.getAttribute('data-emoji');
                if (em) insertEmoji(em);
                container.style.display = 'none';
            });
        });
    }

    function toggleEmojiPicker() {
        const container = document.getElementById('emojiPickerContainer');
        if (!container) return;
        if (container.style.display === 'block') {
            container.style.display = 'none';
        } else {
            renderEmojiPicker();
            container.style.display = 'block';
        }
    }

    document.addEventListener('click', function (e) {
        const container = document.getElementById('emojiPickerContainer');
        const emojiBtn = document.getElementById('emojiButton');
        if (container && container.style.display === 'block' && !container.contains(e.target as Node) && e.target !== emojiBtn && emojiBtn && !emojiBtn.contains(e.target as Node)) {
            container.style.display = 'none';
        }
    });

    // ============ ЗАГРУЗКА И ОТПРАВКА ФАЙЛОВ ============

    let pendingFileBlob: File | null = null;
    let pendingFileUrl: string | null = null;
    let pendingFileName: string | null = null;

    function handleFileSelect(input: HTMLInputElement) {
        const file = input.files?.[0];
        if (!file) return;
        showFilePreview(file);
        input.value = '';
    }

    function showFilePreview(file: File) {
        const url = URL.createObjectURL(file);
        const div = document.getElementById('pastePreview');
        const isImage = file.type.startsWith('image/');
        const isVideo = file.type.startsWith('video/');

        let content = '';
        if (isImage) {
            content = `<img src="${url}" style="max-width:100%; max-height:200px; border-radius:8px; object-fit:contain;">`;
        } else if (isVideo) {
            content = `<video src="${url}" style="max-width:100%; max-height:200px; border-radius:8px;" controls></video>`;
        } else {
            content = `<div style="padding:20px; text-align:center; background:#f0f2f5; border-radius:8px;">
        <i class="fas fa-file fa-3x" style="color:#6c757d;"></i>
        <div style="margin-top:8px; font-size:12px; color:#666;">${escapeHtml(file.name)}</div>
    </div>`;
        }

        if (div) {
            div.innerHTML = `<div class="preview-content">
        ${content}
        <div class="preview-actions" style="margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end;">
            <button class="btn-cancel" onclick="cancelFilePreview()"><i class="fas fa-times"></i></button>
        </div>
    </div>`;
            div.style.display = 'block';
        }

        pendingFileBlob = file;
        pendingFileUrl = url;
        pendingFileName = file.name;

        // Фокусируемся на основном поле ввода для текста
        const messageInput = document.getElementById('messageInput') as HTMLTextAreaElement | null;
        if (messageInput) messageInput.focus();
    }

    async function sendFileFromPreview() {
        if (!pendingFileBlob) {
            showNotification('Нет файла для отправки', 'warning');
            return;
        }
        if (!currentChannel) {
            showNotification('Выберите чат для отправки', 'warning');
            return;
        }

        const file = pendingFileBlob;
        const fileName = pendingFileName || 'file';

        // Получаем текст подписи из textarea
        const captionInput = document.getElementById('fileCaptionInput') as HTMLTextAreaElement | null;
        let caption = captionInput ? captionInput.value.trim() : '';
        caption = sanitizeInput(caption);

        const replyData = replyToMessageData ? { id: replyToMessageData.id, username: replyToMessageData.username, content: replyToMessageData.content } : null;

        // Сохраняем caption во временное хранилище, чтобы использовать после загрузки файла
        const tempCaption = caption;

        cancelReply();
        cancelFilePreview();

        const formData = new FormData();
        formData.append('file', file, fileName);
        formData.append('channelId', currentChannel || '');

        // Показываем индикатор загрузки
        const progressContainer = document.getElementById('uploadProgressContainer');
        if (progressContainer) {
            progressContainer.classList.add('show');
            const fileNameSpan = document.getElementById('uploadFileName');
            if (fileNameSpan) fileNameSpan.textContent = fileName;
            const progressBar = document.getElementById('uploadProgressBar');
            if (progressBar) progressBar.style.width = '0%';
            const percentSpan = document.getElementById('uploadPercent');
            if (percentSpan) percentSpan.textContent = '0';
            const statusSpan = document.getElementById('uploadStatus');
            if (statusSpan) statusSpan.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Загрузка файла...';
        }

        try {
            // Используем XMLHttpRequest для отслеживания прогресса
            const xhr = new XMLHttpRequest();

            const uploadPromise = new Promise<{ success: boolean; fileUrl: string; error?: string }>((resolve, reject) => {
                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        const percent = Math.round((e.loaded / e.total) * 100);
                        const progressBar = document.getElementById('uploadProgressBar');
                        if (progressBar) progressBar.style.width = percent + '%';
                        const percentSpan = document.getElementById('uploadPercent');
                        if (percentSpan) percentSpan.textContent = percent.toString();
                    }
                });

                xhr.onload = () => {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        if (xhr.status === 200 && data.success) {
                            resolve(data);
                        } else {
                            reject(new Error(data.error || 'Ошибка загрузки файла'));
                        }
                    } catch (e) {
                        reject(new Error('Ошибка обработки ответа сервера'));
                    }
                };

                xhr.onerror = () => reject(new Error('Ошибка сети'));
                xhr.onabort = () => reject(new Error('Загрузка отменена'));

                xhr.open('POST', '/upload', true);
                xhr.send(formData);
            });

            const data = await uploadPromise;

            // Скрываем прогресс
            if (progressContainer) progressContainer.classList.remove('show');

            if (data.success) {
                const tempId = 'temp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);

                // Сохраняем во временные сообщения с подписью
                pendingMessages.set(tempId, {
                    content: tempCaption,
                    fileUrl: data.fileUrl,
                    replyTo: replyData,
                    channelId: currentChannel
                });

                // Отправляем SignalR сообщение с подписью
                await connection.invoke('SendMessage', {
                    tempId: tempId,
                    channelId: currentChannel,
                    content: tempCaption,
                    fileUrl: data.fileUrl,
                    replyTo: replyData
                });

                showNotification(tempCaption ? 'Файл с подписью отправлен!' : 'Файл отправлен!', 'success');
            } else {
                showNotification(data.error || 'Ошибка загрузки файла', 'danger');
            }
        } catch (e) {
            if (progressContainer) progressContainer.classList.remove('show');
            console.error(e);
            showNotification((e as Error).message || 'Ошибка загрузки файла', 'danger');
        }
    }

    async function sendFileMessage() {
        if (!pendingFileBlob) {
            showNotification('Нет файла для отправки', 'warning');
            return;
        }
        if (!currentChannel) {
            showNotification('Выберите чат для отправки', 'warning');
            return;
        }

        const file = pendingFileBlob;
        const fileName = pendingFileName || 'file';

        // Берем текст из основного поля ввода
        const messageInput = document.getElementById('messageInput') as HTMLTextAreaElement | null;
        let textContent = messageInput ? messageInput.value.trim() : '';
        textContent = sanitizeInput(textContent);

        const replyData = replyToMessageData ? { id: replyToMessageData.id, username: replyToMessageData.username, content: replyToMessageData.content } : null;

        // Очищаем preview и reply перед отправкой
        cancelReply();
        cancelFilePreview();

        // Очищаем поле ввода
        if (messageInput) {
            messageInput.value = '';
            autoResizeTextarea();
        }

        const formData = new FormData();
        formData.append('file', file, fileName);
        formData.append('channelId', currentChannel || '');

        // Показываем индикатор загрузки
        const progressContainer = document.getElementById('uploadProgressContainer');
        if (progressContainer) {
            progressContainer.classList.add('show');
            const fileNameSpan = document.getElementById('uploadFileName');
            if (fileNameSpan) fileNameSpan.textContent = fileName;
            const progressBar = document.getElementById('uploadProgressBar');
            if (progressBar) progressBar.style.width = '0%';
            const percentSpan = document.getElementById('uploadPercent');
            if (percentSpan) percentSpan.textContent = '0';
            const statusSpan = document.getElementById('uploadStatus');
            if (statusSpan) statusSpan.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Загрузка файла...';
        }

        try {
            const xhr = new XMLHttpRequest();

            const uploadPromise = new Promise<{ success: boolean; fileUrl: string; error?: string }>((resolve, reject) => {
                xhr.upload.addEventListener('progress', (e) => {
                    if (e.lengthComputable) {
                        const percent = Math.round((e.loaded / e.total) * 100);
                        const progressBar = document.getElementById('uploadProgressBar');
                        if (progressBar) progressBar.style.width = percent + '%';
                        const percentSpan = document.getElementById('uploadPercent');
                        if (percentSpan) percentSpan.textContent = percent.toString();
                    }
                });

                xhr.onload = () => {
                    try {
                        const data = JSON.parse(xhr.responseText);
                        if (xhr.status === 200 && data.success) {
                            resolve(data);
                        } else {
                            reject(new Error(data.error || 'Ошибка загрузки файла'));
                        }
                    } catch (e) {
                        reject(new Error('Ошибка обработки ответа сервера'));
                    }
                };

                xhr.onerror = () => reject(new Error('Ошибка сети'));
                xhr.onabort = () => reject(new Error('Загрузка отменена'));

                xhr.open('POST', '/upload', true);
                xhr.send(formData);
            });

            const data = await uploadPromise;

            if (progressContainer) progressContainer.classList.remove('show');

            if (data.success) {
                const tempId = 'temp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);

                pendingMessages.set(tempId, {
                    content: textContent,
                    fileUrl: data.fileUrl,
                    replyTo: replyData,
                    channelId: currentChannel
                });

                await connection.invoke('SendMessage', {
                    tempId: tempId,
                    channelId: currentChannel,
                    content: textContent,
                    fileUrl: data.fileUrl,
                    replyTo: replyData
                });
                scrollToBottomSafely(true);
                showNotification(textContent ? 'Сообщение с файлом отправлено!' : 'Файл отправлен!', 'success');
            } else {
                showNotification(data.error || 'Ошибка загрузки файла', 'danger');
            }
        } catch (e) {
            if (progressContainer) progressContainer.classList.remove('show');
            console.error(e);
            showNotification((e as Error).message || 'Ошибка загрузки файла', 'danger');
        }
    }

    function cancelFilePreview() {
        const div = document.getElementById('pastePreview');
        if (div) {
            div.style.display = 'none';
            div.innerHTML = '';
        }
        if (pendingFileUrl) URL.revokeObjectURL(pendingFileUrl);
        pendingFileBlob = null;
        pendingFileUrl = null;
        pendingFileName = null;
    }

    function cancelFile() {
        const filePreview = document.getElementById('filePreview');
        const fileNameSpan = document.getElementById('fileName');
        const fileInput = document.getElementById('fileInput') as HTMLInputElement | null;
        if (filePreview) filePreview.style.display = 'none';
        if (fileNameSpan) fileNameSpan.textContent = '';
        if (fileInput) fileInput.value = '';
    }

    function handlePaste(e: ClipboardEvent) {
        const items = (e.clipboardData || (e as any).originalEvent?.clipboardData)?.items;
        if (!items) return;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type.indexOf('image') !== -1) {
                e.preventDefault();
                const blob = item.getAsFile();
                if (blob) {
                    const now = new Date();
                    const dateStr = now.toISOString().slice(0, 19).replace(/:/g, '-');
                    const ext = blob.type.split('/')[1] || 'png';
                    const filename = `pasted-${dateStr}.${ext}`;
                    const file = new File([blob], filename, { type: blob.type });
                    showFilePreview(file);
                }
                break;
            }
        }
    }

    function showEditingIndicator(messageContent: string) {
        if (editingIndicator) editingIndicator.remove();

        // Если открыт reply preview – скрываем его
        const replyPreview = document.getElementById('replyPreview');
        if (replyPreview && replyPreview.style.display === 'flex') cancelReply();

        editingIndicator = document.createElement('div');
        editingIndicator.id = 'editingPreview';
        editingIndicator.className = 'editing-preview';

        // Определяем текст для отображения в индикаторе
        let previewText = messageContent;
        let iconClass = 'fas fa-edit';
        let iconColor = '#28a745';

        if (!messageContent || messageContent.trim() === '') {
            previewText = 'Добавить текст к файлу';
            iconClass = 'fas fa-file-image';
            iconColor = '#17a2b8';
        } else if (messageContent.length > 50) {
            previewText = messageContent.substring(0, 47) + '...';
        }

        editingIndicator.innerHTML = `
        <div class="editing-preview-content" onclick="window.scrollToEditingMessage()">
            <i class="${iconClass}" style="color: ${iconColor};"></i>
            <div class="editing-info">
                <span class="editing-label">Редактирование сообщения</span>
                <span class="editing-preview-text">${escapeHtml(previewText)}</span>
            </div>
        </div>
        <button class="cancel-editing-btn" onclick="window.cancelEditing()">
            <i class="fas fa-times"></i>
        </button>
    `;

        // Вставляем перед .input-wrapper
        const inputWrapper = document.querySelector('.input-wrapper');
        if (inputWrapper && inputWrapper.parentElement) {
            inputWrapper.parentElement.insertBefore(editingIndicator, inputWrapper);
        } else {
            const inputArea = document.querySelector('.input-area');
            if (inputArea) inputArea.insertBefore(editingIndicator, inputArea.firstChild);
        }
    }

    function cancelEditing() {
        if (!editingMessageData) return;

        editingMessageData = null;

        if (editingIndicator) {
            editingIndicator.remove();
            editingIndicator = null;
        }

        const input = document.getElementById('messageInput') as HTMLTextAreaElement;
        if (input) {
            input.value = '';
            autoResizeTextarea();
        }

        // Убираем подсветку
        document.querySelectorAll('.message-editing-highlight').forEach(el => {
            el.classList.remove('message-editing-highlight');
        });

        showNotification('Редактирование отменено', 'info');
    }



    // ============ ОТПРАВКА СООБЩЕНИЙ ============

    async function sendMessage() {
        if (isSending) return;

        // Если есть файл в preview, отправляем через специальную функцию
        if (pendingFileBlob) {
            await sendFileMessage();
            return;
        }

        const input = document.getElementById('messageInput') as HTMLTextAreaElement | null;
        if (!input) return;

        let content = input.value;
        content = sanitizeInput(content);

        const fileInput = document.getElementById('fileInput') as HTMLInputElement | null;
        const selectedFile = fileInput?.files?.[0];
        const hasFile = !!selectedFile;
        const hasText = !!content;
        const hasReply = !!replyToMessageData;

        if (!hasText && !hasReply && !hasFile) return;

        if (!currentChannel) {
            showNotification('Выберите чат', 'warning');
            return;
        }

        // *** РЕДАКТИРОВАНИЕ СООБЩЕНИЯ ***
        // В функции sendMessage, секция редактирования:

        if (editingMessageData) {
            // Проверяем, что мы всё ещё в том же чате
            if (editingMessageData.channelId !== currentChannel || editingMessageData.channelType !== currentChannelType) {
                showNotification('Нельзя редактировать сообщение из другого чата. Редактирование отменено.', 'warning');
                cancelEditing();
                return;
            }

            try {
                const response = await fetch(`/api/messages/${editingMessageData.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: content })
                });

                if (response.ok) {
                    // НЕМЕДЛЕННО ОБНОВЛЯЕМ DOM
                    const msgDiv = document.getElementById(`msg-${editingMessageData.id}`);
                    if (msgDiv) {
                        let textDiv = msgDiv.querySelector('.message-text');

                        if (content && content.trim()) {
                            // Если есть текст - создаём или обновляем .message-text
                            if (textDiv) {
                                textDiv.innerHTML = formatText(content);
                            } else {
                                // Находим .message-bubble и вставляем текст перед файлом или реакциями
                                const bubble = msgDiv.querySelector('.message-bubble');
                                const replyDiv = msgDiv.querySelector('.message-reply');
                                const fileDiv = msgDiv.querySelector('.message-file');
                                const reactionsDiv = msgDiv.querySelector('.message-reactions');

                                const newTextDiv = document.createElement('div');
                                newTextDiv.className = 'message-text';
                                newTextDiv.innerHTML = formatText(content);

                                if (replyDiv && replyDiv.nextSibling) {
                                    bubble?.insertBefore(newTextDiv, replyDiv.nextSibling);
                                } else if (fileDiv) {
                                    bubble?.insertBefore(newTextDiv, fileDiv);
                                } else if (reactionsDiv) {
                                    bubble?.insertBefore(newTextDiv, reactionsDiv);
                                } else {
                                    bubble?.appendChild(newTextDiv);
                                }
                            }
                        } else {
                            // Если текст пустой - удаляем .message-text если он есть
                            if (textDiv && (!content || content.trim() === '')) {
                                textDiv.remove();
                            }
                        }

                        // Добавляем индикатор (ред.) в заголовок
                        const header = msgDiv.querySelector('.message-header');
                        if (header && !header.innerHTML.includes('(ред.)')) {
                            const timeSpan = header.querySelector('.message-time');
                            const editedSpan = document.createElement('span');
                            editedSpan.className = 'message-time';
                            editedSpan.textContent = '(ред.)';

                            if (timeSpan && timeSpan.nextSibling) {
                                header.insertBefore(editedSpan, timeSpan.nextSibling);
                            } else if (timeSpan) {
                                timeSpan.insertAdjacentElement('afterend', editedSpan);
                            } else {
                                header.appendChild(editedSpan);
                            }
                        }
                    }

                    cancelEditing();
                    const input = document.getElementById('messageInput') as HTMLTextAreaElement;
                    if (input) {
                        input.value = '';
                        autoResizeTextarea();
                        input.focus();
                    }
                    cancelReply();
                    showNotification('✅ Сообщение отредактировано', 'success');
                } else {
                    const error = await response.json();
                    showNotification(error.error || 'Ошибка редактирования', 'danger');
                }
            } catch (error) {
                showNotification('Ошибка при редактировании', 'danger');
            }
            return;
        }

        // ---------- НОВОЕ СООБЩЕНИЕ ----------
        isSending = true;
        const sendBtn = document.getElementById('sendButton') as HTMLButtonElement | null;
        if (sendBtn) sendBtn.disabled = true;

        const tempId = 'temp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
        const replyData = replyToMessageData
            ? { id: replyToMessageData.id, username: replyToMessageData.username, content: replyToMessageData.content }
            : null;

        // ---- ВРЕМЕННОЕ СООБЩЕНИЕ (показываем сразу, если есть текст или скоро будет файл) ----
        const messagesDiv = document.getElementById('messages-area');
        if (messagesDiv && messagesDiv.innerHTML.includes('Нет сообщений')) {
            messagesDiv.innerHTML = '';
        }

        // Если есть файл, используем его локальный blob для предпросмотра
        let blobUrl: string | null = null;
        if (hasFile && selectedFile) {
            blobUrl = URL.createObjectURL(selectedFile);
        }

        const tempMessage: any = {
            id: tempId,
            channelId: currentChannel,
            username: currentUsername,
            content: content,
            fileUrl: blobUrl,
            timestamp: new Date().toISOString(),
            reactions: [],
            readBy: [],
            deliveredTo: [],
            isTemp: true,
            edited: false,
            replyTo: replyToMessageData ? {
                id: replyToMessageData.id,
                username: replyToMessageData.username,
                content: replyToMessageData.content
            } : null
        };

        if (messagesDiv) {
            const existing = document.getElementById(`msg-${tempId}`);
            if (!existing) {
                messagesDiv.insertAdjacentHTML('beforeend',
                    formatMessage(tempMessage));
                scrollToBottomSafely(false);
            }
        }

        let messageElement = document.getElementById(`msg-${tempId}`);

        try {
                await connection.invoke('SendMessage', {
                    tempId: tempId,
                    channelId: currentChannel,
                    content: content,
                    fileUrl: null,
                    replyTo: replyData
                });

            input.value = '';
            autoResizeTextarea();
            input.focus();
            cancelReply();

            const pastePreview = document.getElementById('pastePreview');
            if (pastePreview) pastePreview.style.display = 'none';

        } catch (err) {
            console.error('[sendMessage] Error:', err);
            const errorMessage = err instanceof Error ? err.message : 'Ошибка отправки';
            showNotification(errorMessage || 'Ошибка отправки', 'danger');
            if (messageElement) messageElement.remove();
        } finally {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            if (sendBtn) {
                setTimeout(() => {
                    sendBtn.disabled = false;
                    isSending = false;
                }, 500);
            } else {
                isSending = false;
            }
        }
    }

    function editMessage(mid: string) {
        // Сначала проверяем, есть ли уже активное редактирование
        if (editingMessageData) {
            if (editingMessageData.id === mid) {
                // То же сообщение - просто фокусируемся
                const input = document.getElementById('messageInput') as HTMLTextAreaElement;
                if (input) input.focus();
                return;
            }
            // Разное сообщение - отменяем текущее
            cancelEditing();
        }

        const msgDiv = document.getElementById(`msg-${mid}`);
        if (!msgDiv) {
            showNotification('Сообщение не найдено', 'danger');
            return;
        }

        // Получаем канал сообщения из атрибутов
        const msgChannelId = msgDiv.getAttribute('data-channel-id');
        const msgChannelType = msgDiv.getAttribute('data-channel-type');

        // Проверяем, что сообщение из текущего чата
        if (msgChannelId !== currentChannel || msgChannelType !== currentChannelType) {
            showNotification('Нельзя редактировать сообщение из другого чата', 'warning');
            return;
        }

        // Ищем текстовое содержимое сообщения
        const textDiv = msgDiv.querySelector('.message-text');
        let plainText = '';

        if (textDiv) {
            // Если есть текст, извлекаем его
            let htmlContent = textDiv.innerHTML;
            plainText = htmlContent.replace(/<br\s*\/?>/gi, '\n');
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = plainText;
            plainText = tempDiv.textContent || tempDiv.innerText || '';
            const textarea = document.createElement('textarea');
            textarea.innerHTML = plainText;
            plainText = textarea.value;
        } else {
            // Если текста нет, но есть файл - будем добавлять текст к существующему файлу
            // plainText остаётся пустым - пользователь сможет добавить текст
            plainText = '';
        }

        // Сохраняем данные редактирования
        editingMessageData = {
            id: mid,
            channelId: currentChannel!,
            channelType: currentChannelType,
            content: plainText
        };

        // Заполняем поле ввода
        const inp = document.getElementById('messageInput') as HTMLTextAreaElement;
        if (inp) {
            inp.value = plainText;
            inp.focus();
            inp.selectionStart = inp.selectionEnd = inp.value.length;
            autoResizeTextarea();
        }

        // Показываем зеленую плашку (показываем информацию о сообщении)
        const displayText = plainText || (msgDiv.querySelector('.message-file') ? '💬 Добавить текст к файлу' : '✏️ Редактирование');
        showEditingIndicator(plainText || displayText);

        // Подсвечиваем редактируемое сообщение
        document.querySelectorAll('.message-editing-highlight').forEach(el => el.classList.remove('message-editing-highlight'));
        msgDiv.classList.add('message-editing-highlight');
        msgDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });

        showNotification('✏️ Редактирование... Enter – сохранить, Esc – отмена', 'info');
    }

    async function deleteMessage(mid: string) {
        if (confirm('Удалить сообщение?')) {
            await fetch(`/api/messages/${mid}`, { method: 'DELETE' });
            messageStatuses.delete(mid);
        }
    }

    function replyToMessage(messageId: string, username: string, contentText: string) {
        let safeContent = contentText;
        if (typeof contentText === 'string') {
            safeContent = contentText.replace(/\\'/g, "'").replace(/\\"/g, '"');
        }
        replyToMessageData = { id: messageId, username: username, content: safeContent || '📎 Файл' };

        const previewDiv = document.getElementById('replyPreview');
        const replyToNameSpan = document.querySelector('#replyPreview .reply-to-name');
        const replyTextSpan = document.querySelector('#replyPreview .reply-text');

        if (replyToNameSpan) replyToNameSpan.textContent = username;
        if (replyTextSpan) {
            const previewText = safeContent ? (safeContent.length > 60 ? safeContent.substring(0, 57) + '...' : safeContent) : 'Файл';
            replyTextSpan.textContent = previewText;
        }
        if (previewDiv) previewDiv.style.display = 'flex';

        const targetMessage = document.getElementById(`msg-${messageId}`);
        if (targetMessage) {
            document.querySelectorAll('.message-reply-highlight').forEach(el => el.classList.remove('message-reply-highlight'));
            targetMessage.classList.add('message-reply-highlight');
            targetMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => targetMessage.classList.remove('message-reply-highlight'), 2000);
        }
        const input = document.getElementById('messageInput') as HTMLTextAreaElement | null;
        if (input) input.focus();
    }

    function cancelReply() {
        replyToMessageData = null;
        const replyPreview = document.getElementById('replyPreview');
        if (replyPreview) replyPreview.style.display = 'none';
        document.querySelectorAll('.message-reply-highlight').forEach(el => el.classList.remove('message-reply-highlight'));
    }

    function openMediaModal(mediaUrl: string, type: 'image' | 'video') {
        const overlay = document.createElement('div');
        overlay.className = 'image-modal-overlay';
        overlay.onclick = () => overlay.remove();

        const content = document.createElement('div');
        content.className = 'image-modal-content';
        content.onclick = e => e.stopPropagation();

        let mediaElement: HTMLElement;

        if (type === 'image') {
            const img = document.createElement('img');
            img.src = mediaUrl;
            img.style.maxWidth = '100%';
            img.style.maxHeight = '90vh';
            img.style.objectFit = 'contain';
            img.style.borderRadius = '8px';
            mediaElement = img;
        } else {
            const video = document.createElement('video');
            video.src = mediaUrl;
            video.controls = true;
            video.autoplay = true;
            video.style.maxWidth = '100%';
            video.style.maxHeight = '90vh';
            video.style.borderRadius = '8px';
            video.style.backgroundColor = '#000';
            mediaElement = video;
        }

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = '&times;';
        closeBtn.className = 'close-modal-btn';
        closeBtn.onclick = () => overlay.remove();

        content.appendChild(mediaElement);
        overlay.appendChild(closeBtn);
        overlay.appendChild(content);
        document.body.appendChild(overlay);

        // Если это видео, убедимся что оно воспроизводится
        if (type === 'video') {
            const videoEl = mediaElement as HTMLVideoElement;
            videoEl.play().catch(e => console.log('Autoplay prevented:', e));
        }
    }

    // Оставляем старую функцию для обратной совместимости
    function openImageModal(imageUrl: string) {
        openMediaModal(imageUrl, 'image');
    }

    function scrollToMessage(messageId: string) {
        const el = document.getElementById(`msg-${messageId}`);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.style.backgroundColor = '#fff3cd';
            setTimeout(() => el.style.backgroundColor = '', 2000);
        }
    }

    function toggleMessageActions(messageId: string) {
        const actionsDiv = document.getElementById(`actions-${messageId}`);
        if (actionsDiv) {
            // Закрываем другие открытые меню
            if (currentlyActiveMessageActions && currentlyActiveMessageActions !== actionsDiv) {
                currentlyActiveMessageActions.classList.remove('show');
            }
            actionsDiv.classList.toggle('show');
            currentlyActiveMessageActions = actionsDiv.classList.contains('show') ? actionsDiv : null;
        }
    }

    function closeAllMessageActions() {
        if (currentlyActiveMessageActions) {
            currentlyActiveMessageActions.classList.remove('show');
            currentlyActiveMessageActions = null;
        }
    }

    async function addReaction(mid: string, emoji: string) {
        await connection.invoke('AddReaction', mid, emoji);
    }

    function showReactionPanel(mid: string, ev: MouseEvent) {
        ev.stopPropagation();
        if (activeReactionPanel) { activeReactionPanel.remove(); activeReactionPanel = null; }
        const msgDiv = document.getElementById(`msg-${mid}`);
        if (!msgDiv) return;

        // Быстрые реакции
        const quickReactions = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👎'];

        // Создаем панель
        const panel = document.createElement('div');
        panel.className = 'reaction-panel';

        // Генерируем HTML для быстрых реакций
        let html = quickReactions.map(r =>
            `<span class="reaction-option" data-emoji="${escapeHtml(r)}">${escapeHtml(r)}</span>`
        ).join('');

        // Добавляем кнопку "Еще" или "+"
        html += `<span class="reaction-option reaction-more-btn" data-action="more">➕</span>`;

        panel.innerHTML = html;

        const bubble = msgDiv.querySelector('.message-bubble');
        if (bubble) {
            const rect = bubble.getBoundingClientRect();
            panel.style.position = 'fixed';
            // Позиционирование над сообщением
            panel.style.bottom = `${window.innerHeight - rect.top + 10}px`;
            panel.style.left = `${Math.min(rect.left + 20, window.innerWidth - 250)}px`;

            if (msgDiv.classList.contains('message-own')) {
                panel.style.left = 'auto';
                panel.style.right = `${Math.min(window.innerWidth - rect.right + 20, window.innerWidth - 250)}px`;
            }
        }

        document.body.appendChild(panel);
        activeReactionPanel = panel;

        // Обработчики для быстрых реакций
        panel.querySelectorAll('.reaction-option').forEach(btn => {
            const htmlBtn = btn as HTMLElement;
            htmlBtn.onclick = (e) => {
                e.stopPropagation();
                const action = htmlBtn.getAttribute('data-action');
                const em = htmlBtn.getAttribute('data-emoji');

                if (action === 'more') {
                    // Открываем полный пикер
                    closeReactionPanel(); // Закрываем маленькую панель
                    showFullReactionPicker(mid, e); // Открываем большую
                } else if (em) {
                    addReaction(mid, em);
                    closeReactionPanel();
                }
            };
        });

        // Закрытие при клике вне
        setTimeout(() => {
            const closePanel = (e: MouseEvent) => {
                if (panel && !panel.contains(e.target as Node)) {
                    closeReactionPanel();
                    document.removeEventListener('click', closePanel as any);
                }
            };
            document.addEventListener('click', closePanel as any);
        }, 0);
    }

    // Новая функция для полного выбора реакций
    function showFullReactionPicker(mid: string, ev: MouseEvent) {
        ev.stopPropagation();

        // Удаляем старую панель, если есть
        if (activeReactionPanel) { activeReactionPanel.remove(); activeReactionPanel = null; }

        const msgDiv = document.getElementById(`msg-${mid}`);
        if (!msgDiv) return;

        const panel = document.createElement('div');
        panel.className = 'reaction-panel full-reaction-picker';

        // Используем те же категории, что и в emoji picker, или упрощенный список
        // Для простоты возьмем объединенный список популярных эмодзи
        const allEmojis = [
            '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕', '🤑', '🤠', '😈', '👿', '👹', '👺', '🤡', '💩', '👻', '💀', '☠️', '👽', '👾', '🤖', '🎃',
            '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝',
            '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👊', '✊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '💪',
            '⭐', '🌟', '✨', '⚡', '🔥', '💧', '❄️', '☀️', '🌈', '☁️', '⛅', '🌤️', '🌥️', '🌦️', '🌧️', '🌨️', '🌩️', '🌪️', '🌫️', '🌬️', '🌀', '🌊', '💨', '💫', '💥', '💢', '💦', '💤', '🎉', '🎊', '🎈', '🎁', '🎀', '🎄', '🎃', '🎆', '🎇'
        ];

        let html = '<div class="full-reaction-grid">';
        allEmojis.forEach(emoji => {
            html += `<span class="reaction-option full-emoji-item" data-emoji="${escapeHtml(emoji)}">${escapeHtml(emoji)}</span>`;
        });
        html += '</div>';

        panel.innerHTML = html;

        // Позиционирование
        const bubble = msgDiv.querySelector('.message-bubble');
        if (bubble) {
            const rect = bubble.getBoundingClientRect();
            panel.style.position = 'fixed';
            // Центрируем относительно сообщения или экрана, если не влезает
            let top = rect.top - 200; // Показываем выше сообщения
            if (top < 10) top = rect.bottom + 10; // Или ниже, если сверху нет места

            panel.style.top = `${top}px`;

            let left = rect.left;
            if (left + 300 > window.innerWidth) {
                left = window.innerWidth - 320;
            }
            panel.style.left = `${left}px`;
        }

        document.body.appendChild(panel);
        activeReactionPanel = panel;

        // Обработчики кликов по эмодзи
        panel.querySelectorAll('.full-emoji-item').forEach(btn => {
            const htmlBtn = btn as HTMLElement;
            htmlBtn.onclick = (e) => {
                e.stopPropagation();
                const em = htmlBtn.getAttribute('data-emoji');
                if (em) {
                    addReaction(mid, em);
                    closeReactionPanel();
                }
            };
        });

        // Закрытие при клике вне
        setTimeout(() => {
            const closePanel = (e: MouseEvent) => {
                if (panel && !panel.contains(e.target as Node)) {
                    closeReactionPanel();
                    document.removeEventListener('click', closePanel as any);
                }
            };
            document.addEventListener('click', closePanel as any);
        }, 0);
    }

    function closeReactionPanel() {
        if (activeReactionPanel) {
            activeReactionPanel.remove();
            activeReactionPanel = null;
        }
    }

    // ============ НЕПРОЧИТАННЫЕ ============

    async function getUsersCached(): Promise<User[]> {
        const now = Date.now();
        if (usersCache && usersCacheTime && (now - usersCacheTime) < USERS_CACHE_TTL) return usersCache;
        try {
            const res = await fetch('/api/users');
            usersCache = await res.json();
            usersCacheTime = now;
            return usersCache;
        } catch (e) {
            console.error(e);
            return usersCache || [];
        }
    }

    function updateChannelUnreadCount(channelId: string, newCount: number, isDM: boolean) {
        unreadCounts[channelId] = newCount;
        const selector = isDM ? `.dm-item[data-dm-id="${channelId}"]` : `.channel-item[data-channel-id="${channelId}"]`;
        const element = document.querySelector(selector);
        if (element) {
            const nameContainer = element.querySelector('.channel-name, .dm-name');
            if (nameContainer) {
                const oldBadge = nameContainer.querySelector('.unread-badge');
                if (oldBadge) oldBadge.remove();
                if (newCount > 0) {
                    const badge = document.createElement('span');
                    badge.className = 'unread-badge';
                    badge.textContent = newCount > 99 ? '99+' : newCount.toString();
                    nameContainer.appendChild(badge);
                }
            }
        }

        let total = 0;
        for (const cnt of Object.values(unreadCounts)) {
            total += cnt;
        }
        currentTotalUnread = total;
        updateDocumentTitle();
    }

    async function markChannelMessagesRead(channelId: string) {
        if (!channelId) return;
        try {
            await fetch(`/api/unread/${channelId}/read`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
            await forceRefreshUnreadCounts();
            await connection.invoke('MarkChannelRead', channelId);
        } catch (e) { console.error(e); }
    }

    async function forceRefreshUnreadCounts() {
        try {
            const res = await fetch('/api/unread');
            const allUnreadCounts = await res.json();

            const [channels, dmChannels] = await Promise.all([
                fetch('/api/channels').then(r => r.json()),
                fetch('/api/dm_channels').then(r => r.json())
            ]);

            const userChannelIds = new Set<string>();

            channels.forEach((ch: Channel) => {
                if (!ch.isPrivate) {
                    userChannelIds.add(ch.id);
                } else {
                    userChannelIds.add(ch.id);
                }
            });

            dmChannels.forEach((dm: DMChannel) => {
                userChannelIds.add(dm.id);
            });

            const filteredUnreadCounts: UnreadCounts = {};
            for (const [channelId, count] of Object.entries(allUnreadCounts)) {
                if (userChannelIds.has(channelId)) {
                    // Приводим count к number
                    filteredUnreadCounts[channelId] = count as number;
                }
            }

            unreadCounts = filteredUnreadCounts;
            updateAllUnreadBadges();
        } catch (e) {
            console.error('Error refreshing unread counts:', e);
        }
    }

    function updateAllUnreadBadges() {
        document.querySelectorAll('.channel-item').forEach(el => {
            const chId = el.getAttribute('data-channel-id');
            if (!chId) return;
            const cnt = unreadCounts[chId] || 0;
            const nameContainer = el.querySelector('.channel-name');
            if (nameContainer) {
                const oldBadge = nameContainer.querySelector('.unread-badge');
                if (oldBadge) oldBadge.remove();
                if (cnt > 0) {
                    const badge = document.createElement('span');
                    badge.className = 'unread-badge';
                    badge.textContent = cnt > 99 ? '99+' : cnt.toString();
                    nameContainer.appendChild(badge);
                }
            }
        });
        document.querySelectorAll('.dm-item').forEach(el => {
            const dmId = el.getAttribute('data-dm-id');
            if (!dmId) return;
            const cnt = unreadCounts[dmId] || 0;
            const nameContainer = el.querySelector('.dm-name');
            if (nameContainer) {
                const oldBadge = nameContainer.querySelector('.unread-badge');
                if (oldBadge) oldBadge.remove();
                if (cnt > 0) {
                    const badge = document.createElement('span');
                    badge.className = 'unread-badge';
                    badge.textContent = cnt > 99 ? '99+' : cnt.toString();
                    nameContainer.appendChild(badge);
                }
            }
        });
        updateTotalUnreadFromServer();
    }

    async function updateTotalUnreadFromServer() {
        try {
            let total = 0;
            const res = await fetch('/api/unread');
            const allUnreadData = await res.json();

            const [channels, dmChannels] = await Promise.all([
                fetch('/api/channels').then(r => r.json()),
                fetch('/api/dm_channels').then(r => r.json())
            ]);

            const userChannelIds = new Set<string>();
            channels.forEach((ch: Channel) => { userChannelIds.add(ch.id); });
            dmChannels.forEach((dm: DMChannel) => { userChannelIds.add(dm.id); });

            for (const [channelId, count] of Object.entries(allUnreadData)) {
                if (userChannelIds.has(channelId) && typeof count === 'number') {
                    total += count;
                }
            }

            currentTotalUnread = total; // сохраняем глобально
            updateDocumentTitle();      // обновляем заголовок
        } catch (e) {
            console.error('Failed to update unread total:', e);
        }
    }

    function updateLoadMoreIndicator() {
        const messagesDiv = document.getElementById('messages-area');
        if (!messagesDiv) return;

        const oldIndicator = document.getElementById('loadMoreIndicator');
        if (oldIndicator) oldIndicator.remove();

        if (hasMoreMessages) {
            const indicator = document.createElement('div');
            indicator.id = 'loadMoreIndicator';
            indicator.className = 'text-center text-muted py-2 load-more-indicator';
            indicator.innerHTML = '<i class="fas fa-arrow-up"></i> Прокрутите вверх для загрузки старых сообщений';
            indicator.style.cursor = 'pointer';
            indicator.onclick = () => loadMoreMessages();

            const firstChild = messagesDiv.firstChild;
            if (firstChild) {
                messagesDiv.insertBefore(indicator, firstChild);
            } else {
                messagesDiv.appendChild(indicator);
            }
        }
    }

    async function loadMoreMessages() {
        if (isLoadingMore || !hasMoreMessages || !currentChannel) return;

        isLoadingMore = true;
        currentPage++;

        const indicator = document.getElementById('loadMoreIndicator');
        if (indicator) {
            indicator.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Загрузка старых сообщений...';
        }

        await loadMessages(currentChannel, false);

        isLoadingMore = false;
        updateLoadMoreIndicator();
        setTimeout(() => updateScrollButtonsVisibility(), 100);
    }

    function markVisibleMessagesAsRead() {
        if (!currentChannel) return;
        const messagesDiv = document.getElementById('messages-area');
        if (!messagesDiv) return;

        // Выбираем только сообщения, которые НЕ являются нашими (message-own)
        // И которые еще не были отмечены как прочитанные нами (хотя для своих это не применимо, но для чужих важно)
        const messages = messagesDiv.querySelectorAll('.message:not(.message-own)');

        messages.forEach(msgDiv => {
            if (isElementInViewport(msgDiv as HTMLElement)) {
                const msgId = msgDiv.id.replace('msg-', '');
                // Проверяем, не прочитано ли уже
                if (!isMessageReadByMe(msgId)) {
                    markSingleMessageRead(msgId);
                }
            }
        });
    }

    function isElementInViewport(el: HTMLElement) {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const container = document.getElementById('messages-area');
        if (!container) return false;
        const containerRect = container.getBoundingClientRect();
        return rect.top >= containerRect.top && rect.bottom <= containerRect.bottom;
    }

    function isMessageReadByMe(messageId: string) {
        const readByList = messageReadBy.get(messageId) || [];
        return readByList.includes(currentUsername);
    }

    async function markSingleMessageRead(messageId: string) {
        if (isMessageReadByMe(messageId)) return;
        try {
            const response = await fetch(`/api/messages/${messageId}/read`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            });
            const data = await response.json();

            if (data.success !== false) {
                let readByList = messageReadBy.get(messageId) || [];
                if (!readByList.includes(currentUsername)) {
                    readByList.push(currentUsername);
                    messageReadBy.set(messageId, readByList);
                }

                updateMessageStatus(messageId, MESSAGE_STATUS.READ);
                updateReadByDisplay(messageId);

                const msgDiv = document.getElementById(`msg-${messageId}`);
                if (msgDiv && currentChannelType === 'channel') {
                    const readCounter = msgDiv.querySelector('.read-counter') as HTMLElement | null;
                    if (readCounter) {
                        const readByList = messageReadBy.get(messageId) || [];
                        const otherReaders = readByList.filter(u => u !== currentUsername);
                        const readCount = otherReaders.length;
                        if (readCount > 0) {
                            readCounter.innerHTML = `<i class="fas fa-eye"></i> ${readCount}`;
                            readCounter.style.display = 'inline-flex';
                        } else {
                            readCounter.style.display = 'none';
                        }
                    }
                }

                if (currentChannel) { // Эта проверка сужает тип до string (если currentChannel был string | null)
                    const cur = unreadCounts[currentChannel] || 0;
                    if (cur > 0) {
                        updateChannelUnreadCount(currentChannel, cur - 1, currentChannelType === 'dm');
                    }
                }
            }
        } catch (e) {
            console.error('Error marking message as read:', e);
        }
    }

    // ============ ЗАГРУЗКА КАНАЛОВ И ПОЛЬЗОВАТЕЛЕЙ ============

    async function loadChannels(force?: boolean) {
        const now = Date.now();
        if (!force && channelsCache && channelsCacheTime && (now - channelsCacheTime) < CHANNELS_CACHE_TTL) {
            renderChannels(channelsCache);
            return;
        }
        try {
            const res = await fetch('/api/channels');
            const channels = await res.json();
            channelsCache = channels;
            channelsCacheTime = now;
            renderChannels(channels);
            attachChannelTooltips();
        } catch (e) {
            console.error(e);
        }
    }


    function renderChannels(channels: Channel[]) {
        const div = document.getElementById('channels-list');
        if (!channels || channels.length === 0) {
            if (div) div.innerHTML = '<div class="text-center text-muted py-3">Нет каналов</div>';
            return;
        }
        let html = '';
        for (const ch of channels) {
            const active = currentChannel === ch.id && currentChannelType === 'channel';
            const unread = unreadCounts[ch.id] || 0;
            channelNamesCache.set(ch.id, ch.name);
            const description = ch.description || '';
            const escapedDesc = escapeHtml(description);
            const escapedName = escapeHtml(ch.name);
            const escapedId = escapeHtml(ch.id);

            // Убираем onclick из HTML - он будет обрабатываться делегированным обработчиком
            html += `<div class="channel-item ${active ? 'active' : ''}" data-channel-id="${escapedId}" data-channel-name="${escapedName}" data-channel-desc="${escapedDesc}">
            <div class="channel-info">
                <div class="channel-name">
                    <i class="fas fa-hashtag"></i> ${escapedName}${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
                </div>
                <div class="channel-description"></div>
            </div>
        </div>`;
        }
        if (div) div.innerHTML = html;

        // Добавляем обработчики для всплывающих подсказок
        attachChannelTooltips();
    }

    // Переменные для управления всплывающей подсказкой
    let currentTooltip: HTMLElement | null = null;
    let tooltipTimeout: number | null = null;

    function attachChannelTooltips() {
        const channelItems = document.querySelectorAll('.channel-item');

        channelItems.forEach(item => {
            // Удаляем старые обработчики, если есть
            item.removeEventListener('mouseenter', handleChannelMouseEnter as any);
            item.removeEventListener('mouseleave', handleChannelMouseLeave as any);

            // Добавляем новые обработчики
            item.addEventListener('mouseenter', handleChannelMouseEnter as any);
            item.addEventListener('mouseleave', handleChannelMouseLeave as any);
        });
    }

    function attachReadCounterHandlers() {
        const readCounters = document.querySelectorAll('.read-counter');
        console.log(`Attaching handlers to ${readCounters.length} read counters`);

        readCounters.forEach(counter => {
            // Удаляем старый обработчик, если есть
            counter.removeEventListener('click', handleReadCounterClick);
            // Добавляем новый
            counter.addEventListener('click', handleReadCounterClick);
        });
    }

    function handleReadCounterClick(e: Event) {
        e.preventDefault();
        e.stopPropagation();
        const msgId = (e.currentTarget as HTMLElement).getAttribute('data-msg-id');
        console.log('Read counter clicked, msgId:', msgId);
        if (msgId) {
            showReadByList(msgId);
        }
    }

    function handleChannelMouseEnter(e: any) {
        const target = e.currentTarget as HTMLElement;
        const channelDesc = target.getAttribute('data-channel-desc') || '';

        // Очищаем предыдущий таймер
        if (tooltipTimeout) {
            clearTimeout(tooltipTimeout);
        }

        // Удаляем существующую подсказку
        removeTooltip();

        // Задержка перед показом (300мс)
        tooltipTimeout = window.setTimeout(() => {
            showTooltip(channelDesc, e.clientX, e.clientY);
        }, 300);
    }

    function handleChannelMouseLeave() {
        // Очищаем таймер
        if (tooltipTimeout) {
            clearTimeout(tooltipTimeout);
            tooltipTimeout = null;
        }

        // Задержка перед скрытием (200мс)
        setTimeout(() => {
            removeTooltip();
        }, 200);
    }

    function showTooltip(description: string, mouseX: number, mouseY: number) {
        // Удаляем старую подсказку
        removeTooltip();

        // Создаём подсказку
        const tooltip = document.createElement('div');
        tooltip.className = 'channel-tooltip';

        const hasDescription = description && description.trim().length > 0;

        if (hasDescription) {
            tooltip.innerHTML = `
            <div style="font-size: 11px; opacity: 0.9;">${escapeHtml(description)}</div>
        `;
        } else {
            tooltip.classList.add('no-description');
            tooltip.innerHTML = `
            <div style="font-size: 11px; opacity: 0.7; font-style: italic;">Нет описания</div>
        `;
        }

        document.body.appendChild(tooltip);
        currentTooltip = tooltip;

        // Позиционируем подсказку
        const rect = tooltip.getBoundingClientRect();
        let left = mouseX + 15;
        let top = mouseY - 10;

        // Проверяем выход за правый край экрана
        if (left + rect.width > window.innerWidth - 10) {
            left = mouseX - rect.width - 15;
        }

        // Проверяем выход за верхний край
        if (top < 10) {
            top = mouseY + 20;
            // Меняем положение стрелки, если подсказка снизу
            tooltip.style.transform = 'none';
            tooltip.style.setProperty('--arrow-position', 'bottom');
        } else {
            tooltip.style.setProperty('--arrow-position', 'top');
        }

        // Проверяем выход за нижний край
        if (top + rect.height > window.innerHeight - 10) {
            top = window.innerHeight - rect.height - 10;
        }

        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
    }

    function removeTooltip() {
        if (currentTooltip) {
            currentTooltip.remove();
            currentTooltip = null;
        }
    }

    async function loadDMChannels() {
    try {
        const res = await fetch('/api/dm_channels');
        const dms = await res.json() as DMChannel[];
        const div = document.getElementById('dm-list');
        if (!dms || dms.length === 0) {
            if (div) div.innerHTML = '<div class="text-center text-muted py-3">Нет личных чатов</div>';
            return;
        }
        if (div) {
            div.innerHTML = dms.map((dm: DMChannel) => {
                const active = currentChannel === dm.id && currentChannelType === 'dm';
                const unread = unreadCounts[dm.id] || 0;
                const displayName = dm.isDeleted ? DELETED_USER_DISPLAY : dm.name;
                const escapedId = escapeHtml(dm.id);
                const escapedName = escapeHtml(displayName);
                
                // Убираем onclick из HTML
                return `<div class="dm-item ${active ? 'active' : ''}" data-dm-id="${escapedId}" data-dm-name="${escapedName}">
                    <div class="dm-info">
                        <div class="dm-name"><i class="fas fa-user"></i> ${escapedName}${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}</div>
                    </div>
                    <div class="dm-actions"><button class="action-btn delete-btn" data-dm-id="${escapedId}" data-dm-name="${escapedName}"><i class="fas fa-trash"></i></button></div>
                </div>`;
            }).join('');
            
            // Привязываем обработчики для кнопок удаления
            attachDMDeleteHandlers();
        }
    } catch (e) {
        console.error(e);
    }
}

function attachDMDeleteHandlers() {
    const deleteButtons = document.querySelectorAll('.dm-actions .delete-btn');
    deleteButtons.forEach(btn => {
        btn.removeEventListener('click', handleDMDelete);
        btn.addEventListener('click', handleDMDelete);
    });
}

function handleDMDelete(e: Event) {
    e.stopPropagation();
    const btn = e.currentTarget as HTMLElement;
    const dmId = btn.getAttribute('data-dm-id');
    const dmName = btn.getAttribute('data-dm-name');
    if (dmId && dmName) {
        deleteDMChannel(dmId, dmName);
    }
}

    async function loadUsersWithStatus() {
        try {
            const users = await getUsersCached();
            const others = users.filter(u => u.username !== currentUsername);
            const div = document.getElementById('users-list');
            if (others.length === 0) { if (div) div.innerHTML = '<div class="text-center text-muted py-3">Нет других пользователей</div>'; return; }
            let html = '';

            // СОРТИРОВКА ПОЛЬЗОВАТЕЛЕЙ
            const sortedUsers = [...others].sort((a, b) => {
                // Сначала определяем "вес" статуса для сортировки
                const getStatusWeight = (status: string) => {
                    switch (status) {
                        case 'online': return 3;
                        case 'away': return 2;
                        default: return 1;
                    }
                };

                const weightA = getStatusWeight(a.status);
                const weightB = getStatusWeight(b.status);

                // Если статусы разные - сортируем по статусу
                if (weightA !== weightB) {
                    return weightB - weightA; // Выше тот, у кого больше вес
                }

                // Если статусы одинаковые (оба offline или оба away) - сортируем по времени lastSeen
                if (a.status === 'offline' && b.status === 'offline') {
                    const timeA = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
                    const timeB = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
                    return timeB - timeA; // Более недавние выше
                }

                if (a.status === 'away' && b.status === 'away') {
                    const timeA = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
                    const timeB = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
                    return timeB - timeA;
                }

                // Для online можно сортировать по имени (опционально)
                if (a.status === 'online' && b.status === 'online') {
                    return a.username.localeCompare(b.username);
                }

                return 0;
            });

            for (const u of sortedUsers) {
                const statusClass = u.status === 'online' ? 'status-online' : (u.status === 'away' ? 'status-away' : 'status-offline');
                const statusText = u.status === 'online' ? 'онлайн' : (u.status === 'away' ? 'отошел' : formatLastSeen(u.lastSeen));

                const displayName = `${escapeHtml(u.username)} <span style="font-size: 0.7rem; color: #6c757d;">(${escapeHtml(statusText)})</span>`;

                html += `<div class="user-item">
                <div class="user-info" onclick="startDMWithUser('${escapeHtml(u.username)}')">
                    <div class="user-status ${statusClass}"></div>
                    <div><strong>${displayName}</strong>${u.role === 'admin' ? '<i class="fas fa-crown text-warning ms-1"></i>' : ''}</div>
                </div>
                <button class="chat-user-btn" onclick="event.stopPropagation(); startDMWithUser('${escapeHtml(u.username)}')"><i class="fas fa-comment"></i></button>
            </div>`;
            }
            if (div) div.innerHTML = html;
        } catch (e) { console.error(e); }
    }

    function formatLastSeen(ls: string | undefined): string {
        if (!ls) return 'давно';
        const diff = Math.floor((Date.now() - new Date(ls).getTime()) / 60000);
        if (diff < 1) return 'только что';
        if (diff < 5) return `${diff} мин. назад`;
        if (diff < 60) return `${diff} мин. назад`;
        if (diff < 1440) { let h = Math.floor(diff / 60); return `${h} ч. назад`; }
        let d = Math.floor(diff / 1440);
        return `${d} д. назад`;
    }

    async function startDMWithUser(username: string) {
        if (username === currentUsername) { showNotification('Нельзя создать чат с самим собой', 'warning'); return; }
        try {
            const res = await fetch('/api/dm_channels',
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ otherUser: username }) });
            const data = await res.json();
            if (res.ok) {
                await loadDMChannels();
                await joinChannel('dm', data.id, username, '');
            }
            else if (res.status === 409 && data.dmId) {
                await loadDMChannels();
                await joinChannel('dm', data.dmId, username, '');
            }
            else showNotification(data.error || 'Ошибка', 'danger');
        } catch (e) {
            console.error(e);
            showNotification('Ошибка', 'danger');
        }
    }

    async function deleteDMChannel(dmId: string, username: string) {
        if (confirm(`Удалить чат с ${username}?`)) {
            try {
                const res = await fetch(`/api/dm_channels/${dmId}`, { method: 'DELETE' });
                if (res.ok) {
                    if (currentChannel === dmId && currentChannelType === 'dm') {
                        currentChannel = null;
                        const messagesArea = document.getElementById('messages-area');
                        const currentChannelNameEl = document.getElementById('current-channel-name');
                        const messageInput = document.getElementById('messageInput') as HTMLInputElement | null;
                        if (messagesArea) messagesArea.innerHTML = '<div class="text-center text-muted mt-5">Выберите чат слева</div>';
                        if (currentChannelNameEl) currentChannelNameEl.textContent = 'Выберите чат';
                        if (messageInput) messageInput.disabled = true;
                    }
                    await loadDMChannels();
                }
            } catch (e) {
                console.error(e);
                showNotification('Ошибка', 'danger');
            }
        }
    }

    async function deleteChannel(chId: string, chName: string) {
        if (confirm(`Удалить канал "${chName}"?`)) {
            try {
                const res = await fetch(`/api/channels/${chId}`, { method: 'DELETE' });
                if (res.ok) {
                    if (currentChannel === chId && currentChannelType === 'channel') {
                        currentChannel = null;
                        const messagesArea = document.getElementById('messages-area');
                        const currentChannelNameEl = document.getElementById('current-channel-name');
                        const messageInput = document.getElementById('messageInput') as HTMLInputElement | null;
                        if (messagesArea) messagesArea.innerHTML = '<div class="text-center text-muted mt-5">Выберите чат слева</div>';
                        if (currentChannelNameEl) currentChannelNameEl.textContent = 'Выберите чат';
                        if (messageInput) messageInput.disabled = true;
                    }
                    await loadChannels(true);
                }
            } catch (e) {
                console.error(e);
                showNotification('Ошибка', 'danger');
            }
        }
    }

    function showCreateChannelModal() {
        const name = prompt('Название канала:');
        if (name && name.trim()) {
            const desc = prompt('Описание:');
            fetch('/api/channels', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), description: desc || '', isPrivate: false })
            }).then(async () => await loadChannels(true));
        }
    }

    function openChannelSettings() {
        if (!currentChannel || currentChannelType !== 'channel') {
            return;
        }
        window.location.href = `/channel_settings.html?id=${currentChannel}`;
    }

    async function fetchServerTimeSignalR() {
        const span = document.getElementById('signalrServerTime');
        if (!span) return;

        if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
            span.textContent = '--:--:--';
            span.style.color = '#ffc107';
            updateTitleWithTimeStatus(); // вызываем сразу
            return;
        }

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('SignalR invoke timeout')), 5000);
        });

        try {
            const timeStr = await Promise.race([
                connection.invoke('GetServerTime'),
                timeoutPromise
            ]);
            const serverDate = new Date(timeStr);
            if (!isNaN(serverDate.getTime())) {
                const hours = serverDate.getHours().toString().padStart(2, '0');
                const minutes = serverDate.getMinutes().toString().padStart(2, '0');
                const seconds = serverDate.getSeconds().toString().padStart(2, '0');
                span.textContent = `${hours}:${minutes}:${seconds}`;
                span.style.color = '#28a745';
            } else {
                span.textContent = '--:--:--';
                span.style.color = '#dc3545';
            }
        } catch (err) {
            console.warn('SignalR time invoke failed', err);
            span.textContent = '--:--:--';
            span.style.color = '#dc3545';
        }
        updateTitleWithTimeStatus(); // вызываем после любого исхода
    }

    async function fetchServerTimeAPI() {
        const span = document.getElementById('apiServerTime');
        if (!span) return;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        try {
            const response = await fetch('/api/time', { signal: controller.signal });
            clearTimeout(timeoutId);
            const data = await response.json();
            if (data.timestamp) {
                const serverDate = new Date(data.timestamp);
                if (!isNaN(serverDate.getTime())) {
                    const hours = serverDate.getHours().toString().padStart(2, '0');
                    const minutes = serverDate.getMinutes().toString().padStart(2, '0');
                    const seconds = serverDate.getSeconds().toString().padStart(2, '0');
                    span.textContent = `${hours}:${minutes}:${seconds}`;
                    span.style.color = '#28a745';
                    updateTitleWithTimeStatus();
                    return;
                }
            }
            span.textContent = data.time || '--:--:--';
            span.style.color = '#28a745';
        } catch (err) {
            console.warn('API time fetch failed', err);
            span.textContent = '--:--:--';
            span.style.color = '#dc3545';
        }
        updateTitleWithTimeStatus();
    }

    function startServerTimeUpdater() {
        fetchServerTimeAPI();
        fetchServerTimeSignalR();
        setInterval(() => {
            fetchServerTimeAPI();
            fetchServerTimeSignalR();
        }, 60000);
    }

    function updateTitleWithTimeStatus() {
        const apiSpan = document.getElementById('apiServerTime');
        const signalrSpan = document.getElementById('signalrServerTime');

        const apiHasDash = apiSpan?.textContent === '--:--:--';
        const signalrHasDash = signalrSpan?.textContent === '--:--:--';

        let apiStatus = 'WebApi';
        let signalrStatus = 'SignalR';

        if (apiHasDash) apiStatus = '---';
        if (signalrHasDash) signalrStatus = '---';

        const title = `Pol Чат [ ${apiStatus} | ${signalrStatus} ]`;

        if (document.title !== title) {
            updateDocumentTitle();
        }
    }

    // ============ ЗАГРУЗКА СООБЩЕНИЙ ============

    async function loadMessages(chId: string, reset = true) {
        if (!chId || isLoadingMessages) return;

        if (reset) {
            currentPage = 1;
            hasMoreMessages = true;
            receivedMessages.clear();
            const messagesArea = document.getElementById('messages-area');
            if (messagesArea) messagesArea.innerHTML = '<div class="text-center text-muted py-3"><i class="fas fa-spinner fa-spin"></i> Загрузка сообщений...</div>';
        }

        isLoadingMessages = true;

        try {
            const url = `/api/messages/${chId}?page=${currentPage}&limit=${messagesPerPage}`;
            const res = await fetch(url);
            const data = await res.json();
            const messages = data.messages || [];
            hasMoreMessages = data.pagination?.hasMore || false;

            if (reset) {
                displayMessages(messages);
                messages.forEach((msg: Message) => {
                    if (msg.username === currentUsername && currentChannelType === 'channel') {
                        setTimeout(() => updateReadByDisplay(msg.id), 50);
                    }
                });
            } else {
                await prependMessages(messages);
            }

            updateLoadMoreIndicator();

        } catch (e) {
            console.error('Error loading messages:', e);
            if (reset) {
                const messagesArea = document.getElementById('messages-area');
                if (messagesArea) messagesArea.innerHTML = '<div class="text-center text-danger mt-5">Ошибка загрузки сообщений</div>';
            }
        } finally {
            isLoadingMessages = false;
        }
        setTimeout(() => updateScrollButtonsVisibility(), 100);
    }

    let joinQueue = Promise.resolve();

    async function joinChannel(type: 'channel' | 'dm', id: string, name: string, desc: string) {
        // Мгновенно обновляем UI (опционально, но улучшает отзывчивость)
        updateUIForChannelSwitch(type, id, name, desc);

        // Ставим в очередь, не блокируя следующие клики
        joinQueue = joinQueue.then(async () => {
            // Проверяем, не переключились ли уже на этот же канал
            if (currentChannel === id && currentChannelType === type) return;

            // ---- вся логика переключения (без confirm) ----
            // Убираем confirm – при потере файла/редактирования просто сбрасываем состояние
            if (pendingFileBlob) cancelFilePreview();
            if (editingMessageData) cancelEditing();
            if (replyToMessageData) cancelReply();

            // Выход из предыдущего канала (fire-and-forget)
            if (connection.state === signalR.HubConnectionState.Connected && currentChannel) {
                connection.invoke('LeaveChannel', currentChannel).catch((e: Error) => console.warn(e));
            }

            // Обновляем глобальные переменные
            currentChannel = id;
            currentChannelType = type;
            currentChannelName = name;
            currentPage = 1;
            hasMoreMessages = true;
            receivedMessages.clear();

            // Показываем индикатор загрузки
            const messagesArea = document.getElementById('messages-area');
            if (messagesArea) messagesArea.innerHTML = '<div class="text-center text-muted py-3"><i class="fas fa-spinner fa-spin"></i> Загрузка...</div>';

            // Подключаемся к новому каналу (не ждём)
            if (connection.state === signalR.HubConnectionState.Connected) {
                connection.invoke('JoinChannel', id).catch((e: Error) => console.warn(e));
            }

            // Загружаем сообщения (без отмены, но с быстрой сменой состояния)
            await loadMessagesOptimized(id, true);

            // Отмечаем прочитанным
            markChannelMessagesRead(id).catch(e => console.warn(e));
            updateActiveChannelInList(id, type);
            if (window.innerWidth <= 768) closeSidebar();
            document.getElementById('messageInput')?.focus();
        });
    }

    // Новая оптимизированная функция загрузки сообщений
    async function loadMessagesOptimized(chId: string, reset: boolean = true) {
        if (!chId) return;
        if (reset) {
            currentPage = 1;
            hasMoreMessages = true;
            receivedMessages.clear();
        }
        try {
            const url = `/api/messages/${chId}?page=${currentPage}&limit=${messagesPerPage}`;
            const res = await fetch(url);
            const data = await res.json();
            const messages = data.messages || [];
            hasMoreMessages = data.pagination?.hasMore || false;

            if (reset) {
                displayMessagesOptimized(messages);
            } else {
                prependMessages(messages);
            }
            updateLoadMoreIndicator();
        } catch (e) {
            console.error(e);
            if (reset) {
                const area = document.getElementById('messages-area');
                if (area && area.innerHTML.includes('Загрузка'))
                    area.innerHTML = '<div class="text-center text-danger">Ошибка</div>';
            }
        }
    }

    // Оптимизированная функция отображения сообщений
    function displayMessagesOptimized(msgs: Message[]) {
        initMessageStatuses(msgs);

        const div = document.getElementById('messages-area');
        if (!msgs || msgs.length === 0) {
            if (div) div.innerHTML = '<div class="text-center text-muted mt-5">Нет сообщений. Напишите первое!</div>';
            return;
        }

        // Используем DocumentFragment для пакетного обновления DOM
        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement('div');

        msgs.forEach((msg: Message) => {
            if (msg.readBy) messageReadBy.set(msg.id, msg.readBy);
            tempDiv.innerHTML = formatMessage(msg);
            const msgElement = tempDiv.firstElementChild;
            if (msgElement) fragment.appendChild(msgElement);
            tempDiv.innerHTML = '';
        });

        if (div) {
            div.innerHTML = '';
            div.appendChild(fragment);
        }

        attachReadCounterHandlers();
        bindMessageEvents();

        // Используем requestAnimationFrame для плавной прокрутки
        requestAnimationFrame(() => {
            scrollToBottomSafely(true);
            setTimeout(() => markVisibleMessagesAsRead(), 500);
            setTimeout(() => updateScrollButtonsVisibility(), 100);
        });
    }

    // Функция мгновенного обновления UI при переключении
    function updateUIForChannelSwitch(type: 'channel' | 'dm', id: string, name: string, desc: string) {
        // Обновляем заголовок чата
        const currentChannelNameEl = document.getElementById('current-channel-name');
        const currentChannelDescEl = document.getElementById('current-channel-desc');
        const messageInput = document.getElementById('messageInput') as HTMLInputElement | null;

        if (currentChannelNameEl) currentChannelNameEl.textContent = type === 'dm' ? `${name}` : name;
        if (currentChannelDescEl) currentChannelDescEl.textContent = desc ? `(${desc})` : '';
        if (messageInput) messageInput.disabled = false;

        // Визуально выделяем активный канал в списке
        document.querySelectorAll('.channel-item, .dm-item').forEach(el => el.classList.remove('active'));
        const selector = type === 'channel' ? `.channel-item[data-channel-id="${id}"]` : `.dm-item[data-dm-id="${id}"]`;
        const activeItem = document.querySelector(selector);
        if (activeItem) activeItem.classList.add('active');
    }

    document.addEventListener('click', (e: MouseEvent) => {
        const target = e.target as HTMLElement;
        if (!target) return;

        // Находим родительский элемент канала/DM
        const channelItem = target.closest('.channel-item, .dm-item') as HTMLElement;
        if (!channelItem) return;

        // Проверяем, не кликнули ли по кнопке действия (например, удаление DM)
        const actionButton = target.closest('.dm-actions .delete-btn, .channel-actions .delete-btn, button, .action-btn');
        if (actionButton) {
            // Если кликнули по кнопке - не переключаем канал
            return;
        }

        if (!document.body.contains(channelItem)) return;

        e.preventDefault();
        e.stopPropagation();

        const id = channelItem.dataset.channelId || channelItem.dataset.dmId;
        const nameElement = channelItem.querySelector('.channel-name, .dm-name') as HTMLElement;
        const name = channelItem.dataset.channelName || nameElement?.innerText?.trim() || '';
        const desc = channelItem.dataset.channelDesc || '';
        const type = channelItem.classList.contains('channel-item') ? 'channel' : 'dm';

        if (id) joinChannel(type, id, name, desc);
    });

    // Добавьте отмену запросов при размонтировании
    window.addEventListener('beforeunload', () => {
        currentJoinToken++; // Инвалидируем все ожидающие операции
    });

    let currentTotalUnread = 0;

    function updateDocumentTitle() {
        const apiSpan = document.getElementById('apiServerTime');
        const signalrSpan = document.getElementById('signalrServerTime');
        const apiHasDash = apiSpan?.textContent === '--:--:--';
        const signalrHasDash = signalrSpan?.textContent === '--:--:--';

        let apiStatus = apiHasDash ? '---' : 'WebApi';
        let signalrStatus = signalrHasDash ? '---' : 'SignalR';

        let baseTitle = `Pol Чат [ ${apiStatus} | ${signalrStatus} ]`;

        if (currentTotalUnread > 0) {
            document.title = `(${currentTotalUnread}) ${baseTitle}`;
        } else {
            document.title = baseTitle;
        }

        // Обновляем favicon
        updateFavicon(currentTotalUnread);
    }

    function updateFavicon(unreadCount: number) {
        // Получаем существующий favicon или создаём новый
        let favicon = document.querySelector("link[rel*='icon']") as HTMLLinkElement;

        if (!favicon) {
            favicon = document.createElement('link');
            favicon.rel = 'icon';
            document.head.appendChild(favicon);
        }

        if (unreadCount === 0) {
            // Возвращаем исходный favicon (если есть)
            favicon.href = '/static/favicon.ico'; // укажите путь к вашему стандартному favicon
            return;
        }

        // Создаём canvas для рисования favicon
        const canvas = document.createElement('canvas');
        const size = 128; // размер favicon
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        if (!ctx) return;

        // Фон (можно взять из основного логотипа или просто цвет)
        ctx.fillStyle = '#5865f2'; // цвет Discord-like (можно ваш фирменный)
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, 2 * Math.PI);
        ctx.fill();

        // Текст с цифрой
        let displayText = unreadCount > 99 ? '99+' : unreadCount.toString();
        ctx.fillStyle = 'white';
        ctx.font = `bold ${size * 0.8}px "Segoe UI", Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(displayText, size / 2, size / 2 + (displayText.length === 1 ? 2 : 0));

        // Преобразуем canvas в dataURL и устанавливаем как favicon
        favicon.href = canvas.toDataURL('image/png');

        if (unreadCount === 0) {
            favicon.href = '/static/favicon.ico';
            return;
        }
    }

    function updateActiveChannelInList(id: string, type: 'dm' | 'channel') {
        document.querySelectorAll('.channel-item, .dm-item').forEach(el => el.classList.remove('active'));
        if (type === 'channel') {
            const el = document.querySelector(`.channel-item[data-channel-id="${id}"]`);
            if (el) el.classList.add('active');
        } else {
            const el = document.querySelector(`.dm-item[data-dm-id="${id}"]`);
            if (el) el.classList.add('active');
        }
    }

    async function fetchMissedMessages(channelId: string, since: string): Promise<void> {
        try {
            // Запрашиваем сообщения после указанного времени
            const url = `/api/messages/${encodeURIComponent(channelId)}/since?timestamp=${encodeURIComponent(since)}&limit=100`;
            const response = await fetch(url);

            if (!response.ok) {
                console.warn('Failed to fetch missed messages:', response.status);
                return;
            }

            const data = await response.json() as { messages?: Message[]; count?: number; hasMore?: boolean };
            const missedMessages = data.messages || [];

            if (missedMessages.length === 0) return;

            console.log(`Fetched ${missedMessages.length} missed messages`);

            // Фильтруем те, которые уже есть
            const newMessages = missedMessages.filter((msg: Message) => !receivedMessages.has(msg.id));

            if (newMessages.length === 0) return;

            // Добавляем пропущенные сообщения
            const messagesDiv = document.getElementById('messages-area');
            if (messagesDiv && currentChannel === channelId) {
                // Проверяем последнее сообщение в DOM
                const lastMsgElement = messagesDiv.querySelector('.message:last-child');
                const lastMsgId = lastMsgElement?.id.replace('msg-', '');

                // Если последнее сообщение в DOM совпадает с последним полученным, пропускаем
                if (lastMsgId && newMessages.some((m: Message) => m.id === lastMsgId)) {
                    return;
                }

                // Добавляем новые сообщения
                for (const msg of newMessages) {
                    if (!receivedMessages.has(msg.id)) {
                        receivedMessages.add(msg.id);
                        messagesDiv.insertAdjacentHTML('beforeend', formatMessage(msg));
                    }
                }

                // Прокручиваем вниз, если пользователь был внизу
                const isNearBottom = messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < 100;
                if (isNearBottom) {
                    await scrollToBottomSafely(false);
                }

                // Обновляем непрочитанные счётчики
                await forceRefreshUnreadCounts();
            }

            // Обновляем последний ID и timestamp
            if (newMessages.length > 0) {
                const lastMsg = newMessages[newMessages.length - 1];
                // Сохраняем в глобальные переменные (нужно объявить их вверху)
                (window as any).lastReceivedMessageId = lastMsg.id;
                (window as any).lastMessageTimestamp = lastMsg.timestamp;
            }

        } catch (error) {
            console.error('Error fetching missed messages:', error);
        }
    }

    // Храним отправленные во время офлайна сообщения
    let offlineMessagesQueue: Array<{
        tempId: string;
        channelId: string;
        content: string;
        fileUrl?: string | null;
        replyTo?: any;
        timestamp: number;
    }> = [];


    // Отправляем накопленные сообщения после переподключения
    async function flushOfflineMessages() {
        if (offlineMessagesQueue.length === 0) return;
        if (connection.state !== signalR.HubConnectionState.Connected) return;

        console.log(`Sending ${offlineMessagesQueue.length} queued messages`);

        const messagesToSend = [...offlineMessagesQueue];
        offlineMessagesQueue = [];

        for (const msg of messagesToSend) {
            try {
                await connection.invoke('SendMessage', {
                    tempId: msg.tempId,
                    channelId: msg.channelId,
                    content: msg.content,
                    fileUrl: msg.fileUrl,
                    replyTo: msg.replyTo
                });

                // Небольшая задержка между сообщениями
                await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error) {
                console.error('Failed to send queued message:', error);
                // Возвращаем в очередь
                offlineMessagesQueue.push(msg);
            }
        }

        if (offlineMessagesQueue.length === 0) {
            showNotification('Все отложенные сообщения отправлены', 'success');
        }
    }


    async function onReconnectedAsync(connectionId: string) {
        console.log('SignalR reconnected, connectionId:', connectionId);
        updateConnectionStatus(true);

        await new Promise(resolve => setTimeout(resolve, 100));

        await fetchServerTimeSignalR();
        await fetchServerTimeAPI();

        if (currentChannel) {
            try {
                await connection.invoke('JoinChannel', currentChannel);
                console.log(`Re-joined channel: ${currentChannel}`);
            } catch (err) {
                console.error('Failed to re-join channel:', err);
            }
        }

        if (currentChannel && lastMessageTimestamp) {
            await fetchMissedMessages(currentChannel, lastMessageTimestamp);
        }

        await updateUserStatusOnServer(STATUS.ONLINE);
        await loadUsersWithStatus();
        await forceRefreshUnreadCounts();

        if (currentChannel) {
            await loadMessages(currentChannel, true);
        }

        await flushOfflineMessages();
    }

    connection.onreconnected((connectionId?: string): void => {
        if (!connectionId) return;
        void onReconnectedAsync(connectionId).catch(err =>
            console.error('onReconnectedAsync failed:', err)
        );
    });

    function updateConnectionStatus(connected: boolean, reconnecting: boolean = false) {
        const statusDiv = document.getElementById('connectionStatus');
        if (!statusDiv) return;

        if (reconnecting) {
            statusDiv.className = 'connection-status reconnecting';
            statusDiv.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i>';
            statusDiv.title = 'Переподключение...';
        } else if (connected) {
            statusDiv.className = 'connection-status online';
            statusDiv.innerHTML = '<i class="fas fa-circle"></i>';
            statusDiv.title = 'Подключено';

        } else {
            statusDiv.className = 'connection-status offline';
            statusDiv.innerHTML = '<i class="fas fa-exclamation-circle"></i>';
            statusDiv.title = 'Нет соединения';
            statusDiv.style.opacity = '1';
        }
    }

    // ============ СТАТУСЫ ============

    let isActiveTab = true, currentUserStatus: 'online' | 'away' | 'offline' = 'online';
    const STATUS = { ONLINE: 'online', AWAY: 'away', OFFLINE: 'offline' } as const;

    function updateActivity() {
        if (currentUserStatus === STATUS.AWAY && isActiveTab) updateUserStatusOnServer(STATUS.ONLINE);
    }

    async function updateUserStatusOnServer(status: string) {
        try {
            await fetch('/api/user/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
            currentUserStatus = status as any;
        } catch (e) {
            console.error(e);
        }
    }

    function setupActivityTracking() {
        const events = ['mousemove', 'mousedown', 'click', 'keypress', 'scroll'];
        events.forEach(e => document.addEventListener(e, updateActivity));
        setInterval(() => { if (isActiveTab) updateActivity(); }, 30000);
    }

    function setupVisibilityTracking() {
        document.addEventListener('visibilitychange', () => {
            isActiveTab = !document.hidden;
            if (isActiveTab && currentChannel) markChannelMessagesRead(currentChannel);
        });
    }

    function startHeartbeat() {
        setInterval(async () => {
            if (isActiveTab && currentUserStatus === STATUS.ONLINE) {
                await fetch('/api/user/heartbeat', { method: 'POST' }).catch(() => { });
            }
        }, 30000);
    }

    

    // ============ УВЕДОМЛЕНИЯ ============

    function scrollToEditingMessage() {
        if (editingMessageData) {
            const msgDiv = document.getElementById(`msg-${editingMessageData.id}`);
            if (msgDiv) {
                msgDiv.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    }



    function initNotificationSound() {
        try {
            audio = new Audio('/static/notification.mp3');
            audio.volume = 0.7;
        } catch (e) {
            console.error(e);
        }
    }

    function testNotification() {
        showFullNotification('🔔 Тест уведомления', 'Если вы слышите звук, уведомления работают!');
        if (audio) audio.play().catch(() => { });
    }


    // ============ SOCKET СОБЫТИЯ ============

    connection.on('reconnected', () => {
        updateConnectionStatus(true);
        updateUserStatusOnServer(STATUS.ONLINE);
        loadUsersWithStatus();
        forceRefreshUnreadCounts();
    });

    connection.on('close', () => updateConnectionStatus(false));

    connection.on('new_message', async (message: Message) => {
        console.log('Received new_message with replyTo:', message.replyTo);
        lastMessageTimestamp = message.timestamp;
        if (message.id && message.id.startsWith('temp_') && message.username === currentUsername) {
            console.log(`Ignoring own temp message in new_message: ${message.id}`);
            return;
        }

        // Если сообщение уже есть в DOM как временное - игнорируем
        const messagesDiv = document.getElementById('messages-area');
        if (messagesDiv) {
            const existingMessages = messagesDiv.querySelectorAll(`.message`);
            for (const existing of existingMessages) {
                const usernameSpan = existing.querySelector('.message-username');
                const textDiv = existing.querySelector('.message-text');
                if (usernameSpan?.textContent === message.username &&
                    textDiv?.innerHTML === formatText(message.content) &&
                    !message.id.startsWith('temp_')) {
                    console.log('Message already exists, skipping duplicate');
                    return;
                }
            }
        }

        setTimeout(() => updateScrollButtonsVisibility(), 100);

        if (receivedMessages.has(message.id)) return;
        await receivedMessages.add(message.id);

        const isCurrent = message.channelId === currentChannel;


        // Инициализация readBy для нового сообщения
        if (message.readBy) {
            messageReadBy.set(message.id, message.readBy);
        }
        
        // Если сообщение в текущем канале - показываем сразу
        if (isCurrent) {
            if (messagesDiv && messagesDiv.innerHTML.includes('Нет сообщений')) messagesDiv.innerHTML = '';

            if (messagesDiv) {
                // ВАЖНО: Убеждаемся, что все глобальные функции определены 
                // и передаем их через window
                const messageHtml = formatMessage(message);
                messagesDiv.insertAdjacentHTML('beforeend', messageHtml);
                attachReadCounterHandlers();
                bindMessageEvents();
                // Принудительно регистрируем обработчики для нового сообщения
                const newMsgElement = document.getElementById(`msg-${message.id}`);
                if (newMsgElement) {
                    // Убеждаемся, что кнопки действий имеют правильные onclick
                    const actionButtons = newMsgElement.querySelectorAll('.message-action-btn');
                    actionButtons.forEach(btn => {
                        const onclickAttr = btn.getAttribute('onclick');
                        if (onclickAttr && typeof (window as any)[onclickAttr.split('(')[0]] === 'function') {
                            // Обработчик уже есть в window, ничего не делаем
                        }
                    });
                }

                // Прокручиваем вниз только если пользователь был внизу
                const isNearBottom = messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < 100;
                if (isNearBottom) {
                    scrollToBottomSafely(false);
                }

                // Отмечаем как прочитанное, если видимо
                setTimeout(() => {
                    const mdiv = document.getElementById(`msg-${message.id}`);
                    if (mdiv && isElementInViewport(mdiv) && message.username !== currentUsername) {
                        markSingleMessageRead(message.id);
                    }
                }, 100);
            }

            if (currentChannelType === 'channel') {
                updateReadByDisplay(message.id);
            }
        }

        // Обновляем статусы для своих сообщений
        if (message.username === currentUsername) {
            const existingStatus = messageStatuses.get(message.id);
            if (existingStatus !== MESSAGE_STATUS.READ && existingStatus !== MESSAGE_STATUS.DELIVERED) {
                updateMessageStatus(message.id, MESSAGE_STATUS.SENT);
            }
            return;
        }

        // Обновляем счетчики непрочитанных для входящих сообщений
        if (message.username !== currentUsername && !isCurrent) {
            const isDM = message.channelId?.includes('-') || false;
            let isParticipant = false;

            try {
                if (isDM) {
                    const dmChannels = await fetch('/api/dm_channels').then(r => r.json());
                    isParticipant = dmChannels.some((dm: any) => dm.id === message.channelId);
                } else {
                    const channels = await fetch('/api/channels').then(r => r.json());
                    isParticipant = channels.some((ch: any) => ch.id === message.channelId);
                }
            } catch (e) { console.error(e); }

            if (isParticipant) {
                const newCnt = (unreadCounts[message.channelId || ''] || 0) + 1;
                updateChannelUnreadCount(message.channelId || '', newCnt, isDM);
            }

            if (notificationsEnabled && !document.hasFocus()) {
                showFullNotification(`${message.username}`, message.content || (message.fileUrl ? '📎 Файл' : ''));
                if (audio) audio.play().catch(() => { });
            }
        }
    });

    // Настраиваем reconnect с параметрами
    connection.onreconnecting((error) => {
        console.log('SignalR reconnecting...', error);
        updateConnectionStatus(false);

        // Немедленно показываем прочерки
        const span = document.getElementById('signalrServerTime');
        if (span) {
            span.textContent = '--:--:--';
            span.style.color = '#ffc107';
        }

        showNotification('Потеря соединения. Переподключение...', 'warning');
    });



    connection.onclose(async (error) => {
        console.log('SignalR connection closed', error);
        updateConnectionStatus(false);

        // Фоново пробуем обновить реальные данные (для восстановления)
        if (typeof fetchServerTimeSignalR === 'function') {
            fetchServerTimeSignalR();
        }
        if (typeof fetchServerTimeAPI === 'function') {
            fetchServerTimeAPI();
        }

        if (error) {
            showNotification('Соединение потеряно. Переподключение...', 'warning');
        }
    });

    connection.on('message_sent', (data: { tempId: string; id: string }) => {
        const { tempId, id } = data;
        if (!tempId || !id) return;

        console.log(`Message sent: tempId=${tempId}, realId=${id}`);

        const tempMsgDiv = document.getElementById(`msg-${tempId}`);
        if (tempMsgDiv) {
            // Обновляем ID в DOM
            tempMsgDiv.id = `msg-${id}`;

            // Обновляем data-атрибуты
            tempMsgDiv.setAttribute('data-msg-id', id);

            // Обновляем статус
            const statusSpan = tempMsgDiv.querySelector('.message-status');
            if (statusSpan && currentChannelType === 'dm') {
                statusSpan.innerHTML = '<i class="fas fa-check" style="color: #95a5a6; font-size: 11px;"></i>';
            }

            // Обновляем ID кнопок действий
            const actionDiv = tempMsgDiv.querySelector(`#actions-${tempId}`);
            if (actionDiv) {
                actionDiv.id = `actions-${id}`;
            }

            // Обновляем data-атрибуты всех кнопок
            const buttons = tempMsgDiv.querySelectorAll('[data-msg-id]');
            buttons.forEach(button => {
                const oldMsgId = button.getAttribute('data-msg-id');
                if (oldMsgId === tempId) {
                    button.setAttribute('data-msg-id', id);
                }
            });

            // Обновляем счетчики прочитавших
            const readCounters = tempMsgDiv.querySelectorAll('.read-counter');
            readCounters.forEach(counter => {
                const oldMsgId = counter.getAttribute('data-msg-id');
                if (oldMsgId === tempId) {
                    counter.setAttribute('data-msg-id', id);
                }
            });

            // Обновляем реакции
            const reactions = tempMsgDiv.querySelectorAll('.reaction-badge');
            reactions.forEach(reaction => {
                const oldMsgId = reaction.getAttribute('data-msg-id');
                if (oldMsgId === tempId) {
                    reaction.setAttribute('data-msg-id', id);
                }
            });

            if (messageReadBy.has(tempId)) {
                const readByData = messageReadBy.get(tempId);
                if (readByData) {
                    messageReadBy.set(id, readByData);
                }
                messageReadBy.delete(tempId);
            }

            if (messageStatuses.has(tempId)) {
                const statusData = messageStatuses.get(tempId);
                if (statusData) {
                    messageStatuses.set(id, statusData);
                }
                messageStatuses.delete(tempId);
            }

            if (currentChannelType === 'channel') {
                updateReadByDisplay(id);
            }
        }

        pendingMessages.delete(tempId);
    });

    // TODO: Requires Hub event - currently not broadcast by backend
    connection.on('message_edited', (data: { id: string; content: string }) => {
        const msgDiv = document.getElementById(`msg-${data.id}`);
        if (msgDiv) {
            let textDiv = msgDiv.querySelector('.message-text');

            if (data.content && data.content.trim()) {
                // Если есть текст - создаём или обновляем
                if (textDiv) {
                    textDiv.innerHTML = formatText(data.content);
                } else {
                    // Вставляем новый .message-text
                    const bubble = msgDiv.querySelector('.message-bubble');
                    const replyDiv = msgDiv.querySelector('.message-reply');
                    const fileDiv = msgDiv.querySelector('.message-file');
                    const reactionsDiv = msgDiv.querySelector('.message-reactions');

                    const newTextDiv = document.createElement('div');
                    newTextDiv.className = 'message-text';
                    newTextDiv.innerHTML = formatText(data.content);

                    if (replyDiv && replyDiv.nextSibling) {
                        bubble?.insertBefore(newTextDiv, replyDiv.nextSibling);
                    } else if (fileDiv) {
                        bubble?.insertBefore(newTextDiv, fileDiv);
                    } else if (reactionsDiv) {
                        bubble?.insertBefore(newTextDiv, reactionsDiv);
                    } else {
                        bubble?.appendChild(newTextDiv);
                    }
                }
            } else {
                // Если контент пустой - удаляем текстовую часть
                if (textDiv) {
                    textDiv.remove();
                }
            }

            // Добавляем или обновляем индикатор редактирования
            const header = msgDiv.querySelector('.message-header');
            if (header) {
                let editedSpan = header.querySelector('.message-time:last-child');
                const hasEditedIndicator = header.innerHTML.includes('(ред.)');

                if (!hasEditedIndicator) {
                    const timeSpan = header.querySelector('.message-time:first-child');
                    editedSpan = document.createElement('span');
                    editedSpan.className = 'message-time';
                    editedSpan.textContent = '(ред.)';

                    if (timeSpan && timeSpan.nextSibling) {
                        header.insertBefore(editedSpan, timeSpan.nextSibling);
                    } else if (timeSpan) {
                        timeSpan.insertAdjacentElement('afterend', editedSpan);
                    } else {
                        header.appendChild(editedSpan);
                    }
                }
            }
        }
    });

    // TODO: Requires Hub event - currently not broadcast by backend
    connection.on('message_deleted', (data: { id: string }) => {
        const d = document.getElementById(`msg-${data.id}`);
        if (d) d.remove();
    });

    connection.on('messages_delivered', (data: { channelId: string; messageIds: string[] }) => {
        if (data.channelId !== currentChannel) return;

        data.messageIds.forEach(msgId => {
            const currentStatus = messageStatuses.get(msgId);
            // Обновляем только если сообщение еще не прочитано
            if (currentStatus !== MESSAGE_STATUS.READ) {
                messageStatuses.set(msgId, MESSAGE_STATUS.DELIVERED);
                updateMessageStatus(msgId, MESSAGE_STATUS.DELIVERED);
            }
        });
    });

    // Обработчик для новых файлов/картинок
    connection.on('new_file_uploaded', async (fileInfo: {
        fileUrl: string;
        filename: string;
        fileType: string;
        fileSize: number;
        isImage: boolean;
        uploadedBy: string;
        uploadedAt: string;
        channelId: string;
    }) => {
        console.log('New file uploaded:', fileInfo);

        // Если файл загружен в текущем канале и не от текущего пользователя
        if (fileInfo.channelId === currentChannel && fileInfo.uploadedBy !== currentUsername) {
            // Создаём сообщение с файлом
            const newMessage: Message = {
                id: 'temp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11),
                channelId: currentChannel,
                username: fileInfo.uploadedBy,
                content: '', // можно добавить подпись, если передаётся
                fileUrl: fileInfo.fileUrl,
                timestamp: new Date().toISOString(),
                reactions: [],
                readBy: [],
                deliveredTo: [],
                edited: false
            };

            // Добавляем сообщение в чат
            const messagesDiv = document.getElementById('messages-area');
            if (messagesDiv) {
                // Если нет сообщений, очищаем заглушку
                if (messagesDiv.innerHTML.includes('Нет сообщений') || messagesDiv.innerHTML.includes('Выберите чат')) {
                    messagesDiv.innerHTML = '';
                }

                // Вставляем сообщение
                messagesDiv.insertAdjacentHTML('beforeend', formatMessage(newMessage));

                // Прокручиваем вниз
                scrollToBottomSafely(false);

                // Отмечаем как прочитанное, если видимо
                setTimeout(() => {
                    const msgElement = document.getElementById(`msg-${newMessage.id}`);
                    if (msgElement && isElementInViewport(msgElement) && fileInfo.uploadedBy !== currentUsername) {
                        markSingleMessageRead(newMessage.id);
                    }
                }, 100);
            }

            // Показываем уведомление
            if (notificationsEnabled && !document.hasFocus()) {
                const messageText = fileInfo.isImage
                    ? `🖼️ ${fileInfo.uploadedBy} отправил изображение`
                    : `📎 ${fileInfo.uploadedBy} отправил файл: ${fileInfo.filename}`;
                showFullNotification('Новое сообщение', messageText);
                if (audio) audio.play().catch(() => { });
            }
        }

        // Обновляем непрочитанные, если чат не активен
        if (fileInfo.channelId !== currentChannel && fileInfo.uploadedBy !== currentUsername) {
            const isDM = fileInfo.channelId.includes('-') || false;
            const newCnt = (unreadCounts[fileInfo.channelId] || 0) + 1;
            updateChannelUnreadCount(fileInfo.channelId, newCnt, isDM);

            // Показываем уведомление
            if (notificationsEnabled && !document.hasFocus()) {
                const messageText = fileInfo.isImage
                    ? `🖼️ Новое изображение от ${fileInfo.uploadedBy}`
                    : `📎 Новый файл от ${fileInfo.uploadedBy}`;
                showFullNotification(fileInfo.isImage ? 'Новое изображение' : 'Новый файл', messageText);
                if (audio) audio.play().catch(() => { });
            }
        }
    });

    connection.on('message_reaction_updated', (data: { id: string; reactions: Reaction[] }) => {
        const msgDiv = document.getElementById(`msg-${data.id}`);
        if (msgDiv) {
            let reactionsContainer = msgDiv.querySelector('.message-reactions');

            if (!reactionsContainer && data.reactions && data.reactions.length > 0) {
                const bubble = msgDiv.querySelector('.message-bubble');
                if (bubble) {
                    reactionsContainer = document.createElement('div');
                    reactionsContainer.className = 'message-reactions';
                    bubble.appendChild(reactionsContainer);
                }
            }

            if (reactionsContainer && data.reactions) {
                // Группируем реакции по emoji
                const groupedReactions = new Map<string, Reaction[]>();
                data.reactions.forEach(reaction => {
                    if (!groupedReactions.has(reaction.emoji)) {
                        groupedReactions.set(reaction.emoji, []);
                    }
                    groupedReactions.get(reaction.emoji)!.push(reaction);
                });

                // Обновляем HTML сгруппированных реакций
                reactionsContainer.innerHTML = Array.from(groupedReactions.entries()).map(([emoji, reactionList]) =>
                    `<span class="reaction-badge" data-msg-id="${escapeHtml(data.id)}" data-emoji="${escapeHtml(emoji)}" style="cursor: pointer;">
                    <span class="reaction-emoji">${escapeHtml(emoji)}</span> 
                    <span class="reaction-count">${reactionList.length}</span>
                </span>`
                ).join('');
            } else if (reactionsContainer && (!data.reactions || data.reactions.length === 0)) {
                reactionsContainer.remove();
            }
        }
    });

    // TODO: Requires Hub event - currently not broadcast by backend
    connection.on('message_read', (data: { messageId: string; readBy?: string; channelId?: string }) => {
        if (!data.messageId) return;

        // Обновляем локальный список прочитавших
        let currentReadBy = messageReadBy.get(data.messageId) || [];
        if (data.readBy && !currentReadBy.includes(data.readBy)) {
            currentReadBy.push(data.readBy);
            messageReadBy.set(data.messageId, currentReadBy);
        }

        const msgDiv = document.getElementById(`msg-${data.messageId}`);
        if (msgDiv) {
            const msgUsername = msgDiv.querySelector('.message-username')?.textContent;

            // Если это личная переписка (DM) и сообщение мое -> обновляем галочки
            if (currentChannelType === 'dm' && msgUsername === currentUsername) {
                updateMessageStatus(data.messageId, MESSAGE_STATUS.READ);
            }

            // Если это канал -> обновляем счетчик "глаз"
            if (currentChannelType === 'channel') {
                updateReadByDisplay(data.messageId);
            }
        }
    });

    connection.on('user_status', async (data: { username: string }) => {
        if (data.username !== currentUsername) await loadUsersWithStatus();
    });

    // TODO: Requires Hub event - currently not broadcast by backend
    connection.on('channel_renamed', (data: { channelId: string; newName: string }) => {
        const { channelId: renamedChannelId, newName } = data;

        const channelElement = document.querySelector(`.channel-item[data-channel-id="${renamedChannelId}"]`);
        if (channelElement) {
            const nameSpan = channelElement.querySelector('.channel-name');
            if (nameSpan) {
                const icon = nameSpan.querySelector('i');
                const unreadBadge = nameSpan.querySelector('.unread-badge');
                nameSpan.innerHTML = '';
                if (icon) nameSpan.appendChild(icon);
                nameSpan.appendChild(document.createTextNode(' ' + newName));
                if (unreadBadge) nameSpan.appendChild(unreadBadge);
            }
        }

        if (currentChannel === renamedChannelId && currentChannelType === 'channel') {
            currentChannelName = newName;
            const currentChannelNameEl = document.getElementById('current-channel-name');
            if (currentChannelNameEl) currentChannelNameEl.textContent = newName;
        }

        showNotification(`Канал переименован в "${newName}"`, 'info');
    });

    // TODO: Requires Hub event - currently not broadcast by backend
    connection.on('channel_description_updated', (data: { channelId: string; newDescription: string }) => {
        const { channelId: descChannelId, newDescription } = data;

        const channelElement = document.querySelector(`.channel-item[data-channel-id="${descChannelId}"]`);
        if (channelElement) {
            const descSpan = channelElement.querySelector('.channel-description');
            if (descSpan) {
                descSpan.textContent = newDescription || 'Нет описания';
            }
        }

        if (currentChannel === descChannelId && currentChannelType === 'channel') {
            const currentChannelDescEl = document.getElementById('current-channel-desc');
            if (currentChannelDescEl) currentChannelDescEl.textContent = '(' + newDescription + ')' || '';
        }

        if (newDescription) {
            showNotification(`Описание канала обновлено`, 'info');
        }
    });

    connection.on('unread_counts_updated', async () => {
        await forceRefreshUnreadCounts();
    });

    // DM unread count update event from backend
    connection.on('unread_update_dm', (data: { dmId: string; count: number }) => {
        if (data.dmId && typeof data.count === 'number') {
            updateChannelUnreadCount(data.dmId, data.count, true);
            unreadCounts[data.dmId] = data.count;
        }
    });

    // TODO: Requires Hub event - currently not broadcast by backend
    connection.on('channel_created', async () => await loadChannels(true));
    // TODO: Requires Hub event - currently not broadcast by backend
    connection.on('channel_deleted', async () => { if (currentChannelType === 'channel') { currentChannel = null; await loadChannels(true); } });
    // TODO: Requires Hub event - currently not broadcast by backend
    connection.on('dm_channel_created', () => loadDMChannels());
    // TODO: Requires Hub event - currently not broadcast by backend
    connection.on('dm_channel_deleted', async () => { if (currentChannelType === 'dm') { currentChannel = null; await loadDMChannels(); } });
    connection.on('typing', (data: { channelId: string; username: string }) => {
        if (data.channelId === currentChannel && data.username !== currentUsername) {
            const td = document.getElementById('typingIndicator');
            const typingUserSpan = document.getElementById('typingUser');
            if (td && typingUserSpan) {
                typingUserSpan.textContent = data.username;
                td.style.display = 'block';
                if (window.typingHideTimeout) clearTimeout(window.typingHideTimeout);
                window.typingHideTimeout = window.setTimeout(() => {
                    if (td) td.style.display = 'none';
                }, 2000);
            }
        }
    });

    // ============ ИНИЦИАЛИЗАЦИЯ ЧАТА ============

    async function initChat() {
        await loadCurrentUser();

        // Экспорт функций в глобальную область
        window.toggleSidebar = toggleSidebar;
        window.closeSidebar = closeSidebar;
        window.sendMessage = sendMessage;
        window.showCreateChannelModal = showCreateChannelModal;
        window.startDMWithUser = startDMWithUser;
        window.deleteDMChannel = deleteDMChannel;
        window.deleteChannel = deleteChannel;
        window.openChannelSettings = openChannelSettings;
        window.replyToMessage = replyToMessage;
        window.cancelReply = cancelReply;
        window.editMessage = editMessage;
        window.deleteMessage = deleteMessage;
        window.addReaction = addReaction;
        window.showReactionPanel = showReactionPanel;
        window.toggleMessageActions = toggleMessageActions;
        window.closeAllMessageActions = closeAllMessageActions;
        window.openImageModal = openImageModal;
        window.scrollToMessage = scrollToMessage;
        window.showReadByList = showReadByList;
        window.testNotification = testNotification;
        window.sendFileFromPreview = sendFileFromPreview;
        window.cancelFilePreview = cancelFilePreview;
        window.cancelFile = cancelFile;
        window.handleFileSelect = handleFileSelect;
        window.openMediaModal = openMediaModal;
        window.joinChannel = joinChannel;
        window.cancelEditing = cancelEditing;
        window.scrollToEditingMessage = scrollToEditingMessage;
        window.sendFileMessage = sendFileMessage;
        window.showReactionUsers = showReactionUsers;

        setupActivityTracking();
        setupVisibilityTracking();
        startHeartbeat();
        initNotificationSound();

        await updateTotalUnreadFromServer();

        function fixChatHeight() {
            const chatContainer = document.querySelector('.chat-container');
            const mainChat = document.querySelector('.main-chat');
            const messagesArea = document.getElementById('messages-area');

            if (!chatContainer || !mainChat || !messagesArea) return;

            // Устанавливаем высоту
            const viewportHeight = window.innerHeight;
            (chatContainer as HTMLElement).style.height = viewportHeight + 'px';
            (mainChat as HTMLElement).style.height = viewportHeight + 'px';

            // Вычисляем высоту messages-area
            const headerHeight = document.querySelector('.chat-header')?.clientHeight || 0;
            const typingHeight = document.getElementById('typingIndicator')?.offsetHeight || 0;
            const inputHeight = document.querySelector('.input-area')?.clientHeight || 0;

            const messagesHeight = viewportHeight - headerHeight - typingHeight - inputHeight;
            messagesArea.style.height = messagesHeight + 'px';
            messagesArea.style.maxHeight = messagesHeight + 'px';
        }

        if (sessionStorage.getItem('channelRenamed') === 'true') {
            const channelId = sessionStorage.getItem('channelId');
            const newName = sessionStorage.getItem('newChannelName');

            if (channelId && newName && currentChannel === channelId) {
                currentChannelName = newName;
                const currentChannelNameEl = document.getElementById('current-channel-name');
                if (currentChannelNameEl) currentChannelNameEl.textContent = newName;
            }

            sessionStorage.removeItem('channelRenamed');
            sessionStorage.removeItem('newChannelName');
            sessionStorage.removeItem('channelId');
        }

        if (sessionStorage.getItem('channelDescUpdated') === 'true') {
            const channelId = sessionStorage.getItem('channelId');
            const newDesc = sessionStorage.getItem('newChannelDesc');

            if (channelId && newDesc !== undefined && currentChannel === channelId) {
                const currentChannelDescEl = document.getElementById('current-channel-desc');
                if (currentChannelDescEl) currentChannelDescEl.textContent = '(' + newDesc + ')' || '';
            }

            sessionStorage.removeItem('channelDescUpdated');
            sessionStorage.removeItem('newChannelDesc');
            sessionStorage.removeItem('channelId');
        }

        const messagesArea = document.getElementById('messages-area');
        if (messagesArea) {
            let scrollTimeout: number;
            let readMarkTimeout: number; // новый таймер для отметки прочитанных

            messagesArea.addEventListener('scroll', function () {
                clearTimeout(scrollTimeout);
                clearTimeout(readMarkTimeout); // сбрасываем предыдущий таймер

                updateScrollButtonsVisibility();

                // отмечаем видимые сообщения с небольшой задержкой (300 мс)
                readMarkTimeout = window.setTimeout(() => {
                    if (currentChannel) {
                        markVisibleMessagesAsRead();
                    }
                }, 300);

                if (this.scrollTop === 0 && hasMoreMessages && !isLoadingMore && !isLoadingMessages && currentChannel) {
                    scrollTimeout = window.setTimeout(() => {
                        console.log('Loading more messages (scroll to top)...');
                        loadMoreMessages();
                    }, 200);
                }
            });
        }

        const saved = localStorage.getItem('notifications_enabled');
        if (saved !== null) notificationsEnabled = saved === 'true';
        const notificationToggle = document.getElementById('notificationToggle') as HTMLInputElement | null;
        if (notificationToggle) {
            notificationToggle.addEventListener('change', (e) => {
                notificationsEnabled = (e.target as HTMLInputElement).checked;
                localStorage.setItem('notifications_enabled', notificationsEnabled.toString());
            });
        }

        const textarea = document.getElementById('messageInput') as HTMLTextAreaElement | null;
        if (textarea) {
            textarea.addEventListener('input', function () {
                autoResizeTextarea();
                if (!isTyping && this.value.trim() && currentChannel) {
                    isTyping = true;
                    connection.invoke('Typing', currentChannel);
                }
                if (typingTimeout) clearTimeout(typingTimeout);
                typingTimeout = window.setTimeout(() => isTyping = false, 1000);
            });

            textarea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!isSending && !isUploading && currentChannel) {
                        sendMessage();
                    }
                }
            });
        }

        const sendButton = document.getElementById('sendButton');
        if (sendButton) {
            sendButton.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!isSending && !isUploading && currentChannel) {
                    sendMessage();
                }
            };
        }

        const emojiButton = document.getElementById('emojiButton');
        if (emojiButton) {
            emojiButton.onclick = (e) => {
                e.stopPropagation();
                toggleEmojiPicker();
            };
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const emojiPicker = document.getElementById('emojiPickerContainer');
                if (emojiPicker) emojiPicker.style.display = 'none';
                if (replyToMessageData) cancelReply();
                if (editingMessageData) cancelEditing();
            }
        });

        document.addEventListener('paste', handlePaste);

        await loadChannels();
        await loadDMChannels();
        await loadUsersWithStatus();
        await forceRefreshUnreadCounts();

        window.addEventListener('resize', fixChatHeight);
        fixChatHeight();


        setInterval(() => {
            // if (document.hidden) return; 
            forceRefreshUnreadCounts();
        }, 30000);

        const statusSyncInterval = setInterval(() => {
            if (!currentChannel || currentChannelType !== 'dm') return;
            syncMessageStatuses();
        }, 30000);

        // Очистка интервала при закрытии вкладки
        window.addEventListener('beforeunload', () => clearInterval(statusSyncInterval));

        const lastChat = localStorage.getItem('lastChat');
        if (lastChat) {
            try {
                const last = JSON.parse(lastChat);
                if (last.channelId && last.channelType) {
                    if (last.channelType === 'channel') {
                        joinChannel('channel', last.channelId, last.channelName || 'Канал', '');
                    } else if (last.channelType === 'dm') {
                        joinChannel('dm', last.channelId, last.channelName || 'Чат', '');
                    }
                }
            } catch (e) {
                console.error(e);
            }
        }

        if (!currentChannel) {
            try {
                const res = await fetch('/api/channels');
                const channels = await res.json();
                const general = channels.find((c: Channel) => c.name === 'Общий');
                if (general) joinChannel('channel', general.id, general.name, general.description || '');
            } catch (e) {
                console.error(e);
            }
        }

        updateActivity();
        autoResizeTextarea();

        // Инициализация кнопок прокрутки
        initScrollButtons();

        // Вызовите после initScrollButtons()
        observeMessagesForScrollButtons();
    }

    // Запускаем наблюдатель за изображениями
    let imageObserver: MutationObserver | null = null;

    // Сохраняем текущий чат в localStorage
    setInterval(() => {
        if (currentChannel && currentChannelType) {
            localStorage.setItem('lastChat', JSON.stringify({
                channelId: currentChannel,
                channelType: currentChannelType,
                channelName: currentChannelName
            }));
        }
    }, 1000);


    // Запуск инициализации чата
    initChat();

    // Запускаем наблюдатель за загрузкой изображений
    if (!imageObserver) {
        imageObserver = observeImageLoading();
    }

    const messagesDivForObserver = document.getElementById('messages-area');
    if (messagesDivForObserver) {
        messagesDivForObserver.addEventListener('scroll', () => {
            if (isFirstLoad) {
                if (pendingScrollToBottom) {
                    pendingScrollToBottom = false;
                    messagesDivForObserver.classList.remove('no-scroll');
                }
            }
        });
    }

}

// ============ КОД ТОЛЬКО ДЛЯ СТРАНИЦЫ ЛОГИНА ============
if (isLoginPage) {

    // При загрузке страницы
    document.addEventListener('DOMContentLoaded', () => {
        const saved = localStorage.getItem('rememberedUser');
        if (saved) {
            const user = JSON.parse(saved);
            const usernameInput = document.getElementById('username') as HTMLInputElement | null;
            const passwordInput = document.getElementById('password') as HTMLInputElement | null;
            const rememberCheckbox = document.getElementById('rememberMe') as HTMLInputElement | null;
            if (usernameInput) usernameInput.value = user.username;
            if (passwordInput) passwordInput.value = user.password;
            if (rememberCheckbox) rememberCheckbox.checked = true;
        }
    });

    // Обработка отправки формы
    const loginForm = document.getElementById('loginForm');
    if (loginForm) {
        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = (document.getElementById('username') as HTMLInputElement).value;
            const password = (document.getElementById('password') as HTMLInputElement).value;
            const remember = (document.getElementById('rememberMe') as HTMLInputElement).checked;

            if (remember) {
                localStorage.setItem('rememberedUser', JSON.stringify({
                    username: username,
                    password: password
                }));
            } else {
                localStorage.removeItem('rememberedUser');
            }

            try {
                const response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });

                const data = await response.json();
                if (data.success) {
                    window.location.href = data.redirect;
                } else {
                    console.error("isLoginPage() - error #1");
                    alert('Неверное имя пользователя или пароль');
                }
            } catch (error) {
                console.error(error);
                alert('Ошибка соединения с сервером');
            }
        });
    }
}

// ============ КОД ТОЛЬКО ДЛЯ СТРАНИЦЫ РЕГИСТРАЦИИ ============
if (isRegisterPage) {

    const commonPatterns = ['123', 'abc', 'qwerty', 'password', 'admin', 'user', '111', '000', 'qwe', 'asd', 'zxcv', 'qaz', 'wsx', 'edc', 'rfv', 'tgb', 'yhn', 'ujm', 'q1w2e3', '1qaz2wsx'];

    function checkUniqueness(password: string) {
        if (password.length === 0) return { isProblem: false, uniqueness: 1 };
        const uniqueChars = new Set(password).size;
        const uniqueness = uniqueChars / password.length;
        return {
            isProblem: uniqueness < 0.7,
            uniqueness: uniqueness,
            uniqueCount: uniqueChars,
            totalCount: password.length
        };
    }

    function checkCommonPatterns(password: string) {
        const lowerPassword = password.toLowerCase();
        for (const pattern of commonPatterns) {
            if (lowerPassword.includes(pattern)) {
                return { isProblem: true, pattern: pattern };
            }
        }
        return { isProblem: false, pattern: null };
    }

    interface PasswordCheckResult {
        strength: 'weak' | 'medium' | 'strong';
        score: number;
        rawScore: number;
        checks: { length: boolean; digit: boolean; upper: boolean; lower: boolean; special: boolean };
        penalties: { type: string; message: string }[];
        patternCheck: { isProblem: boolean; pattern: string | null };
        uniquenessCheck: { isProblem: boolean; uniqueness: number; uniqueCount?: number; totalCount?: number };
    }

    function checkPasswordStrength(password: string): PasswordCheckResult {
        let score = 0;
        let checks = {
            length: password.length >= 6,
            digit: /\d/.test(password),
            upper: /[A-Z]/.test(password),
            lower: /[a-z]/.test(password),
            special: /[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(password)
        };

        if (checks.length) score++;
        if (checks.digit) score++;
        if (checks.upper) score++;
        if (checks.lower) score++;
        if (checks.special) score += 2;

        let penalties: { type: string; message: string }[] = [];
        let penaltyScore = 0;

        const patternCheck = checkCommonPatterns(password);
        if (patternCheck.isProblem && password.length > 0) {
            penalties.push({
                type: 'pattern',
                message: `⚠️ Слишком простой паттерн: "${patternCheck.pattern}" — избегайте простых последовательностей`
            });
            penaltyScore += 2;
        }

        const uniquenessCheck = checkUniqueness(password);
        if (uniquenessCheck.isProblem && password.length > 0) {
            const percent = Math.round(uniquenessCheck.uniqueness * 100);
            penalties.push({
                type: 'uniqueness',
                message: `⚠️ Слишком много повторяющихся символов (только ${percent}% уникальных) — используйте более разнообразные символы`
            });
            penaltyScore += 1;
        }

        let finalScore = Math.max(0, score - penaltyScore);

        let strength: 'weak' | 'medium' | 'strong' = 'weak';
        if (finalScore <= 2) strength = 'weak';
        else if (finalScore <= 4) strength = 'medium';
        else strength = 'strong';

        return { strength, score: finalScore, rawScore: score, checks, penalties, patternCheck, uniquenessCheck };
    }

    function updatePenaltyWarnings(penalties: { type: string; message: string }[]) {
        const container = document.getElementById('penaltyWarnings');
        if (!container) return;

        if (penalties.length === 0) {
            container.innerHTML = '';
            return;
        }

        container.innerHTML = penalties.map(penalty => `
            <div class="warning-hint ${penalty.type === 'pattern' ? 'danger' : ''}">
                <i class="fas fa-exclamation-triangle"></i> ${penalty.message}
            </div>
        `).join('');
    }

    function updateStrengthIndicator(password: string) {
        const strengthBar = document.getElementById('strengthBar');
        const strengthText = document.getElementById('strengthText');

        if (!password) {
            if (strengthBar) {
                strengthBar.className = 'strength-bar';
                strengthBar.style.width = '0%';
            }
            if (strengthText) strengthText.innerHTML = '';
            updatePenaltyWarnings([]);
            return;
        }

        const { strength, checks, penalties } = checkPasswordStrength(password);

        const reqLength = document.getElementById('req-length');
        const reqDigit = document.getElementById('req-digit');
        const reqUpper = document.getElementById('req-upper');
        const reqLower = document.getElementById('req-lower');
        const reqSpecial = document.getElementById('req-special');

        if (reqLength) {
            reqLength.innerHTML = checks.length ? '<i class="fas fa-check-circle text-success"></i> Минимум 6 символов' : '<i class="far fa-circle"></i> Минимум 6 символов';
            reqLength.className = checks.length ? 'valid' : 'invalid';
        }
        if (reqDigit) {
            reqDigit.innerHTML = checks.digit ? '<i class="fas fa-check-circle text-success"></i> Хотя бы одна цифра' : '<i class="far fa-circle"></i> Хотя бы одна цифра';
            reqDigit.className = checks.digit ? 'valid' : 'invalid';
        }
        if (reqUpper) {
            reqUpper.innerHTML = checks.upper ? '<i class="fas fa-check-circle text-success"></i> Хотя бы одна заглавная буква' : '<i class="far fa-circle"></i> Хотя бы одна заглавная буква';
            reqUpper.className = checks.upper ? 'valid' : 'invalid';
        }
        if (reqLower) {
            reqLower.innerHTML = checks.lower ? '<i class="fas fa-check-circle text-success"></i> Хотя бы одна строчная буква' : '<i class="far fa-circle"></i> Хотя бы одна строчная буква';
            reqLower.className = checks.lower ? 'valid' : 'invalid';
        }
        if (reqSpecial) {
            reqSpecial.innerHTML = checks.special ? '<i class="fas fa-check-circle text-success"></i> Хотя бы один спецсимвол (!@#$%^&* и т.д.)' : '<i class="far fa-circle"></i> Хотя бы один спецсимвол (!@#$%^&* и т.д.)';
            reqSpecial.className = checks.special ? 'valid' : 'invalid';
        }

        updatePenaltyWarnings(penalties);

        if (strengthBar) {
            strengthBar.className = 'strength-bar';
            if (strength === 'weak') {
                strengthBar.classList.add('strength-weak');
                if (strengthText) strengthText.innerHTML = `<span class="text-danger">🔴 Слабый пароль - нельзя использовать</span>`;
            } else if (strength === 'medium') {
                strengthBar.classList.add('strength-medium');
                if (strengthText) strengthText.innerHTML = '<span class="text-warning">🟡 Средний пароль - можно использовать</span>';
            } else {
                strengthBar.classList.add('strength-strong');
                if (strengthText) strengthText.innerHTML = '<span class="text-success">🟢 Сильный пароль - отлично!</span>';
            }
        }
    }

    function checkPasswordMatch() {
        const password = document.getElementById('password') as HTMLInputElement | null;
        const confirm = document.getElementById('confirm') as HTMLInputElement | null;
        const feedback = document.getElementById('confirmFeedback');

        if (!password || !confirm || !feedback) return false;

        if (confirm.value && password.value !== confirm.value) {
            feedback.innerHTML = '<span class="text-danger">❌ Пароли не совпадают</span>';
            return false;
        } else if (confirm.value && password.value === confirm.value) {
            feedback.innerHTML = '<span class="text-success">✓ Пароли совпадают</span>';
            return true;
        }
        feedback.innerHTML = '';
        return false;
    }

    function checkUsername() {
        const username = document.getElementById('username') as HTMLInputElement | null;
        const feedback = document.getElementById('usernameFeedback');

        if (!username || !feedback) return false;

        if (username.value.length > 0) {
            if (username.value.length < 3) {
                feedback.innerHTML = '<span class="text-danger">❌ Имя должно содержать минимум 3 символа</span>';
                return false;
            } else if (username.value.length > 20) {
                feedback.innerHTML = '<span class="text-danger">❌ Имя не должно превышать 20 символов</span>';
                return false;
            } else if (!/^[a-zA-Z0-9_]+$/.test(username.value)) {
                feedback.innerHTML = '<span class="text-danger">❌ Используйте только буквы, цифры и знак подчеркивания</span>';
                return false;
            } else {
                feedback.innerHTML = '<span class="text-success">✓ Имя подходит</span>';
                return true;
            }
        }
        feedback.innerHTML = '';
        return false;
    }

    function validateForm() {
        const usernameValid = checkUsername();
        const password = document.getElementById('password') as HTMLInputElement | null;
        const submitBtn = document.getElementById('submitBtn');

        if (!password) return false;

        const { strength } = checkPasswordStrength(password.value);
        const passwordValid = password.value && strength !== 'weak';
        const matchValid = checkPasswordMatch();

        if (submitBtn) {
            // Приводим тип к HTMLButtonElement
            (submitBtn as HTMLButtonElement).disabled = !(usernameValid && passwordValid && matchValid);
        }

        return usernameValid && passwordValid && matchValid;
    }

    // События
    const usernameInput = document.getElementById('username') as HTMLInputElement | null;
    const passwordInput = document.getElementById('password') as HTMLInputElement | null;
    const confirmInput = document.getElementById('confirm') as HTMLInputElement | null;

    if (usernameInput) usernameInput.addEventListener('input', () => { checkUsername(); validateForm(); });
    if (passwordInput) passwordInput.addEventListener('input', (e) => { updateStrengthIndicator((e.target as HTMLInputElement).value); checkPasswordMatch(); validateForm(); });
    if (confirmInput) confirmInput.addEventListener('input', () => { checkPasswordMatch(); validateForm(); });

    // Отправка формы
    const registerForm = document.getElementById('registerForm');
    if (registerForm) {
        registerForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            if (!validateForm()) {
                alert('Пожалуйста, заполните форму правильно');
                return;
            }

            const username = (document.getElementById('username') as HTMLInputElement).value;
            const password = (document.getElementById('password') as HTMLInputElement).value;
            const confirm = (document.getElementById('confirm') as HTMLInputElement).value;

            if (password !== confirm) {
                alert('Пароли не совпадают');
                return;
            }

            const submitBtn = document.getElementById('submitBtn') as HTMLButtonElement;

            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Проверка...';
            }

            try {
                const response = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });

                const data = await response.json();

                if (data.success) {
                    let message = data.message || 'Регистрация успешна! Теперь войдите в систему.';
                    if (data.strength === 'medium') {
                        message = '✓ Регистрация успешна!\n\nПароль среднего уровня сложности.\n' + message;
                    } else if (data.strength === 'strong') {
                        message = '✓ Регистрация успешна!\n\nОтличный сильный пароль!\n' + message;
                    }
                    alert(message);
                    window.location.href = '/login';
                } else {
                    alert('Ошибка: ' + (data.error || 'Неизвестная ошибка'));
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = '<i class="fas fa-user-plus"></i> Зарегистрироваться';
                    }
                }
            } catch (error) {
                alert('Ошибка соединения с сервером');
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.innerHTML = '<i class="fas fa-user-plus"></i> Зарегистрироваться';
                }
            }
        });
    }

    updateStrengthIndicator('');
}

// ============ КОД ТОЛЬКО ДЛЯ СТРАНИЦЫ НАСТРОЕК КАНАЛА ============
// ============ КОД ТОЛЬКО ДЛЯ СТРАНИЦЫ НАСТРОЕК КАНАЛА ============
if (isSettingsPage) {

    let channelData: Channel | null = null;
    let renameModal: any, descriptionModal: any, infoModal: any, membersModal: any;
    let currentUser = '';
    let canDelete = false;

    const urlParams = new URLSearchParams(window.location.search);
    const channelId = urlParams.get('id');

    if (!channelId) {
        console.error('No channel ID in URL');
        showGlobalNotification('Канал не указан', 'danger');
        setTimeout(() => {
            window.location.href = '/';
        }, 1500);
    } else {
        console.log('Loading channel settings for ID:', channelId);
    }

    (async () => {
        try {
            const response = await fetch('/api/users/me');
            if (response.ok) {
                const userData = await response.json();
                currentUser = userData.username;
                window.CURRENT_USER = currentUser;
            }
        } catch (error) {
            console.error('Error loading user in settings:', error);
        }

        await loadChannelData();
    })();

    if (!channelId) {
        showGlobalNotification('Канал не указан', 'danger');
        setTimeout(() => goBack(), 1500);
    }

    async function loadChannelData() {
        try {
            const response = await fetch('/api/channels');
            const channels = await response.json();
            channelData = channels.find((c: Channel) => c.id === channelId) || null;

            if (!channelData) {
                showGlobalNotification('Канал не найден', 'danger');
                setTimeout(() => goBack(), 1500);
                return;
            }

            const channelNameEl = document.getElementById('channelName');
            const channelDescEl = document.getElementById('channelDesc');
            const currentNameValueEl = document.getElementById('currentNameValue');
            const currentDescValueEl = document.getElementById('currentDescValue');
            const channelIdDisplayEl = document.getElementById('channelIdDisplay');
            const channelCreatorEl = document.getElementById('channelCreator');
            const channelCreatedAtEl = document.getElementById('channelCreatedAt');

            if (channelNameEl) channelNameEl.textContent = channelData.name;
            if (channelDescEl) channelDescEl.textContent = channelData.description || 'Нет описания';
            if (currentNameValueEl) currentNameValueEl.textContent = channelData.name;
            if (currentDescValueEl) currentDescValueEl.textContent = channelData.description || 'Нет описания';
            if (channelIdDisplayEl) channelIdDisplayEl.textContent = channelData.id;
            if (channelCreatorEl) channelCreatorEl.textContent = channelData.createdByDisplay || channelData.createdBy || 'Неизвестно';
            if (channelCreatedAtEl) channelCreatedAtEl.textContent = channelData.createdAt ? new Date(channelData.createdAt).toLocaleString('ru-RU') : 'Неизвестно';

            if (channelData.createdByDeleted && channelCreatorEl) {
                channelCreatorEl.innerHTML += ' <span class="badge bg-secondary">аккаунт удален</span>';
            }

            // Проверяем права на удаление
            canDelete = (channelData.createdBy === currentUser || currentUser === 'admin');
            const dangerSection = document.getElementById('dangerSection');

            if (dangerSection) {
                const dangerSectionElement = dangerSection as HTMLElement;

                if (canDelete) {
                    dangerSectionElement.style.display = 'block';
                    // Убираем сообщение об ошибке, если оно было
                    const errorMsg = document.getElementById('deletePermissionError');
                    if (errorMsg) errorMsg.remove();
                } else {
                    dangerSectionElement.style.display = 'block';
                    // Показываем сообщение "Нет прав" вместо кнопки удаления
                    const deleteItem = dangerSectionElement.querySelector('.setting-item') as HTMLElement | null;
                    if (deleteItem) {
                        deleteItem.classList.remove('danger-item');
                        deleteItem.style.cursor = 'default';
                        deleteItem.onclick = null;

                        // Добавляем или обновляем сообщение
                        let errorMsg = document.getElementById('deletePermissionError');
                        if (!errorMsg) {
                            errorMsg = document.createElement('div');
                            errorMsg.id = 'deletePermissionError';
                            errorMsg.className = 'text-muted text-center py-2';
                            errorMsg.style.fontSize = '12px';
                            errorMsg.innerHTML = '<i class="fas fa-lock"></i> Нет прав на удаление этого канала. Только создатель канала может его удалить.';
                            dangerSectionElement.appendChild(errorMsg);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error loading channel:', error);
            showGlobalNotification('Ошибка загрузки данных канала', 'danger');
        }
    }

    async function renameChannel() {
        const newNameInput = document.getElementById('newChannelName') as HTMLInputElement | null;
        if (!newNameInput) return;

        const newName = newNameInput.value.trim();

        if (!newName) {
            showGlobalNotification('Введите название канала', 'danger');
            return;
        }

        try {
            const response = await fetch(`/api/channels/${channelId}/rename`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: newName })
            });

            const data = await response.json();

            if (response.ok) {
                showGlobalNotification('Канал переименован!', 'success');
                const modalEl = document.getElementById('renameModal');
                if (modalEl) {
                    const modal = window.bootstrap.Modal.getInstance(modalEl);
                    if (modal) modal.hide();
                }

                if (channelData) channelData.name = newName;
                const channelNameEl = document.getElementById('channelName');
                const currentNameValueEl = document.getElementById('currentNameValue');
                if (channelNameEl) channelNameEl.textContent = newName;
                if (currentNameValueEl) currentNameValueEl.textContent = newName;

                sessionStorage.setItem('channelRenamed', 'true');
                sessionStorage.setItem('newChannelName', newName);
                if (channelId) {
                    sessionStorage.setItem('channelId', channelId);
                } else {
                    sessionStorage.removeItem('channelId');
                }
            } else {
                showGlobalNotification(data.error || 'Ошибка переименования', 'danger');
            }
        } catch (error) {
            console.error('Error renaming channel:', error);
            showGlobalNotification('Ошибка соединения с сервером', 'danger');
        }
    }

    async function updateDescription() {
        const newDescInput = document.getElementById('newChannelDesc') as HTMLInputElement | null;
        if (!newDescInput) return;

        const newDesc = newDescInput.value.trim();

        try {
            const response = await fetch(`/api/channels/${channelId}/description`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: newDesc })
            });

            const data = await response.json();

            if (response.ok) {
                showGlobalNotification('Описание обновлено!', 'success');
                const modalEl = document.getElementById('descriptionModal');
                if (modalEl) {
                    const modal = window.bootstrap.Modal.getInstance(modalEl);
                    if (modal) modal.hide();
                }

                if (channelData) channelData.description = newDesc;
                const channelDescEl = document.getElementById('channelDesc');
                const currentDescValueEl = document.getElementById('currentDescValue');
                if (channelDescEl) channelDescEl.textContent = newDesc || 'Нет описания';
                if (currentDescValueEl) currentDescValueEl.textContent = newDesc || 'Нет описания';

                sessionStorage.setItem('channelDescUpdated', 'true');
                sessionStorage.setItem('newChannelDesc', newDesc);
                if (channelId) {
                    sessionStorage.setItem('channelId', channelId);
                } else {
                    sessionStorage.removeItem('channelId');
                }
            } else {
                showGlobalNotification(data.error || 'Ошибка обновления', 'danger');
            }
        } catch (error) {
            console.error('Error updating description:', error);
            showGlobalNotification('Ошибка соединения с сервером', 'danger');
        }
    }

    async function loadMembers() {
        const membersContainer = document.getElementById('membersList');
        if (!membersContainer) return;

        membersContainer.innerHTML = '<div class="text-center text-muted py-3">Загрузка...</div>';

        try {
            const response = await fetch('/api/users');
            const users = await response.json();

            const sortedUsers = [...users].sort((a: User, b: User) => {
                if (a.status === 'online' && b.status !== 'online') return -1;
                if (a.status !== 'online' && b.status === 'online') return 1;
                return 0;
            });

            let html = '';

            sortedUsers.forEach(user => {
                const isCreator = user.username === channelData?.createdBy;
                const isOnline = user.status === 'online';
                html += `
                    <div class="member-item">
                        <div class="member-info">
                            <div class="member-avatar">
                                ${escapeHtml(user.username.charAt(0).toUpperCase())}
                            </div>
                            <div>
                                <div class="member-name">
                                    ${escapeHtml(user.username)}
                                    ${isCreator ? '<span class="badge-creator ms-2">Создатель</span>' : ''}
                                </div>
                                <div class="member-status">
                                    <span class="status-dot ${isOnline ? 'status-online-dot' : 'status-offline-dot'}"></span>
                                    ${isOnline ? 'онлайн' : 'офлайн'}
                                </div>
                            </div>
                        </div>
                    </div>
                `;
            });

            membersContainer.innerHTML = html || '<div class="text-center text-muted py-3">Нет участников</div>';
        } catch (error) {
            console.error('Error loading members:', error);
            membersContainer.innerHTML = '<div class="text-center text-muted py-3">Ошибка загрузки участников</div>';
        }
    }

    function showRenameModal() {
        const newChannelNameInput = document.getElementById('newChannelName') as HTMLInputElement | null;
        if (newChannelNameInput && channelData) newChannelNameInput.value = channelData.name;
        const modalEl = document.getElementById('renameModal');
        if (modalEl) {
            renameModal = new window.bootstrap.Modal(modalEl);
            renameModal.show();
        }
    }

    function showDescriptionModal() {
        const newChannelDescInput = document.getElementById('newChannelDesc') as HTMLInputElement | null;
        if (newChannelDescInput && channelData) newChannelDescInput.value = channelData.description || '';
        const modalEl = document.getElementById('descriptionModal');
        if (modalEl) {
            descriptionModal = new window.bootstrap.Modal(modalEl);
            descriptionModal.show();
        }
    }

    function showChannelInfo() {
        const modalEl = document.getElementById('infoModal');
        if (modalEl) {
            infoModal = new window.bootstrap.Modal(modalEl);
            infoModal.show();
        }
    }

    async function showMembersModal() {
        const modalEl = document.getElementById('membersModal');
        if (modalEl) {
            membersModal = new window.bootstrap.Modal(modalEl);
            await loadMembers();
            membersModal.show();
        }
    }

    async function confirmDeleteChannel() {
        if (!canDelete) {
            showGlobalNotification('У вас нет прав на удаление этого канала', 'danger');
            return;
        }

        if (!channelData) return;

        if (confirm(`Вы уверены, что хотите удалить канал "${channelData.name}"?\n\nЭто действие невозможно отменить.`)) {
            try {
                const response = await fetch(`/api/channels/${channelId}`, {
                    method: 'DELETE'
                });

                const data = await response.json();

                if (response.ok) {
                    showGlobalNotification('Канал удален', 'success');
                    sessionStorage.setItem('channelDeleted', 'true');
                    setTimeout(() => {
                        goBack();
                    }, 1500);
                } else {
                    showGlobalNotification(data.error || 'Ошибка удаления', 'danger');
                }
            } catch (error) {
                console.error('Error deleting channel:', error);
                showGlobalNotification('Ошибка соединения с сервером', 'danger');
            }
        }
    }

    function goBack() {
        const returnToChat = sessionStorage.getItem('returnToChat');
        if (returnToChat === 'true') {
            sessionStorage.removeItem('returnToChat');
            window.location.href = '/';
        } else {
            window.location.href = '/';
        }
    }

    // Экспорт функций для HTML
    window.goBack = goBack;
    window.showChannelInfo = showChannelInfo;
    window.showRenameModal = showRenameModal;
    window.showDescriptionModal = showDescriptionModal;
    window.showMembersModal = showMembersModal;
    window.renameChannel = renameChannel;
    window.updateDescription = updateDescription;
    window.confirmDeleteChannel = confirmDeleteChannel;

    loadChannelData();

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !document.querySelector('.modal.show')) {
            goBack();
        }
    });
}

// ============ КОД ТОЛЬКО ДЛЯ СТРАНИЦЫ УПРАВЛЕНИЯ ПОЛЬЗОВАТЕЛЯМИ ============
if (isUserManagementPage) {
    let currentUser = '';

    // Загружаем текущего пользователя
    (async () => {
        try {
            const response = await fetch('/api/users/me');
            if (response.ok) {
                const userData = await response.json();
                currentUser = userData.username;
                window.CURRENT_USER = currentUser;
            }
        } catch (error) {
            console.error('Error loading user in admin panel:', error);
        }

        // Затем загружаем пользователей
        await loadUsers();
    })();

    async function loadUsers() {
        try {
            const response = await fetch('/api/users');
            const users = await response.json();

            const container = document.getElementById('users-list');
            if (!container) return;

            container.innerHTML = users.map((user: User) => `
                <div class="col-md-6 col-lg-4">
                    <div class="user-card">
                        <div class="d-flex align-items-center mb-3">
                            <div class="avatar me-3">
                                ${user.username.charAt(0).toUpperCase()}
                            </div>
                            <div class="flex-grow-1">
                                <h5 class="mb-0">${escapeHtml(user.username)}</h5>
                                <small>
                                    <span class="status-badge status-${user.status}"></span>
                                    ${user.status === 'online' ? 'онлайн' : 'офлайн'}
                                </small>
                            </div>
                            ${user.role === 'admin' ? '<span class="badge bg-warning"><i class="fas fa-crown"></i> Admin</span>' : ''}
                        </div>
                        
                        <div class="mb-2">
                            <small class="text-muted">
                                <i class="fas fa-calendar"></i> Регистрация: ${user.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'неизвестно'}
                            </small>
                        </div>
                        
                        ${user.lastSeen ? `
                            <div class="mb-3">
                                <small class="text-muted">
                                    <i class="fas fa-clock"></i> Последний визит: ${new Date(user.lastSeen).toLocaleString()}
                                </small>
                            </div>
                        ` : ''}
                        
                        ${user.username !== 'admin' && user.username !== '{{ username }}' ? `
                            <div class="d-flex gap-2">
                                <select class="form-select form-select-sm" onchange="changeRole('${user.username}', this.value)">
                                    <option value="user" ${user.role === 'user' ? 'selected' : ''}>Пользователь</option>
                                    <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Администратор</option>
                                </select>
                                <button class="btn btn-sm btn-danger" onclick="deleteUser('${user.username}')">
                                    <i class="fas fa-trash"></i>
                                </button>
                            </div>
                        ` : ''}
                    </div>
                </div>
            `).join('');
        } catch (error) {
            console.error('Error loading users:', error);
        }
    }

    async function changeRole(username: string, role: string) {
        try {
            const response = await fetch(`/api/users/${username}/role`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role })
            });

            if (response.ok) {
                alert('Роль успешно изменена');
                loadUsers();
            } else {
                alert('Ошибка при изменении роли');
            }
        } catch (error) {
            alert('Ошибка соединения с сервером');
        }
    }

    async function deleteUser(username: string) {
        if (confirm(`Удалить пользователя ${username}?`)) {
            try {
                const response = await fetch(`/api/users/${username}`, {
                    method: 'DELETE'
                });

                if (response.ok) {
                    alert('Пользователь удален');
                    loadUsers();
                } else {
                    const error = await response.json();
                    alert(error.error || 'Ошибка при удалении');
                }
            } catch (error) {
                alert('Ошибка соединения с сервером');
            }
        }
    }

    // Экспорт функций
    window.changeRole = changeRole;
    window.deleteUser = deleteUser;

    // Загрузка пользователей
    loadUsers();

    // Обновление списка каждые 10 секунд
    setInterval(loadUsers, 10000);

    // Автообновление при перезапуске сервера
    let isRestarting = false;

    const userConnection = new signalR.HubConnectionBuilder()
        .withUrl("/chathub", {
            withCredentials: true,
            transport: signalR.HttpTransportType.WebSockets | signalR.HttpTransportType.LongPolling
        })
        .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
        .configureLogging(signalR.LogLevel.Information)
        .build();

    userConnection.start().catch(err => { console.error('SignalR user connection error:', err) });

    userConnection.on('server_restart', () => {
        isRestarting = true;
        const indicator = document.createElement('div');
        indicator.id = 'restart-indicator';
        indicator.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0,0,0,0.9);
            color: white;
            padding: 20px 30px;
            border-radius: 12px;
            z-index: 10000;
            text-align: center;
        `;
        indicator.innerHTML = `
            <div><i class="fas fa-sync-alt fa-spin" style="font-size: 40px;"></i></div>
            <div style="margin-top: 15px;">Сервер перезапускается...</div>
            <div style="margin-top: 10px;">Страница обновится автоматически</div>
            <button onclick="window.location.reload()" style="margin-top: 15px;">Обновить сейчас</button>
        `;
        document.body.appendChild(indicator);

        const checkInterval = setInterval(async () => {
            try {
                const response = await fetch('/api/server_info');
                if (response.ok) {
                    clearInterval(checkInterval);
                    window.location.reload();
                }
            } catch (e) { }
        }, 1000);
    });

    userConnection.on('close', () => {
        if (!isRestarting) {
            const msg = document.createElement('div');
            msg.className = 'alert alert-warning';
            msg.innerHTML = '⚠️ Связь с сервером потеряна. Возможно, идет перезапуск...';
            msg.style.position = 'fixed';
            msg.style.top = '10px';
            msg.style.left = '50%';
            msg.style.transform = 'translateX(-50%)';
            msg.style.zIndex = '9999';
            document.body.prepend(msg);
            setTimeout(() => msg.remove(), 5000);
        }
    });
}
