-- ============================================
-- Chat Database Initialization Script
-- PostgreSQL
-- ============================================

-- Create database (run as superuser)
-- CREATE DATABASE chat;

\c chat;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- TABLE: users
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    username  VARCHAR(50) PRIMARY KEY,
    password  VARCHAR(256) NOT NULL,
    role      VARCHAR(20) DEFAULT 'user',
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    avatar    VARCHAR(500) DEFAULT 'default.png',
    status    VARCHAR(20) DEFAULT 'offline',
    last_seen TIMESTAMP
);

-- ============================================
-- TABLE: channels
-- ============================================
CREATE TABLE IF NOT EXISTS channels (
    id          VARCHAR(100) PRIMARY KEY,
    name        VARCHAR(200) NOT NULL,
    description TEXT,
    created_by  VARCHAR(50) REFERENCES users(username) ON DELETE SET NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    is_private  BOOLEAN DEFAULT FALSE
);

-- ============================================
-- TABLE: dm_channels (Direct Messages)
-- ============================================
CREATE TABLE IF NOT EXISTS dm_channels (
    id          VARCHAR(100) PRIMARY KEY,
    participants TEXT[] NOT NULL,
    created_by  VARCHAR(50) REFERENCES users(username) ON DELETE SET NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ============================================
-- TABLE: messages
-- ============================================
CREATE TABLE IF NOT EXISTS messages (
    id           VARCHAR(100) PRIMARY KEY,
    channel_id   VARCHAR(100) NOT NULL,
    username     VARCHAR(50) NOT NULL,
    content      TEXT,
    file_url     VARCHAR(1000),
    timestamp    TIMESTAMP NOT NULL DEFAULT NOW(),
    edited       BOOLEAN DEFAULT FALSE,
    edited_at    TIMESTAMP,
    reply_to_id  VARCHAR(100),
    reactions    JSONB DEFAULT '[]'::jsonb,
    read_by      TEXT[] DEFAULT '{}'::text[],
    delivered_to TEXT[] DEFAULT '{}'::text[]
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_username ON messages(username);
CREATE INDEX IF NOT EXISTS idx_messages_reply_to_id ON messages(reply_to_id);
CREATE INDEX IF NOT EXISTS idx_channels_created_at ON channels(created_at);
CREATE INDEX IF NOT EXISTS idx_channels_name ON channels(name);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_messages_channel_timestamp ON messages(channel_id, timestamp DESC);

-- ============================================
-- SEED DATA
-- ============================================
-- Insert default admin user (password: admin123)
INSERT INTO users (username, password, role, created_at, avatar, status)
SELECT 'admin', encode(digest('admin123', 'sha256'), 'hex'), 'admin', NOW(), 'default.png', 'offline'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE username = 'admin');

-- Insert general channel
INSERT INTO channels (id, name, description, created_by, created_at, is_private)
SELECT 'general', 'Общий', 'Общий канал для всех пользователей', 'admin', NOW(), FALSE
WHERE NOT EXISTS (SELECT 1 FROM channels WHERE id = 'general');

-- ============================================
-- DONE
-- ============================================
