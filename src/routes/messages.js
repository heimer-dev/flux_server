'use strict';

const { query, withTransaction } = require('../db');
const { redis, publishToChat } = require('../redis');
const { authenticate, assertChatMember, assertChatAdmin } = require('../middleware/auth');
const { RateLimiterRedis } = require('rate-limiter-flexible');
const config = require('../config');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Fetch aggregated reactions for a list of message IDs.
 * Returns a Map<messageId, Reaction[]>
 */
async function fetchReactions(messageIds) {
  if (!messageIds.length) return new Map();

  const { rows } = await query(
    `SELECT message_id, emoji, COUNT(*) AS count,
            array_agg(user_id::text) AS user_ids
     FROM message_reactions
     WHERE message_id = ANY($1::uuid[])
     GROUP BY message_id, emoji`,
    [messageIds],
  );

  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.message_id)) map.set(r.message_id, []);
    map.get(r.message_id).push({
      emoji: r.emoji,
      count: parseInt(r.count, 10),
      user_ids: r.user_ids,
    });
  }
  return map;
}

/**
 * Hydrate a raw message row into the full Message object.
 * Pass replyRow if available to avoid extra queries.
 */
async function hydrateMessage(row, reactionsMap) {
  const reactions = reactionsMap ? (reactionsMap.get(row.id) || []) : [];

  let replyTo = null;
  if (row.reply_to_id) {
    const replyRes = await query(
      `SELECT m.id, m.chat_id, m.sender_id, m.content, m.type, m.status,
              m.media_url, m.duration_ms, m.reply_to_id, m.client_id, m.created_at,
              u.id AS u_id, u.username, u.display_name, u.avatar_url,
              u.created_at AS u_created_at, u.last_seen_at
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.id = $1`,
      [row.reply_to_id],
    );
    if (replyRes.rows.length) {
      const r = replyRes.rows[0];
      replyTo = {
        id: r.id,
        chat_id: r.chat_id,
        sender_id: r.sender_id,
        sender: {
          id: r.u_id,
          username: r.username,
          display_name: r.display_name,
          avatar_url: r.avatar_url || null,
          created_at: r.u_created_at,
          last_seen_at: r.last_seen_at || null,
        },
        content: r.content,
        type: r.type,
        status: r.status,
        media_url: r.media_url || null,
        duration_ms: r.duration_ms || null,
        reply_to_id: r.reply_to_id || null,
        reply_to: null,
        reactions: [],
        created_at: r.created_at,
        client_id: r.client_id || null,
      };
    }
  }

  return {
    id: row.id,
    chat_id: row.chat_id,
    sender_id: row.sender_id,
    sender: {
      id: row.u_id,
      username: row.u_username,
      display_name: row.u_display_name,
      avatar_url: row.u_avatar_url || null,
      created_at: row.u_created_at,
      last_seen_at: row.u_last_seen_at || null,
    },
    content: row.content,
    type: row.type,
    status: row.status,
    media_url: row.media_url || null,
    duration_ms: row.duration_ms || null,
    reply_to_id: row.reply_to_id || null,
    reply_to: replyTo,
    reactions,
    created_at: row.created_at,
    client_id: row.client_id || null,
  };
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

async function messageRoutes(fastify) {
  const messageLimiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rl:msg',
    points: config.rateLimits.sendMessage.points,
    duration: config.rateLimits.sendMessage.duration,
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/chats/:id/messages
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/chats/:id/messages', { preHandler: authenticate }, async (request, reply) => {
    const { id: chatId } = request.params;
    const limit = Math.min(parseInt(request.query.limit || '50', 10), 100);
    const before = request.query.before || null;

    const member = await assertChatMember(request, reply, chatId);
    if (!member) return;

    let rows;
    if (before) {
      // Get the created_at of the cursor message for keyset pagination
      const cursorRes = await query(
        'SELECT created_at FROM messages WHERE id = $1 AND chat_id = $2',
        [before, chatId],
      );
      if (!cursorRes.rows.length) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Cursor message not found', details: {} },
        });
      }
      const cursorTime = cursorRes.rows[0].created_at;

      const res = await query(
        `SELECT m.id, m.chat_id, m.sender_id, m.content, m.type, m.status,
                m.media_url, m.duration_ms, m.reply_to_id, m.client_id, m.created_at,
                u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name,
                u.avatar_url AS u_avatar_url, u.created_at AS u_created_at, u.last_seen_at AS u_last_seen_at
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.chat_id = $1 AND m.created_at < $2
         ORDER BY m.created_at DESC
         LIMIT $3`,
        [chatId, cursorTime, limit + 1],
      );
      rows = res.rows;
    } else {
      const res = await query(
        `SELECT m.id, m.chat_id, m.sender_id, m.content, m.type, m.status,
                m.media_url, m.duration_ms, m.reply_to_id, m.client_id, m.created_at,
                u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name,
                u.avatar_url AS u_avatar_url, u.created_at AS u_created_at, u.last_seen_at AS u_last_seen_at
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.chat_id = $1
         ORDER BY m.created_at DESC
         LIMIT $2`,
        [chatId, limit + 1],
      );
      rows = res.rows;
    }

    const hasMore = rows.length > limit;
    if (hasMore) rows = rows.slice(0, limit);

    // Re-order oldest-first within the page
    rows.reverse();

    const nextCursor = hasMore ? rows[0].id : null;

    // Fetch reactions in bulk
    const ids = rows.map((r) => r.id);
    const reactionsMap = await fetchReactions(ids);

    const messages = await Promise.all(rows.map((row) => hydrateMessage(row, reactionsMap)));

    return reply.status(200).send({
      messages,
      has_more: hasMore,
      next_cursor: nextCursor,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/chats/:id/messages
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/chats/:id/messages', { preHandler: authenticate }, async (request, reply) => {
    const { id: chatId } = request.params;
    const userId = request.currentUser.id;

    // Rate limit per user
    try {
      await messageLimiter.consume(userId);
    } catch (_) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Message rate limit exceeded (60/min)', details: {} },
      });
    }

    const member = await assertChatMember(request, reply, chatId);
    if (!member) return;

    const { content, type = 'text', client_id, reply_to_id } = request.body || {};

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'content is required', details: {} },
      });
    }

    if (!['text', 'image', 'voice'].includes(type)) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'type must be text, image, or voice', details: {} },
      });
    }

    // Validate reply_to_id if provided
    if (reply_to_id) {
      const replyCheck = await query(
        'SELECT id FROM messages WHERE id = $1 AND chat_id = $2',
        [reply_to_id, chatId],
      );
      if (!replyCheck.rows.length) {
        return reply.status(422).send({
          error: { code: 'VALIDATION_ERROR', message: 'reply_to_id message not found in this chat', details: {} },
        });
      }
    }

    // Determine media_url for image/voice messages
    const mediaUrl = type !== 'text' ? content : null;

    const { rows } = await query(
      `INSERT INTO messages (chat_id, sender_id, content, type, media_url, reply_to_id, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, chat_id, sender_id, content, type, status, media_url, duration_ms,
                 reply_to_id, client_id, created_at`,
      [chatId, userId, content.trim(), type, mediaUrl, reply_to_id || null, client_id || null],
    );

    const msgRow = rows[0];

    // Fetch full message with sender info
    const fullRes = await query(
      `SELECT m.id, m.chat_id, m.sender_id, m.content, m.type, m.status,
              m.media_url, m.duration_ms, m.reply_to_id, m.client_id, m.created_at,
              u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name,
              u.avatar_url AS u_avatar_url, u.created_at AS u_created_at, u.last_seen_at AS u_last_seen_at
       FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.id = $1`,
      [msgRow.id],
    );

    const message = await hydrateMessage(fullRes.rows[0], new Map());

    // Broadcast message.new to all chat members
    await publishToChat(chatId, {
      type: 'message.new',
      payload: { message },
    });

    // Send message.delivered back to the sender
    await publishToChat(chatId, {
      type: 'message.delivered',
      payload: {
        message_id: message.id,
        chat_id: chatId,
        client_id: message.client_id,
      },
      _sender_only: userId,
    });

    return reply.status(201).send({ message });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/chats/:id/messages/read
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/chats/:id/messages/read', { preHandler: authenticate }, async (request, reply) => {
    const { id: chatId } = request.params;
    const userId = request.currentUser.id;

    const member = await assertChatMember(request, reply, chatId);
    if (!member) return;

    const { message_id } = request.body || {};
    if (!message_id) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'message_id is required', details: {} },
      });
    }

    // Verify message exists in this chat
    const msgRes = await query(
      'SELECT id, created_at FROM messages WHERE id = $1 AND chat_id = $2',
      [message_id, chatId],
    );
    if (!msgRes.rows.length) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Message not found', details: {} },
      });
    }

    // Upsert read receipt
    await query(
      `INSERT INTO message_reads (user_id, chat_id, message_id, read_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, chat_id) DO UPDATE
         SET message_id = EXCLUDED.message_id, read_at = EXCLUDED.read_at`,
      [userId, chatId, message_id],
    );

    // Broadcast message.read to all chat members
    await publishToChat(chatId, {
      type: 'message.read',
      payload: {
        chat_id: chatId,
        reader_id: userId,
        up_to_message_id: message_id,
      },
    });

    return reply.status(204).send();
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/chats/:chatId/messages/:messageId/reactions
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/chats/:chatId/messages/:messageId/reactions',
    { preHandler: authenticate },
    async (request, reply) => {
      const { chatId, messageId } = request.params;
      const userId = request.currentUser.id;

      const member = await assertChatMember(request, reply, chatId);
      if (!member) return;

      const { emoji } = request.body || {};
      if (!emoji || typeof emoji !== 'string' || emoji.trim().length === 0) {
        return reply.status(422).send({
          error: { code: 'VALIDATION_ERROR', message: 'emoji is required', details: {} },
        });
      }

      // Verify message exists in this chat
      const msgRes = await query(
        'SELECT id FROM messages WHERE id = $1 AND chat_id = $2',
        [messageId, chatId],
      );
      if (!msgRes.rows.length) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Message not found', details: {} },
        });
      }

      // Idempotent insert
      await query(
        `INSERT INTO message_reactions (message_id, user_id, emoji)
         VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
        [messageId, userId, emoji.trim()],
      );

      // Fetch updated reactions
      const { rows } = await query(
        `SELECT emoji, COUNT(*) AS count, array_agg(user_id::text) AS user_ids
         FROM message_reactions
         WHERE message_id = $1
         GROUP BY emoji`,
        [messageId],
      );

      const reactions = rows.map((r) => ({
        emoji: r.emoji,
        count: parseInt(r.count, 10),
        user_ids: r.user_ids,
      }));

      // Broadcast reaction update
      await publishToChat(chatId, {
        type: 'message.reaction',
        payload: { chat_id: chatId, message_id: messageId, reactions },
      });

      return reply.status(200).send({ reactions });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/v1/chats/:chatId/messages/:messageId/reactions/:emoji
  // -------------------------------------------------------------------------
  fastify.delete(
    '/api/v1/chats/:chatId/messages/:messageId/reactions/:emoji',
    { preHandler: authenticate },
    async (request, reply) => {
      const { chatId, messageId, emoji } = request.params;
      const userId = request.currentUser.id;

      const member = await assertChatMember(request, reply, chatId);
      if (!member) return;

      // Verify message exists
      const msgRes = await query(
        'SELECT id FROM messages WHERE id = $1 AND chat_id = $2',
        [messageId, chatId],
      );
      if (!msgRes.rows.length) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Message not found', details: {} },
        });
      }

      // Check the user actually added this reaction
      const reactionRes = await query(
        'SELECT 1 FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
        [messageId, userId, emoji],
      );
      if (!reactionRes.rows.length) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Reaction not found', details: {} },
        });
      }

      await query(
        'DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
        [messageId, userId, emoji],
      );

      // Fetch updated reactions
      const { rows } = await query(
        `SELECT emoji, COUNT(*) AS count, array_agg(user_id::text) AS user_ids
         FROM message_reactions
         WHERE message_id = $1
         GROUP BY emoji`,
        [messageId],
      );

      const reactions = rows.map((r) => ({
        emoji: r.emoji,
        count: parseInt(r.count, 10),
        user_ids: r.user_ids,
      }));

      // Broadcast reaction update
      await publishToChat(chatId, {
        type: 'message.reaction',
        payload: { chat_id: chatId, message_id: messageId, reactions },
      });

      return reply.status(200).send({ reactions });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/v1/chats/:chatId/messages/:messageId
  // -------------------------------------------------------------------------
  fastify.delete(
    '/api/v1/chats/:chatId/messages/:messageId',
    { preHandler: authenticate },
    async (request, reply) => {
      const { chatId, messageId } = request.params;
      const userId = request.currentUser.id;

      const member = await assertChatMember(request, reply, chatId);
      if (!member) return;

      const msgRes = await query(
        'SELECT id, sender_id FROM messages WHERE id = $1 AND chat_id = $2',
        [messageId, chatId],
      );
      if (!msgRes.rows.length) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Message not found', details: {} },
        });
      }

      const isSender = msgRes.rows[0].sender_id === userId;
      const isAdmin = ['owner', 'admin'].includes(member.role);

      if (!isSender && !isAdmin) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Only the sender or a chat admin can delete this message', details: {} },
        });
      }

      await query('DELETE FROM messages WHERE id = $1', [messageId]);

      // Broadcast deletion
      await publishToChat(chatId, {
        type: 'message.deleted',
        payload: { chat_id: chatId, message_id: messageId },
      });

      return reply.status(204).send();
    },
  );
}

module.exports = messageRoutes;
