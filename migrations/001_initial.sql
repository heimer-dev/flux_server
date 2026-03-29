-- Flux Chat Server — Initial Schema
-- Idempotent: safe to run on every app start (uses IF NOT EXISTS throughout).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  username      VARCHAR(32)  UNIQUE NOT NULL,
  display_name  VARCHAR(64)  NOT NULL,
  password_hash TEXT         NOT NULL,
  avatar_url    TEXT,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Refresh tokens  (server-side storage; also mirrored in Redis for fast lookup)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token      TEXT        PRIMARY KEY,
  user_id    UUID        REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------------------
-- Chats
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chats (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  type       VARCHAR(10) NOT NULL CHECK (type IN ('direct','group')),
  name       VARCHAR(100),
  avatar_url TEXT,
  created_by UUID        REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Chat members
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chat_members (
  user_id   UUID        REFERENCES users(id)  ON DELETE CASCADE,
  chat_id   UUID        REFERENCES chats(id)  ON DELETE CASCADE,
  role      VARCHAR(10) NOT NULL DEFAULT 'member'
                        CHECK (role IN ('owner','admin','member')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, chat_id)
);

-- ---------------------------------------------------------------------------
-- Messages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS messages (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  chat_id     UUID        REFERENCES chats(id)    ON DELETE CASCADE,
  sender_id   UUID        REFERENCES users(id),
  content     TEXT        NOT NULL,
  type        VARCHAR(10) NOT NULL DEFAULT 'text'
                          CHECK (type IN ('text','image','voice')),
  status      VARCHAR(10) NOT NULL DEFAULT 'sent'
                          CHECK (status IN ('sent','delivered','read')),
  media_url   TEXT,
  duration_ms INTEGER,
  reply_to_id UUID        REFERENCES messages(id),
  client_id   TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Message reactions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id UUID  REFERENCES messages(id) ON DELETE CASCADE,
  user_id    UUID  REFERENCES users(id)    ON DELETE CASCADE,
  emoji      TEXT  NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

-- ---------------------------------------------------------------------------
-- Message reads  (tracks the highest read message per user per chat)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS message_reads (
  user_id    UUID        REFERENCES users(id)    ON DELETE CASCADE,
  chat_id    UUID        REFERENCES chats(id)    ON DELETE CASCADE,
  message_id UUID        REFERENCES messages(id) ON DELETE CASCADE,
  read_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, chat_id)
);

-- ---------------------------------------------------------------------------
-- Indexes (IF NOT EXISTS requires PostgreSQL 9.5+)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_messages_chat_id      ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_members_user     ON chat_members(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_members_chat     ON chat_members(chat_id);
CREATE INDEX IF NOT EXISTS idx_message_reads_user    ON message_reads(user_id, chat_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user   ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_users_username        ON users(username);
