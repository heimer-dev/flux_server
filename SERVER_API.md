# Flux Server API Specification

## Overview

RESTful HTTP API + WebSocket endpoint for the **Flux** chat application.

- Base URL: configurable per deployment (e.g. `https://chat.example.com`)
- All REST endpoints are prefixed with `/api/v1`
- Health check at `/api/health` (no prefix, no auth)
- JSON request/response bodies
- UTF-8 encoding

---

## Authentication

JWT Bearer tokens. Access tokens expire after **7 days**.
Refresh tokens stored server-side, valid **30 days**.

**Header format:**
```
Authorization: Bearer <token>
```

---

## Data Models

### User
```json
{
  "id": "uuid-v4",
  "username": "string (3–32 chars, [a-z0-9_.\\-])",
  "display_name": "string (1–64 chars)",
  "avatar_url": "string | null",
  "created_at": "ISO8601",
  "last_seen_at": "ISO8601 | null"
}
```

### Chat
```json
{
  "id": "uuid-v4",
  "type": "direct | group",
  "name": "string | null",
  "avatar_url": "string | null",
  "created_by": "uuid",
  "created_at": "ISO8601",
  "member_count": 2,
  "last_message": "Message | null",
  "unread_count": 0,
  "members": ["User"]
}
```

### Message
```json
{
  "id": "uuid-v4",
  "chat_id": "uuid",
  "sender_id": "uuid",
  "sender": "User",
  "content": "string",
  "type": "text | image | voice",
  "status": "sent | delivered | read",
  "media_url": "string | null",
  "duration_ms": "integer | null",
  "reply_to_id": "uuid | null",
  "reply_to": "Message | null",
  "reactions": [
    {
      "emoji": "string",
      "count": 2,
      "user_ids": ["uuid"]
    }
  ],
  "created_at": "ISO8601",
  "client_id": "string | null"
}
```

### ChatMember
```json
{
  "user_id": "uuid",
  "chat_id": "uuid",
  "role": "owner | admin | member",
  "joined_at": "ISO8601"
}
```

---

## REST Endpoints

### Health

```
GET /api/health
Response 200: { "status": "ok", "version": "1.0.0" }
```

---

### Auth

```
POST /api/v1/auth/register
Body: { "username": "string", "display_name": "string", "password": "string" }
Response 201: { "user": User, "token": "jwt", "refresh_token": "string" }
Errors: 409 username taken, 422 validation error
```

```
POST /api/v1/auth/login
Body: { "username": "string", "password": "string" }
Response 200: { "user": User, "token": "jwt", "refresh_token": "string" }
Errors: 401 invalid credentials
```

```
POST /api/v1/auth/refresh
Body: { "refresh_token": "string" }
Response 200: { "token": "jwt", "refresh_token": "string" }
Errors: 401 invalid or expired refresh token
```

```
POST /api/v1/auth/logout
Auth required.
Body: { "refresh_token": "string" }
Response 204
```

---

### Users

```
GET /api/v1/users/check?username=<string>
Response 200: { "available": true | false }
```

```
GET /api/v1/users/search?q=<string>&limit=20
Auth required.
Response 200: { "users": [User] }
```

```
GET /api/v1/users/me
Auth required.
Response 200: { "user": User }
```

```
PATCH /api/v1/users/me
Auth required.
Body: { "display_name": "string" }
Response 200: { "user": User }
```

```
POST /api/v1/users/me/avatar
Auth required.
Content-Type: multipart/form-data
Field: avatar (image/jpeg or image/png, max 5 MB)
Response 200: { "avatar_url": "string" }
Note: Resize to max 256×256 px server-side. Serve with Cache-Control: public, max-age=86400
```

```
GET /api/v1/users/:id
Auth required.
Response 200: { "user": User }
Errors: 404 not found
```

---

### Chats

```
GET /api/v1/chats
Auth required.
Response 200: { "chats": [Chat] }
Note: Ordered by last_message.created_at desc.
```

```
POST /api/v1/chats/direct
Auth required.
Body: { "user_id": "uuid" }
Response 201: { "chat": Chat }
Note: If a direct chat already exists between these two users, return 200 with the existing chat.
```

```
POST /api/v1/chats/group
Auth required.
Body: { "name": "string", "member_ids": ["uuid", ...] }
Response 201: { "chat": Chat }
Note: The requesting user is automatically added as owner.
```

```
GET /api/v1/chats/:id
Auth required. User must be a member.
Response 200: { "chat": Chat, "members": [User] }
Errors: 403 not a member, 404 not found
```

```
PATCH /api/v1/chats/:id
Auth required. User must be owner or admin.
Body: { "name": "string" }
Response 200: { "chat": Chat }
```

---

### Members

```
POST /api/v1/chats/:id/members
Auth required. User must be owner or admin.
Body: { "user_id": "uuid" }
Response 201: { "member": ChatMember }
```

```
DELETE /api/v1/chats/:id/members/:userId
Auth required. Owner/admin can remove anyone. Members can only remove themselves.
Response 204
```

---

### Messages

```
GET /api/v1/chats/:id/messages?limit=50&before=<message_id>
Auth required. User must be a member.
Response 200: {
  "messages": [Message],
  "has_more": true | false,
  "next_cursor": "message_id | null"
}
Note: Messages ordered oldest-first within the page. Cursor-based pagination.
```

