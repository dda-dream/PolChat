// global.d.ts — ФИНАЛЬНАЯ РАБОЧАЯ ВЕРСИЯ

declare global {
    // Глобальные библиотеки
    const io: any;
    const bootstrap: any;
 
    // ====================== ИНТЕРФЕЙСЫ ======================
    interface Message {
        id: string;
        channel_id?: string;
        username: string;
        content: string;
        file_url?: string | null;
        timestamp: string;
        edited?: boolean;
        reactions?: { emoji: string; users: string[] }[];
        read_by?: string[];
        reply_to?: {  
            id: string; 
            username: string; 
            content?: string; 
            is_deleted?: boolean; 
            file_url?: string 
        } | null;
        is_temp?: boolean;
        is_deleted_sender?: boolean;
    }

    interface Window {
        openMediaModal: (mediaUrl: string, type: 'image' | 'video') => void;
    }

    interface User {
        username: string;
        status: 'online' | 'away' | 'offline';
        role: 'user' | 'admin';
        last_seen?: string;
        created_at?: string;
        is_deleted?: boolean;
    }

    interface Channel {
        id: string;
        name: string;
        description?: string;
        is_private?: boolean;
        created_by?: string;
        created_by_display?: string;
        created_by_deleted?: boolean;
        created_at?: string;
    }

    interface DMChannel {
        id: string;
        name: string;
        is_deleted?: boolean;
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
    }
}

// Обязательно оставляем export {} в конце
export {};