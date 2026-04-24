declare global {
    //import { HubConnection } from '@microsoft/signalr';
    //import * as bootstrap from 'bootstrap';
    const bootstrap: typeof import('bootstrap');
    const signalR: typeof import('@microsoft/signalr');
    //type HubConnectionBuilder = import('@microsoft/signalr').HubConnection;
    //console.log(HubConnectionBuilder);
     
    // ====================== ИНТЕРФЕЙСЫ ======================
    // ASP.NET Core System.Text.Json сериализует в camelCase

    interface Message {
        id: string;
        channelId?: string;
        username: string;
        content: string;
        fileUrl?: string | null;
        timestamp: string;
        edited?: boolean;
        editedAt?: string;
        reactions?: { emoji: string; users: string[] }[];
        readBy?: string[];
        deliveredTo?: string[];
        replyTo?: {
            id: string;
            username: string;
            content?: string;
            isDeleted?: boolean;
            fileUrl?: string;
        } | null;
        isDeletedSender?: boolean;
        isTemp?: boolean;
    }

    interface User {
        username: string;
        status: 'online' | 'away' | 'offline';
        role: 'user' | 'admin';
        lastSeen?: string;
        createdAt?: string;
        avatar?: string;
        isDeleted?: boolean;
    }

    interface Channel {
        id: string;
        name: string;
        description?: string;
        isPrivate?: boolean;
        createdBy?: string;
        createdByDisplay?: string;
        createdByDeleted?: boolean;
        createdAt?: string;
    }
      
    interface DMChannel {
        id: string;
        name: string;
        originalName?: string;
        isDeleted?: boolean;
    }

    interface UnreadCounts {
        [key: string]: number;
    }

    // ====================== WINDOW ======================
    interface Window {
        CURRENT_USER?: string;
        toggleSidebar?: () => void;
        closeSidebar?: () => void;
        joinChannel?: (type: string, id: string, name: string, desc: string) => void;
        sendMessage?: () => void;
        showCreateChannelModal?: () => void;
        startDMWithUser?: (username: string) => void;
        deleteDMChannel?: (id: string, username: string) => void;
        deleteChannel?: (id: string, name: string) => void;
        openChannelSettings?: () => void;
        replyToMessage?: (id: string, username: string, content: string) => void;
        cancelReply?: () => void;
        editMessage?: (id: string, content: string) => void;
        deleteMessage?: (id: string) => void;
        addReaction?: (id: string, emoji: string) => void;
        showReactionPanel?: (id: string, event: MouseEvent) => void;
        toggleMessageActions?: (id: string) => void;
        closeAllMessageActions?: () => void;
        openImageModal?: (url: string) => void;
        scrollToMessage?: (id: string) => void;
        showReadByList?: (id: string) => void;
        testNotification?: () => void;
        sendFileFromPreview?: () => void;
        cancelFilePreview?: () => void;
        cancelFile?: () => void;
        handleFileSelect?: (input: HTMLInputElement) => void;
        goBack?: () => void;
        showChannelInfo?: () => void;
        showRenameModal?: () => void;
        showDescriptionModal?: () => void;
        showMembersModal?: () => void;
        renameChannel?: () => void;
        updateDescription?: () => void;
        confirmDeleteChannel?: () => void;
        changeRole?: (username: string, role: string) => void;
        deleteUser?: (username: string) => void;
        typingHideTimeout?: number;
        openMediaModal: (mediaUrl: string, type: 'image' | 'video') => void; 
    }
}

// Обязательно оставляем export {} в конце
export {};
