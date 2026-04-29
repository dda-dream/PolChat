
// ============ ГЛОБАЛЬНЫЕ ОБЪЯВЛЕНИЯ И ТИПЫ ============
//import * as bootstrap from 'bootstrap';
//import * as signalr from '@microsoft/signalr'
//import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
/// <reference path="./global.d.ts" />
/* global window, document, bootstrap, localStorage, sessionStorage, fetch, alert, confirm, prompt, FileReader, URL, FormData, MutationObserver, Set, Map, console */
"use strict";

// Расширение глобального объекта window
 
// ============ ОПРЕДЕЛЕНИЕ ТИПА СТРАНИЦЫ ============

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
        .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
        .configureLogging(signalR.LogLevel.Information)
        .build();

    // Start connection
    connection.start().then(() => {
        console.log('SignalR Connected');
        updateConnectionStatus(true);
        updateUserStatusOnServer(STATUS.ONLINE);
        loadUsersWithStatus();
        forceRefreshUnreadCounts();
        updateServerTimeInTitle();
    }).catch(
        err => console.error('SignalR connection error:', err)
    );

    function toggleSidebar() {
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
    let editingMessageId: string | null = null;
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

    let serverTimeOffset = 0;           // разница между серверным и локальным временем (мс)
    let titleUpdateInterval: number | null = null;
    let lastUnreadCount = 0;

    const DELETED_USER_DISPLAY = "Удаленный аккаунт";
    const DELETED_USER_AVATAR = "?";

    // ============ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ЧАТА ============

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

    function parseServerDateTime(dateTimeStr: string): Date | null {
        // формат "дд.мм.гггг чч:мм:сс"
        const parts = dateTimeStr.split(' ');
        if (parts.length !== 2) return null;
        const dateParts = parts[0].split('.');
        const timeParts = parts[1].split(':');
        if (dateParts.length !== 3 || timeParts.length !== 3) return null;
        const year = parseInt(dateParts[2], 10);
        const month = parseInt(dateParts[1], 10) - 1;
        const day = parseInt(dateParts[0], 10);
        const hour = parseInt(timeParts[0], 10);
        const minute = parseInt(timeParts[1], 10);
        const second = parseInt(timeParts[2], 10);
        return new Date(year, month, day, hour, minute, second);
    }

    function updateTitleWithCurrentTime() {
        const now = new Date();
        const serverNow = new Date(now.getTime() + serverTimeOffset);
        const timeStr = serverNow.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const dateStr = serverNow.toLocaleDateString('ru-RU');
        const title = lastUnreadCount > 0
            ? `(${lastUnreadCount}) Pol Чат | ${dateStr} ${timeStr}`
            : `Pol Чат | ${dateStr} ${timeStr}`;
        if (document.title !== title) document.title = title;
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
            replyHtml = `<div class="message-reply" onclick="scrollToMessage('${escapeHtml(msg.replyTo.id)}')">
                <div class="reply-header"><i class="fas fa-reply"></i> ${escapeHtml(replyDisplayName)}</div>
                <div class="reply-content">${escapeHtml(msg.replyTo.content || (msg.replyTo.fileUrl ? '📎 Файл' : ''))}</div>
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
            reactionsHtml = `<div class="message-reactions">${msg.reactions.map(r => `<span class="reaction-badge" onclick="addReaction('${escapeHtml(msg.id)}','${escapeHtml(r.emoji)}')">${escapeHtml(r.emoji)} ${r.users.length}</span>`).join('')}</div>`;
        }

        const safeUsername = escapeHtml(displayUsername);
        const safeContent = msg.content ? formatText(msg.content) : '';
        const messageStatus = getMessageStatusHtml(msg);

        // Индикатор "ред." если сообщение редактировалось
        const editedIndicator = msg.edited ? '<span class="message-time">(ред.)</span>' : '';

        let readCounterHtml = '';
        if (currentChannelType === 'channel') {
            const readByList = messageReadBy.get(msg.id) || [];
            const otherReaders = readByList.filter(u => u !== msg.username);
            const readCount = otherReaders.length;

            if (readCount > 0) {
                readCounterHtml = `<span class="read-counter ms-2" style="cursor: pointer; font-size: 10px; color: #6c757d; display: inline-flex; align-items: center; gap: 3px;" onclick="event.stopPropagation(); showReadByList('${escapeHtml(msg.id)}')">
                    <i class="fas fa-eye"></i> ${readCount}
                </span>`;
            }
        }

        const contentForAttr = msg.content || '';
        const actionButtons = `<div class="message-actions" id="actions-${escapeHtml(msg.id)}">
            <button class="message-action-btn" onclick="replyToMessage('${escapeHtml(msg.id)}','${escapeHtml(msg.username)}','${escapeHtml(contentForAttr).replace(/'/g, "\\'").replace(/\\/g, "\\\\")}'); closeAllMessageActions();"><i class="fas fa-reply"></i> Ответить</button>
            ${isOwn ? `<button class="message-action-btn" onclick="editMessage('${escapeHtml(msg.id)}'); closeAllMessageActions();"><i class="fas fa-edit"></i> Редактировать</button>
            <button class="message-action-btn" onclick="deleteMessage('${escapeHtml(msg.id)}'); closeAllMessageActions();"><i class="fas fa-trash"></i> Удалить</button>` : ''}
            <button class="message-action-btn" onclick="showReactionPanel('${escapeHtml(msg.id)}', event); closeAllMessageActions();"><i class="far fa-smile"></i> Реакция</button>
        </div>`;

        return `<div class="message ${isOwn ? 'message-own' : ''}" id="msg-${escapeHtml(msg.id)}">
            <div class="message-wrapper">
                <div class="message-avatar">${escapeHtml(avatarLetter)}</div>
                <div class="message-content-wrapper">
                    <div class="message-bubble" onclick="toggleMessageActions('${escapeHtml(msg.id)}'); event.stopPropagation();">
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
            .replace(/([\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}])/gu, '<span style="font-size:1.2em;">$1</span>');
        return f;
    }

    function displayMessages(msgs: Message[]) {
        initMessageStatuses(msgs);

        const div = document.getElementById('messages-area');
        if (!msgs || msgs.length === 0) {
            if (div) div.innerHTML = '<div class="text-center text-muted mt-5">Нет сообщений. Напишите первое!</div>';
            return;
        }

        msgs.forEach(msg => {
            if (msg.readBy) messageReadBy.set(msg.id, msg.readBy);
        });

        if (div) div.innerHTML = msgs.map(m => formatMessage(m)).join('');

        msgs.forEach(msg => {
            if (currentChannelType === 'channel') {
                updateReadByDisplay(msg.id);
            }
        });

        scrollToBottomSafely(true);
        setTimeout(() => markVisibleMessagesAsRead(), 500);
    }

    function prependMessages(messages: Message[]) {
        const messagesDiv = document.getElementById('messages-area');
        if (!messagesDiv) return;

        const oldScrollHeight = messagesDiv.scrollHeight;
        const oldScrollTop = messagesDiv.scrollTop;

        const newMessages = messages.filter(msg => !receivedMessages.has(msg.id));
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
            for (const msg of newMessages) {
                if (msg.username === currentUsername) {
                    updateReadByDisplay(msg.id);
                }
            }
            const newScrollHeight = messagesDiv.scrollHeight;
            const heightDiff = newScrollHeight - oldScrollHeight;
            messagesDiv.scrollTop = oldScrollTop + heightDiff;
        }
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
        const msgDiv = document.getElementById(`msg-${messageId}`);
        if (!msgDiv) return;

        const msgUsername = msgDiv.querySelector('.message-username')?.textContent;
        let readBy = messageReadBy.get(messageId) || [];

        if (msgUsername) {
            readBy = readBy.filter(u => u !== msgUsername);
        }

        if (readBy.length === 0) {
            showNotification('Никто ещё не прочитал это сообщение', 'info');
            return;
        }

        const modalHtml = `
            <div class="modal fade" id="readByModal" tabindex="-1">
                <div class="modal-dialog modal-dialog-centered">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title"><i class="fas fa-check-double"></i> Прочитали сообщение</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body" id="readByList" style="max-height: 60vh; overflow-y: auto;">
                            <div class="text-center text-muted py-3">Загрузка...</div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Закрыть</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const oldModal = document.getElementById('readByModal');
        if (oldModal) oldModal.remove();

        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const container = document.getElementById('readByList');
        if (container) {
            getUsersCached().then(users => {
                const userMap = new Map<string, User>();
                users.forEach(u => userMap.set(u.username, u));

                let html = '';
                for (const username of readBy) {
                    const user = userMap.get(username) || { status: 'offline', role: 'user' } as User;
                    const isOnline = user.status === 'online';
                    const isAdmin = user.role === 'admin';

                    html += `
                        <div class="read-by-item" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #e9ecef;">
                            <div style="display: flex; align-items: center; gap: 12px;">
                                <div class="read-by-avatar" style="width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold;">
                                    ${escapeHtml(username.charAt(0).toUpperCase())}
                                </div>
                                <div>
                                    <div class="read-by-name" style="font-weight: 500;">
                                        ${escapeHtml(username)}
                                        ${isAdmin ? '<i class="fas fa-crown text-warning ms-1" style="font-size: 12px;"></i>' : ''}
                                    </div>
                                    <div class="read-by-status" style="font-size: 11px; color: #6c757d;">
                                        <span class="status-dot" style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; background: ${isOnline ? '#4caf50' : '#9e9e9e'};"></span>
                                        ${isOnline ? 'онлайн' : 'офлайн'}
                                    </div>
                                </div>
                            </div>
                            <i class="fas fa-check-circle" style="color: #34b7f1;"></i>
                        </div>
                    `;
                }
                container.innerHTML = html;
            }).catch(() => {
                let html = '';
                for (const username of readBy) {
                    html += `
                        <div class="read-by-item" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 0; border-bottom: 1px solid #e9ecef;">
                            <div style="display: flex; align-items: center; gap: 12px;">
                                <div class="read-by-avatar" style="width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; align-items: center; justify-content: center; color: white; font-weight: bold;">
                                    ${escapeHtml(username.charAt(0).toUpperCase())}
                                </div>
                                <div>
                                    <div class="read-by-name" style="font-weight: 500;">${escapeHtml(username)}</div>
                                </div>
                            </div>
                            <i class="fas fa-check-circle" style="color: #34b7f1;"></i>
                        </div>
                    `;
                }
                container.innerHTML = html;
            });
        }


        const modalEl = document.getElementById('readByModal');
        if (modalEl) {
            const modal = new bootstrap.Modal(modalEl);
            modal.show();

            // Use arrow function and reference modalEl directly
            modalEl.addEventListener('hidden.bs.modal', () => {
                modalEl.remove();
            });
        }
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
        if (file.size > 500 * 1024 * 1024) {
            showNotification('Файл слишком большой. Максимум 500MB', 'danger');
            return;
        }

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

        // Добавляем поле для ввода текста к файлу
        if (div) {
            div.innerHTML = `<div class="preview-content">
                ${content}
                <div style="margin-top: 12px;">
                    <textarea id="fileCaptionInput" placeholder="Введите подпись к файлу..." style="width:100%; padding:8px; border-radius:8px; border:1px solid #ddd; resize:none; font-family:inherit; font-size:14px;" rows="2"></textarea>
                </div>
                <div class="preview-actions" style="margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end;">
                    <button class="btn-send" onclick="sendFileFromPreview()">Отправить</button>
                    <button class="btn-cancel" onclick="cancelFilePreview()">Отмена</button>
                </div>
            </div>`;
            div.style.display = 'block';
        }

        pendingFileBlob = file;
        pendingFileUrl = url;
        pendingFileName = file.name;
    }

    async function sendFileFromPreview() {
        if (!pendingFileBlob) return;
        if (!currentChannel) {
            showNotification('Выберите чат для отправки', 'warning');
            cancelFilePreview();
            return;
        }

        const file = pendingFileBlob;
        const fileName = pendingFileName || 'file';
        const tempId = 'temp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);

        // Получаем текст подписи из textarea
        const captionInput = document.getElementById('fileCaptionInput') as HTMLTextAreaElement | null;
        let caption = captionInput ? captionInput.value.trim() : '';
        caption = sanitizeInput(caption);

        const replyData = replyToMessageData ? { id: replyToMessageData.id, username: replyToMessageData.username, content: replyToMessageData.content } : null;
        cancelReply();
        cancelFilePreview();

        const formData = new FormData();
        formData.append('file', file, fileName);
        formData.append('channelId', currentChannel || '');

        try {
            const response = await fetch('/upload', { method: 'POST', body: formData });
            const data = await response.json();

            if (data.success) {
                pendingMessages.set(tempId, {
                    content: caption,
                    fileUrl: data.fileUrl,
                    replyTo: replyData,
                    channelId: currentChannel
                });
                connection.invoke('SendMessage', {
                    tempId: tempId,
                    channelId: currentChannel,
                    content: caption,
                    fileUrl: data.fileUrl,
                    replyTo: replyData
                });
                showNotification(caption ? 'Файл с подписью отправлен!' : 'Файл отправлен!', 'success');
            } else {
                showNotification(data.error || 'Ошибка загрузки файла', 'danger');
            }
        } catch (e) {
            console.error(e);
            showNotification('Ошибка загрузки файла', 'danger');
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
                    // Автоматически фокусируемся на поле ввода подписи
                    setTimeout(() => {
                        const captionInput = document.getElementById('fileCaptionInput');
                        if (captionInput) captionInput.focus();
                    }, 100);
                }
                break;
            }
        }
    }

    // ============ ОТПРАВКА СООБЩЕНИЙ ============

    async function sendMessage() {
        if (isSending) return;

        const input = document.getElementById('messageInput') as HTMLTextAreaElement | null;
        if (!input) return;

        let content = input.value;
        content = sanitizeInput(content);

        // БЕРЁМ ФАЙЛ НАПРЯМУЮ ИЗ INPUT, а не из pendingFileBlob
        const fileInput = document.getElementById('fileInput') as HTMLInputElement | null;
        const selectedFile = fileInput?.files?.[0];
        const hasFile = !!selectedFile;
        const hasText = !!content;
        const hasReply = !!replyToMessageData;

        console.log('[sendMessage] hasFile:', hasFile, 'file:', selectedFile?.name);

        if (!hasText && !hasReply && !hasFile) return;
        if (!currentChannel) {
            showNotification('Выберите чат', 'warning');
            return;
        }

        // Редактирование сообщения
        if (editingMessageId) {
            const response = await fetch(`/api/messages/${editingMessageId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: content })
            });
            if (response.ok) {
                editingMessageId = null;
                input.value = '';
                autoResizeTextarea();
                input.focus();
                cancelReply();
                showNotification('✅ Сообщение отредактировано', 'success');
            } else {
                const error = await response.json();
                showNotification(error.error || 'Ошибка редактирования', 'danger');
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
            fileUrl: blobUrl, // временный blob URL
            timestamp: new Date().toISOString(),
            reactions: [],
            readBy: [],
            deliveredTo: [],
            isTemp: true,
            edited: false
        };

        if (messagesDiv) {
            const existing = document.getElementById(`msg-${tempId}`);
            if (!existing) {
                messagesDiv.insertAdjacentHTML('beforeend', formatMessage(tempMessage));
                scrollToBottomSafely(false);
            }
        }

        let messageElement = document.getElementById(`msg-${tempId}`);

        // ---- ОТПРАВКА НА СЕРВЕР (файл или текст) ----
        try {
            if (hasFile && selectedFile) {
                // Загружаем файл
                const formData = new FormData();
                formData.append('file', selectedFile);
                formData.append('channelId', currentChannel);

                const uploadResponse = await fetch('/upload', { method: 'POST', body: formData });
                const uploadData = await uploadResponse.json();

                if (!uploadData.success) {
                    throw new Error(uploadData.error || 'Ошибка загрузки файла');
                }

                // Обновляем картинку в сообщении (blob -> реальный URL)
                if (messageElement) {
                    const img = messageElement.querySelector('.message-image');
                    if (img) {
                        img.setAttribute('src', uploadData.fileUrl);
                        img.setAttribute('onclick', `event.stopPropagation(); openMediaModal('${uploadData.fileUrl.replace(/'/g, "\\'")}', 'image')`);
                    } else {
                        const videoSource = messageElement.querySelector('video source');
                        if (videoSource) {
                            videoSource.setAttribute('src', uploadData.fileUrl);
                            (videoSource.parentElement as HTMLVideoElement)?.load();
                        } else {
                            const fileLink = messageElement.querySelector('a');
                            if (fileLink) fileLink.setAttribute('href', uploadData.fileUrl);
                        }
                    }
                }

                // Отправляем SignalR сообщение с реальным URL
                await connection.invoke('SendMessage', {
                    tempId: tempId,
                    channelId: currentChannel,
                    content: content,
                    fileUrl: uploadData.fileUrl,
                    replyTo: replyData
                });

                // Очищаем input
                if (fileInput) fileInput.value = '';
            } else {
                // Только текст
                await connection.invoke('SendMessage', {
                    tempId: tempId,
                    channelId: currentChannel,
                    content: content,
                    fileUrl: null,
                    replyTo: replyData
                });
            }

            // Успех: очищаем UI
            input.value = '';
            autoResizeTextarea();
            input.focus();
            cancelReply();

            // Скрываем предпросмотр, если он был открыт
            const pastePreview = document.getElementById('pastePreview');
            if (pastePreview) pastePreview.style.display = 'none';

        } catch (err) {
            console.error('[sendMessage] Error:', err);
            showNotification(err.message || 'Ошибка отправки', 'danger');
            // Удаляем временное сообщение при ошибке
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
        editingMessageId = mid;
        const msgDiv = document.getElementById(`msg-${mid}`);
        if (!msgDiv) {
            showNotification('Сообщение не найдено', 'danger');
            return;
        }
        const textDiv = msgDiv.querySelector('.message-text');
        if (!textDiv) {
            showNotification('Редактирование недоступно для этого сообщения', 'warning');
            return;
        }

        // Берём HTML из отображаемого текста
        let htmlContent = textDiv.innerHTML;
        // Заменяем <br> на \n
        let plainText = htmlContent.replace(/<br\s*\/?>/gi, '\n');
        // Удаляем все остальные HTML-теги
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = plainText;
        plainText = tempDiv.textContent || tempDiv.innerText || '';
        // Декодируем HTML-сущности (например, &amp; → &)
        const textarea = document.createElement('textarea');
        textarea.innerHTML = plainText;
        plainText = textarea.value;

        const inp = document.getElementById('messageInput') as HTMLTextAreaElement | null;
        if (!inp) return;
        inp.value = plainText;
        inp.focus();
        inp.selectionStart = inp.selectionEnd = inp.value.length;
        autoResizeTextarea();
        showNotification('✏️ Редактирование сообщения... Нажмите Enter для сохранения', 'info');
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

    function toggleMessageActions(mid: string) {
        const d = document.getElementById(`actions-${mid}`);
        if (d) {
            if (currentlyActiveMessageActions && currentlyActiveMessageActions !== d) currentlyActiveMessageActions.classList.remove('show');
            d.classList.toggle('show');
            currentlyActiveMessageActions = d.classList.contains('show') ? d : null;
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
            lastUnreadCount = total;

            // Получаем серверное время и вычисляем смещение
            try {
                const timeRes = await fetch('/api/time');
                const timeData = await timeRes.json();
                const serverDateTimeStr = `${timeData.date} ${timeData.time}`;
                const serverDate = parseServerDateTime(serverDateTimeStr);
                if (serverDate) {
                    const localNow = new Date();
                    serverTimeOffset = serverDate.getTime() - localNow.getTime();
                }
            } catch (e) {
                console.warn('Failed to sync time:', e);
            }

            updateTitleWithCurrentTime();
            updateFavicon(total);

            // Запускаем таймер обновления заголовка, если ещё не запущен
            if (titleUpdateInterval === null) {
                titleUpdateInterval = window.setInterval(() => {
                    updateTitleWithCurrentTime();
                }, 1000);
            }
        } catch (e) {
            console.error('Failed to update unread total:', e);
        }
    }

    function updateFavicon(count: number) {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.fillStyle = '#5865F2';
        ctx.beginPath();
        ctx.arc(32, 32, 32, 0, 2 * Math.PI);
        ctx.fill();

        ctx.fillStyle = 'white';
        ctx.font = 'bold 40px "Segoe UI", Arial, sans-serif';
        ctx.fillText('💬', 14, 48);

        if (count > 0) {
            ctx.fillStyle = '#ED4245';
            ctx.beginPath();
            ctx.arc(48, 16, 18, 0, 2 * Math.PI);
            ctx.fill();

            ctx.fillStyle = 'white';
            ctx.font = 'bold 22px "Segoe UI", Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            let text = count > 99 ? '99+' : count.toString();
            ctx.fillText(text, 48, 18);
        }

        const link = document.querySelector("link[rel*='icon']") as HTMLLinkElement || document.createElement('link') as HTMLLinkElement;
        link.type = 'image/x-icon';
        link.rel = 'shortcut icon';
        link.href = canvas.toDataURL('image/png');
        document.getElementsByTagName('head')[0].appendChild(link);
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
        } catch (e) { 
            console.error(e); 
            }
    }

    function renderChannels(channels: Channel[]) {
        const div = document.getElementById('channels-list');
        if (!channels || channels.length === 0) { if (div) div.innerHTML = '<div class="text-center text-muted py-3">Нет каналов</div>'; return; }
        let html = '';
        for (const ch of channels) {
            const active = currentChannel === ch.id && currentChannelType === 'channel';
            const unread = unreadCounts[ch.id] || 0;
            channelNamesCache.set(ch.id, ch.name);
            html += `<div class="channel-item ${active ? 'active' : ''}" data-channel-id="${escapeHtml(ch.id)}">
                <div class="channel-info" onclick="joinChannel('channel','${escapeHtml(ch.id)}','${escapeHtml(ch.name)}','${escapeHtml(ch.description || '')}')">
                    <div class="channel-name"><i class="fas fa-hashtag"></i> ${escapeHtml(ch.name)}${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}</div>
                    <div class="channel-description">${escapeHtml(ch.description) || 'Нет описания'}</div>
                </div>
                ${ch.name !== 'Общий' ? `<div class="channel-actions"><button class="action-btn delete-btn" onclick="event.stopPropagation(); deleteChannel('${escapeHtml(ch.id)}','${escapeHtml(ch.name)}')"><i class="fas fa-trash"></i></button></div>` : ''}
            </div>`;
        }
        if (div) div.innerHTML = html;
    }

    async function loadDMChannels() {
        try {
            const res = await fetch('/api/dm_channels');
            const dms = await res.json();
            const div = document.getElementById('dm-list');
            if (!dms || dms.length === 0) { if (div) div.innerHTML = '<div class="text-center text-muted py-3">Нет личных чатов</div>'; return; }
            if (div) {
                div.innerHTML = dms.map((dm: DMChannel) => {
                    const active = currentChannel === dm.id && currentChannelType === 'dm';
                    const unread = unreadCounts[dm.id] || 0;
                    const displayName = dm.isDeleted ? DELETED_USER_DISPLAY : dm.name;
                    return `<div class="dm-item ${active ? 'active' : ''}" data-dm-id="${escapeHtml(dm.id)}">
                        <div class="dm-info" onclick="joinChannel('dm','${escapeHtml(dm.id)}','${escapeHtml(displayName)}','')">
                            <div class="dm-name"><i class="fas fa-user"></i> ${escapeHtml(displayName)}${unread > 0 ? `<span class="unread-badge">${unread > 99 ? '99+' : unread}</span>` : ''}</div>
                            <div class="dm-preview">Личный чат</div>
                        </div>
                        <div class="dm-actions"><button class="action-btn delete-btn" onclick="event.stopPropagation(); deleteDMChannel('${escapeHtml(dm.id)}','${escapeHtml(displayName)}')"><i class="fas fa-trash"></i></button></div>
                    </div>`;
                }).join('');
            }
        } catch (e) { console.error(e); }
    }

    async function loadUsersWithStatus() {
        try {
            const users = await getUsersCached();
            const others = users.filter(u => u.username !== currentUsername);
            const div = document.getElementById('users-list');
            if (others.length === 0) { if (div) div.innerHTML = '<div class="text-center text-muted py-3">Нет других пользователей</div>'; return; }
            let html = '';
            for (const u of others) {
                const statusClass = u.status === 'online' ? 'status-online' : (u.status === 'away' ? 'status-away' : 'status-offline');
                const statusText = u.status === 'online' ? 'онлайн' : (u.status === 'away' ? 'отошел' : formatLastSeen(u.lastSeen));
                html += `<div class="user-item">
                    <div class="user-info" onclick="startDMWithUser('${escapeHtml(u.username)}')">
                        <div class="user-status ${statusClass}"></div>
                        <div><strong>${escapeHtml(u.username)}</strong>${u.role === 'admin' ? '<i class="fas fa-crown text-warning ms-1"></i>' : ''}<div class="status-text-small">${escapeHtml(statusText)}</div></div>
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
    }

    async function joinChannel(type: string, id: string, name: string, desc: string): Promise<void> {
        // Добавляем проверку внутри
        if (type !== "dm" && type !== "channel") {
            console.error("Invalid channel type:", type);
            return;
        }
        if (currentChannel === id && currentChannelType === type) return;

        // Добавляем проверку состояния соединения
        if (connection.state === signalR.HubConnectionState.Connected && currentChannel) {
            try {
                await connection.invoke('LeaveChannel', currentChannel);
            } catch (error) {
                console.error('Failed to leave channel:', error);
            }
        }

        currentChannel = id;
        currentChannelType = type;
        currentChannelName = name;

        const currentChannelNameEl = document.getElementById('current-channel-name');
        const currentChannelDescEl = document.getElementById('current-channel-desc');
        const messageInput = document.getElementById('messageInput') as HTMLInputElement | null;

        if (currentChannelNameEl) currentChannelNameEl.textContent = type === 'dm' ? `Чат с ${name}` : name;
        let newDesc = "(" + desc + ")" || (type === 'dm' ? 'Личный чат' : '');
        if (currentChannelDescEl) currentChannelDescEl.textContent = newDesc;
        if (messageInput) messageInput.disabled = false;
        connection.invoke('JoinChannel', id);
        currentPage = 1;
        hasMoreMessages = true;
        await loadMessages(id, true);
        updateActiveChannelInList(id, type);
        await markChannelMessagesRead(id);
        if (window.innerWidth <= 768) closeSidebar();
        if (messageInput) messageInput.focus();
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
        } catch (e) 
        {
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

    async function updateServerTimeInTitle() {
        try {
            const response = await fetch('/api/time');
            const timeData = await response.json();
            const serverDateTimeStr = `${timeData.date} ${timeData.time}`;
            const serverDate = parseServerDateTime(serverDateTimeStr);
            if (serverDate) {
                const localNow = new Date();
                serverTimeOffset = serverDate.getTime() - localNow.getTime();
                updateTitleWithCurrentTime();
            }
        } catch (e) {
            console.error('Failed to sync time:', e);
        }
    }

    // ============ УВЕДОМЛЕНИЯ ============

    function initNotificationSound() {
        try {
            audio = new Audio('/static/notification.mp3');
            audio.volume = 0.7;
        } catch (e) 
        {
            console.error(e);
        }
    }

    function testNotification() {
        showFullNotification('🔔 Тест уведомления', 'Если вы слышите звук, уведомления работают!');
        if (audio) audio.play().catch(() => { });
    }

    function updateConnectionStatus(connected: boolean) {
        const div = document.getElementById('connectionStatus');
        if (div) {
            if (connected) {
                div.className = 'connection-status online';
                div.innerHTML = '<i class="fas fa-circle"></i>';
                div.style.opacity = '1';
                //if (connectionStatusTimeout) clearTimeout(connectionStatusTimeout);
                //connectionStatusTimeout = window.setTimeout(() => div.style.opacity = '0', 5000);
            } else {
                div.className = 'connection-status offline';
                div.innerHTML = '<i class="fas fa-exclamation-circle"></i>';
                div.style.opacity = '1';
            }
        }
    }

    // ============ SOCKET СОБЫТИЯ ============

    connection.on('reconnected', () => {
        updateConnectionStatus(true);
        updateUserStatusOnServer(STATUS.ONLINE);
        loadUsersWithStatus();
        forceRefreshUnreadCounts();
        updateServerTimeInTitle();
    });

    connection.on('close', () => updateConnectionStatus(false));

    connection.on('new_message', async (message: Message) => {
        if (message.id && message.id.startsWith('temp_') && message.username === currentUsername) {
            console.log(`Ignoring own temp message in new_message: ${message.id}`);
            return;
        }

        // Если сообщение уже есть в DOM как временное - игнорируем
        const existingTempMsg = document.getElementById(`msg-temp_`);
        // Более точная проверка: ищем любое сообщение с таким же содержимым от того же пользователя
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
        
        if (receivedMessages.has(message.id)) return;
        await receivedMessages.add(message.id);

        const isCurrent = message.channelId === currentChannel;

        // Если сообщение в текущем канале - показываем сразу
        if (isCurrent) {
            const messagesDiv = document.getElementById('messages-area');
            if (messagesDiv && messagesDiv.innerHTML.includes('Нет сообщений')) messagesDiv.innerHTML = '';

            if (messagesDiv) {
                // Добавляем сообщение в конец
                messagesDiv.insertAdjacentHTML('beforeend', formatMessage(message));

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

    connection.on('message_sent', (data: { tempId: string; id: string }) => {
        const { tempId, id } = data;
        if (!tempId || !id) return;

        console.log(`Message sent: tempId=${tempId}, realId=${id}`);

        // Заменяем временное сообщение на реальное
        const tempMsgDiv = document.getElementById(`msg-${tempId}`);
        if (tempMsgDiv) {
            // Обновляем ID в DOM
            tempMsgDiv.id = `msg-${id}`;

            // Обновляем статус, если есть индикатор
            const statusSpan = tempMsgDiv.querySelector('.message-status');
            if (statusSpan && currentChannelType === 'dm') {
                statusSpan.innerHTML = '<i class="fas fa-check" style="color: #95a5a6; font-size: 11px;"></i>';
            }

            // Обновляем ID кнопок действий
            const actionDiv = tempMsgDiv.querySelector(`#actions-${tempId}`);
            if (actionDiv) {
                actionDiv.id = `actions-${id}`;
            }

            // Обновляем onclick в кнопках
            const replyBtn = tempMsgDiv.querySelector(`button[onclick*="replyToMessage('${tempId}']`);
            if (replyBtn) {
                const newOnclick = replyBtn.getAttribute('onclick')?.replace(tempId, id);
                if (newOnclick) replyBtn.setAttribute('onclick', newOnclick);
            }

            const editBtn = tempMsgDiv.querySelector(`button[onclick*="editMessage('${tempId}']`);
            if (editBtn) {
                const newOnclick = editBtn.getAttribute('onclick')?.replace(tempId, id);
                if (newOnclick) editBtn.setAttribute('onclick', newOnclick);
            }

            const deleteBtn = tempMsgDiv.querySelector(`button[onclick*="deleteMessage('${tempId}']`);
            if (deleteBtn) {
                const newOnclick = deleteBtn.getAttribute('onclick')?.replace(tempId, id);
                if (newOnclick) deleteBtn.setAttribute('onclick', newOnclick);
            }

            const reactionBtn = tempMsgDiv.querySelector(`button[onclick*="showReactionPanel('${tempId}']`);
            if (reactionBtn) {
                const newOnclick = reactionBtn.getAttribute('onclick')?.replace(tempId, id);
                if (newOnclick) reactionBtn.setAttribute('onclick', newOnclick);
            }
        }

        pendingMessages.delete(tempId);
    });

    // TODO: Requires Hub event - currently not broadcast by backend
    connection.on('message_edited', (data: { id: string; content: string }) => {
        const d = document.getElementById(`msg-${data.id}`);
        if (d) {
            const td = d.querySelector('.message-text');
            if (td) {
                td.innerHTML = formatText(data.content);
            }

            // Добавляем индикатор (ред.), если его ещё нет в заголовке
            const header = d.querySelector('.message-header');
            if (header && !header.innerHTML.includes('(ред.)')) {
                // Находим контейнер для времени или добавляем в конец
                const timeSpan = header.querySelector('.message-time');
                const editedSpan = document.createElement('span');
                editedSpan.className = 'message-time';
                editedSpan.textContent = '(ред.)';

                if (timeSpan && timeSpan.nextSibling) {
                    header.insertBefore(editedSpan, timeSpan.nextSibling);
                } else if (timeSpan) {
                    // Вставляем после последнего .message-time
                    timeSpan.insertAdjacentElement('afterend', editedSpan);
                } else {
                    header.appendChild(editedSpan);
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
                id: 'temp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
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

    connection.on('message_reaction_updated', (data: { id: string; reactions: { emoji: string; users: string[] }[] }) => {
        const d = document.getElementById(`msg-${data.id}`);
        if (d) {
            let rd = d.querySelector('.message-reactions');
            if (!rd) {
                const bubble = d.querySelector('.message-bubble');
                if (bubble) {
                    rd = document.createElement('div');
                    rd.className = 'message-reactions';
                    bubble.appendChild(rd);
                }
            }
            if (rd && data.reactions) {
                rd.innerHTML = data.reactions.map(r => `<span class="reaction-badge" onclick="addReaction('${escapeHtml(data.id)}','${escapeHtml(r.emoji)}')">${escapeHtml(r.emoji)} ${r.users.length}</span>`).join('');
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

            messagesArea.addEventListener('scroll', function () {
                clearTimeout(scrollTimeout);

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

        setInterval(() => {
            updateServerTimeInTitle();
        }, 60000);

        window.addEventListener('beforeunload', () => {
            if (titleUpdateInterval) clearInterval(titleUpdateInterval);
        });

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

    // Экспорт функций в глобальную область
    window.toggleSidebar = toggleSidebar;
    window.closeSidebar = closeSidebar;
    window.joinChannel = joinChannel;
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
if (isSettingsPage) {

    let channelData: Channel | null = null;
    let renameModal: any, descriptionModal: any, infoModal: any, membersModal: any;
    let currentUser = '';

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

        // Затем загружаем данные канала
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

            const dangerSection = document.getElementById('dangerSection');
            if (dangerSection && (channelData.createdBy === currentUser || currentUser === 'admin')) {
                dangerSection.style.display = 'block';
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
                    const modal = bootstrap.Modal.getInstance(modalEl);
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
                    // Опционально: очистить ключ, если ID нет
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
                    const modal = bootstrap.Modal.getInstance(modalEl);
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
                    // Опционально: очистить ключ, если ID нет
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
            renameModal = new bootstrap.Modal(modalEl);
            renameModal.show();
        }
    }

    function showDescriptionModal() {
        const newChannelDescInput = document.getElementById('newChannelDesc') as HTMLInputElement | null;
        if (newChannelDescInput && channelData) newChannelDescInput.value = channelData.description || '';
        const modalEl = document.getElementById('descriptionModal');
        if (modalEl) {
            descriptionModal = new bootstrap.Modal(modalEl);
            descriptionModal.show();
        }
    }

    function showChannelInfo() {
        const modalEl = document.getElementById('infoModal');
        if (modalEl) {
            infoModal = new bootstrap.Modal(modalEl);
            infoModal.show();
        }
    }

    async function showMembersModal() {
        const modalEl = document.getElementById('membersModal');
        if (modalEl) {
            membersModal = new bootstrap.Modal(modalEl);
            await loadMembers();
            membersModal.show();
        }
    }

    async function confirmDeleteChannel() {
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
