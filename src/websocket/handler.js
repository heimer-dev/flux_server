'use strict';

const { query } = require('../db');
const { redis, redisSub } = require('../redis');

// ---------------------------------------------------------------------------
// In-process connection registry
//
// connections: Map<userId, Set<WebSocket>>
//   All active WS connections keyed by user ID (multi-device support).
//
// userChats: Map<userId, Set<chatId>>
//   Chat IDs each connected user is subscribed to.
//
// subscribedChats: Set<chatId>
//   Chat channels this process has asked redisSub to subscribe to.
// ---------------------------------------------------------------------------

const connections = new Map();
const userChats = new Map();
const subscribedChats = new Set();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safe JSON send — no-ops if the socket is not OPEN.
 */
function sendWs(ws, event) {
  try {
    if (ws.readyState === 1 /* WebSocket.OPEN */) {
      ws.send(JSON.stringify(event));
    }
  } catch {
    // swallow send errors; the close handler will clean up
  }
}

function formatUser(row) {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    avatar_url: row.avatar_url || null,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at || null,
  };
}

function addConnection(userId, ws) {
  if (!connections.has(userId)) connections.set(userId, new Set());
  connections.get(userId).add(ws);
}

function removeConnection(userId, ws) {
  const sockets = connections.get(userId);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) connections.delete(userId);
}

function isUserOnline(userId) {
  const sockets = connections.get(userId);
  return !!(sockets && sockets.size > 0);
}

// ---------------------------------------------------------------------------
// Redis pub/sub subscriptions
// ---------------------------------------------------------------------------

/**
 * Subscribe this process to a chat channel (idempotent).
 */
async function subscribeToChat(chatId) {
  if (subscribedChats.has(chatId)) return;
  subscribedChats.add(chatId);
  await redisSub.subscribe(`chat:${chatId}`);
}

/**
 * Subscribe this process to a user's direct channel (idempotent).
 * Used for per-user events such as chat.created and member.added.
 */
async function subscribeToUser(userId) {
  // We track user channels with a different prefix so we don't confuse them
  // with chat channels.  redisSub is the single subscriber client so we call
  // subscribe directly — ioredis deduplicates at the protocol level.
  await redisSub.subscribe(`user:${userId}`);
}

// ---------------------------------------------------------------------------
// Redis pub/sub — inbound dispatch
//
// This single listener handles ALL channels subscribed via redisSub:
//   chat:<chatId>  — events for all members of a chat
//   user:<userId>  — events targeted at a single user
//
// Control fields stripped before delivery to clients:
//   _sender_only   — deliver only to this userId
//   _exclude_sender — deliver to everyone EXCEPT this userId
// ---------------------------------------------------------------------------