```
POST /api/v1/chats/:id/messages
Auth required. User must be a member.
Body: {
  "content": "string",        // For text: the text. For image/voice: the media URL.
  "type": "text | image | voice",
  "client_id": "string",      // Optional. Echoed back for optimistic update matching.
  "reply_to_id": "uuid"       // Optional.
}
Response 201: { "message": Message }
Rate limit: 60/minute per user
```

```
POST /api/v1/chats/:id/messages/read
Auth required.
Body: { "message_id": "uuid" }
Response 204
Note: Marks this message AND all prior messages in the chat as read for the requesting user.
      Broadcasts message.read WS event to all chat members.
```

```
POST /api/v1/chats/:chatId/messages/:messageId/reactions
Auth required. User must be a member.
Body: { "emoji": "string" }
Response 200: { "reactions": [Reaction] }
Note: If user already reacted with this emoji, this is a no-op (idempotent).
```

```
DELETE /api/v1/chats/:chatId/messages/:messageId/reactions/:emoji
Auth required. User must have added this reaction.
Response 200: { "reactions": [Reaction] }
```

```
DELETE /api/v1/chats/:chatId/messages/:messageId
Auth required. User must be the sender or a chat admin/owner.
Response 204
```

---

### Media Upload

```
POST /api/v1/media
Auth required.
Content-Type: multipart/form-data
Field: file (image/jpeg, image/png, audio/m4a, audio/mpeg — max 50 MB)
Response 200: { "url": "string" }
Note: Returns a fully qualified URL the client can use directly in message content.
      Served with Cache-Control: public, max-age=86400
```

---

## WebSocket Endpoint

```
ws(s)://<host>/ws
```

Connect with query param: `?token=<jwt>`

One persistent connection per user handles all chats.

### Client → Server messages

```json
{ "type": "typing.start", "chat_id": "uuid" }
{ "type": "typing.stop", "chat_id": "uuid" }
{ "type": "ping" }
```

### Server → Client events

```json
{ "type": "pong" }

{
  "type": "message.new",
  "payload": { "message": Message }
}

{
  "type": "message.delivered",
  "payload": {
    "message_id": "uuid",
    "chat_id": "uuid",
    "client_id": "string | null"
  }
}

{
  "type": "message.read",
  "payload": {
    "chat_id": "uuid",
    "reader_id": "uuid",
    "up_to_message_id": "uuid"
  }
}

{
  "type": "message.reaction",
  "payload": {
    "chat_id": "uuid",
    "message_id": "uuid",
    "reactions": [Reaction]
  }
}

{
  "type": "message.deleted",
  "payload": {
    "chat_id": "uuid",
    "message_id": "uuid"
  }
}

{
  "type": "typing.start",
  "payload": {
    "chat_id": "uuid",
    "user": User
  }
}

{
  "type": "typing.stop",
  "payload": {
    "chat_id": "uuid",
    "user_id": "uuid"
  }
}

{
  "type": "chat.created",
  "payload": { "chat": Chat }
}

{
  "type": "member.added",
  "payload": {
    "chat_id": "uuid",
    "user": User
  }
}

{
  "type": "member.removed",
  "payload": {
    "chat_id": "uuid",
    "user_id": "uuid"
  }
}

{
  "type": "user.online",
  "payload": { "user_id": "uuid" }
}

{
  "type": "user.offline",
  "payload": {
    "user_id": "uuid",
    "last_seen_at": "ISO8601"
  }
}
```

### WebSocket delivery semantics

- `message.new` is sent to all **online** members of the chat.
- `message.delivered` is sent back only to the **sender** when the server has persisted the message.
- When a user **comes online**, the server should send them any `message.new` events they missed while offline (alternatively, the client re-fetches on reconnect).
- `typing.start`/`typing.stop` are forwarded to all **other** online members of the chat.

---

## Error Response Format

All errors follow this structure:

```json
{
  "error": {
    "code": "string",
    "message": "string",
    "details": {}
  }
}
```

| HTTP Status | Meaning |
|---|---|
| 400 | Bad request / malformed body |
| 401 | Unauthenticated (missing or invalid token) |
| 403 | Forbidden (authenticated but not allowed) |
| 404 | Resource not found |
| 409 | Conflict (e.g. username taken) |
| 422 | Validation error |
| 429 | Rate limited |
| 500 | Internal server error |

---

## Rate Limits

| Endpoint | Limit |
|---|---|
| `POST /api/v1/chats/:id/messages` | 60/minute per user |
| `POST /api/v1/auth/register` | 5/hour per IP |
| `POST /api/v1/auth/login` | 10/minute per IP |
| `POST /api/v1/users/me/avatar` | 10/hour per user |
| `POST /api/v1/media` | 30/hour per user |

---

## Implementation Notes

- Use **UUIDs v4** for all IDs.
- Store passwords with **bcrypt** (cost factor ≥ 12).
- JWT tokens should be signed with **HS256** or **RS256**.
- Refresh tokens should be stored server-side and invalidated on logout.
- Avatar images should be resized to **max 256×256 px** on upload.
- Media files should be served from a CDN or object storage (e.g. MinIO / S3).
- WebSocket connections should be tracked per user ID to enable fanout to multiple devices.
- Recommended tech stack: Node.js (Fastify/Express) or Go (Gin/Fiber) with PostgreSQL + Redis for pub/sub fanout.