redisSub.on('message', (channel, messageStr) => {
  let event;
  try {
    event = JSON.parse(messageStr);
  } catch {
    return;
  }

  if (channel.startsWith('chat:')) {
    const chatId = channel.slice('chat:'.length);
    const { _sender_only, _exclude_sender, ...clientEvent } = event;

    for (const [uid, sockets] of connections.entries()) {
      // Only deliver to users who are subscribed to this chat
      const chats = userChats.get(uid);
      if (!chats || !chats.has(chatId)) continue;

      if (_sender_only && uid !== _sender_only) continue;
      if (_exclude_sender && uid === _exclude_sender) continue;

      for (const ws of sockets) {
        sendWs(ws, clientEvent);
      }
    }
  } else if (channel.startsWith('user:')) {
    const targetUserId = channel.slice('user:'.length);

    // Side-effect: when a member.added event arrives for this user,
    // dynamically subscribe them to the new chat channel.
    if (
      event.type === 'member.added' &&
      event.payload &&
      event.payload.chat_id &&
      connections.has(targetUserId)
    ) {
      const newChatId = event.payload.chat_id;
      if (!userChats.has(targetUserId)) userChats.set(targetUserId, new Set());
      userChats.get(targetUserId).add(newChatId);
      subscribeToChat(newChatId).catch(() => {});
    }

    // Deliver the event (no filtering needed for user channels)
    const sockets = connections.get(targetUserId);
    if (sockets) {
      for (const ws of sockets) {
        sendWs(ws, event);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// broadcastToChat — called by REST routes (and internally) to publish events.
// Redis pub/sub handles cross-instance fanout automatically.
// ---------------------------------------------------------------------------

async function broadcastToChat(chatId, event) {
  await redis.publish(`chat:${chatId}`, JSON.stringify(event));
}

// ---------------------------------------------------------------------------
// Fastify plugin
// ---------------------------------------------------------------------------

async function websocketHandler(fastify) {
  // @fastify/websocket v8+ passes the raw WebSocket socket as the first arg
  fastify.get('/ws', { websocket: true }, async (socket, request) => {
    const ws = socket;

    // ------------------------------------------------------------------
    // Step 1 — Authenticate via ?token= query parameter
    // ------------------------------------------------------------------
    let userId;
    try {
      const token = request.query && request.query.token;
      if (!token) throw new Error('missing token');
      const payload = fastify.jwt.verify(token);
      userId = payload.id;
    } catch {
      sendWs(ws, {
        type: 'error',
        payload: { code: 'UNAUTHORIZED', message: 'Invalid or missing token' },
      });
      ws.close(4001, 'Unauthorized');
      return;
    }

    // ------------------------------------------------------------------
    // Step 2 — Load user record from DB
    // ------------------------------------------------------------------
    let userRow;
    try {
      const { rows } = await query(
        `SELECT id, username, display_name, avatar_url, created_at, last_seen_at
         FROM users WHERE id = $1`,
        [userId],
      );
      if (!rows.length) throw new Error('user not found');
      userRow = rows[0];
    } catch {
      sendWs(ws, {
        type: 'error',
        payload: { code: 'UNAUTHORIZED', message: 'User not found' },
      });
      ws.close(4001, 'Unauthorized');
      return;
    }

    // ------------------------------------------------------------------
    // Step 3 — Register this connection
    // ------------------------------------------------------------------
    addConnection(userId, ws);

    // ------------------------------------------------------------------
    // Step 4 — Subscribe to the user's own direct channel
    // ------------------------------------------------------------------
    await subscribeToUser(userId);

    // ------------------------------------------------------------------
    // Step 5 — Subscribe to all of the user's chat channels
    // ------------------------------------------------------------------
    const { rows: chatRows } = await query(
      'SELECT chat_id FROM chat_members WHERE user_id = $1',
      [userId],
    );

    if (!userChats.has(userId)) userChats.set(userId, new Set());
    const chatSet = userChats.get(userId);

    for (const row of chatRows) {
      chatSet.add(row.chat_id);
      await subscribeToChat(row.chat_id);
    }

    // ------------------------------------------------------------------
    // Step 6 — Broadcast user.online to all chat members
    // ------------------------------------------------------------------
    const onlineEvent = {
      type: 'user.online',
      payload: { user_id: userId },
      _exclude_sender: userId,  // don't echo back to the connecting user
    };
    for (const chatId of chatSet) {
      await broadcastToChat(chatId, onlineEvent);
    }

    fastify.log.info({ userId }, 'WebSocket connected');

    // ------------------------------------------------------------------
    // Step 7 — Handle inbound client messages
    // ------------------------------------------------------------------
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        sendWs(ws, {
          type: 'error',
          payload: { code: 'INVALID_JSON', message: 'Message must be valid JSON' },
        });
        return;
      }

      const { type, chat_id } = msg;

      switch (type) {
        // ----------------------------------------------------------------
        case 'ping':
          sendWs(ws, { type: 'pong' });
          break;

        // ----------------------------------------------------------------
        case 'typing.start':
        case 'typing.stop': {
          if (!chat_id) {
            sendWs(ws, {
              type: 'error',
              payload: { code: 'VALIDATION_ERROR', message: 'chat_id is required' },
            });
            break;
          }

          // Verify user is still a member of this chat
          const memberRes = await query(
            'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
            [chat_id, userId],
          );
          if (!memberRes.rows.length) break;

          if (type === 'typing.start') {
            await broadcastToChat(chat_id, {
              type: 'typing.start',
              payload: { chat_id, user: formatUser(userRow) },
              _exclude_sender: userId,
            });
          } else {
            await broadcastToChat(chat_id, {
              type: 'typing.stop',
              payload: { chat_id, user_id: userId },
              _exclude_sender: userId,
            });
          }
          break;
        }

        // ----------------------------------------------------------------
        default:
          sendWs(ws, {
            type: 'error',
            payload: { code: 'UNKNOWN_EVENT', message: `Unknown event type: ${type}` },
          });
      }
    });

    // ------------------------------------------------------------------
    // Step 8 — Handle disconnect
    // ------------------------------------------------------------------
    ws.on('close', async () => {
      fastify.log.info({ userId }, 'WebSocket disconnected');

      removeConnection(userId, ws);

      // Only perform offline bookkeeping once all connections for this user
      // have closed.
      if (!isUserOnline(userId)) {
        // Update last_seen_at in the database
        let lastSeenAt;
        try {
          const { rows } = await query(
            `UPDATE users SET last_seen_at = NOW()
             WHERE id = $1 RETURNING last_seen_at`,
            [userId],
          );
          lastSeenAt = rows[0] ? rows[0].last_seen_at : new Date().toISOString();
        } catch (err) {
          fastify.log.error({ err, userId }, 'Failed to update last_seen_at');
          lastSeenAt = new Date().toISOString();
        }

        // Broadcast user.offline to all chats this user belonged to
        const chats = userChats.get(userId);
        if (chats) {
          const offlineEvent = {
            type: 'user.offline',
            payload: { user_id: userId, last_seen_at: lastSeenAt },
          };
          for (const chatId of chats) {
            await broadcastToChat(chatId, offlineEvent);
          }
        }

        // Clean up local state for this user
        userChats.delete(userId);
      }
    });

    ws.on('error', (err) => {
      fastify.log.warn({ err, userId }, 'WebSocket socket error');
    });
  });
}

module.exports = websocketHandler;
module.exports.broadcastToChat = broadcastToChat;
module.exports.connections = connections;
