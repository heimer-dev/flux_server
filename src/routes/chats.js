'use strict';

const { query, withTransaction } = require('../db');
const { publishToChat, publishToUser } = require('../redis');
const { authenticate, assertChatMember, assertChatAdmin } = require('../middleware/auth');

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
 * Build a full Chat object from a raw DB row, including last_message and
 * unread_count for the given userId.
 */
async function buildChatObject(chatRow, userId) {
  // Fetch members
  const membersRes = await query(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.created_at, u.last_seen_at,
            cm.role, cm.joined_at
     FROM chat_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.chat_id = $1`,
    [chatRow.id],
  );

  // Member count
  const memberCount = membersRes.rows.length;

  // Last message
  const lastMsgRes = await query(
    `SELECT m.id, m.chat_id, m.sender_id, m.content, m.type, m.status,
            m.media_url, m.duration_ms, m.reply_to_id, m.client_id, m.created_at,
            u.id AS u_id, u.username AS u_username, u.display_name AS u_display_name,
            u.avatar_url AS u_avatar_url, u.created_at AS u_created_at, u.last_seen_at AS u_last_seen_at
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.chat_id = $1
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [chatRow.id],
  );

  let lastMessage = null;
  if (lastMsgRes.rows.length) {
    const r = lastMsgRes.rows[0];
    lastMessage = {
      id: r.id,
      chat_id: r.chat_id,
      sender_id: r.sender_id,
      sender: {
        id: r.u_id,
        username: r.u_username,
        display_name: r.u_display_name,
        avatar_url: r.u_avatar_url || null,
        created_at: r.u_created_at,
        last_seen_at: r.u_last_seen_at || null,
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

  // Unread count: messages from others that arrived after the user's last read timestamp
  const unreadRes = await query(
    `SELECT COUNT(*) AS cnt FROM messages m
     WHERE m.chat_id = $1
       AND m.sender_id != $2
       AND m.created_at > COALESCE(
         (SELECT mr.read_at FROM message_reads mr WHERE mr.chat_id = $1 AND mr.user_id = $2),
         '1970-01-01'::TIMESTAMPTZ
       )`,
    [chatRow.id, userId],
  );
  const unreadCount = parseInt(unreadRes.rows[0].cnt, 10);

  return {
    id: chatRow.id,
    type: chatRow.type,
    name: chatRow.name || null,
    avatar_url: chatRow.avatar_url || null,
    created_by: chatRow.created_by,
    created_at: chatRow.created_at,
    member_count: memberCount,
    last_message: lastMessage,
    unread_count: unreadCount,
    members: membersRes.rows.map(formatUser),
  };
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

async function chatRoutes(fastify) {
  // -------------------------------------------------------------------------
  // GET /api/v1/chats
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/chats', { preHandler: authenticate }, async (request, reply) => {
    const userId = request.currentUser.id;

    // Get all chats the user belongs to
    const { rows: chatRows } = await query(
      `SELECT c.id, c.type, c.name, c.avatar_url, c.created_by, c.created_at
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id
       WHERE cm.user_id = $1`,
      [userId],
    );

    // Build full objects in parallel
    const chats = await Promise.all(chatRows.map((row) => buildChatObject(row, userId)));

    // Sort by last_message desc, then created_at desc
    chats.sort((a, b) => {
      const aTime = a.last_message ? new Date(a.last_message.created_at) : new Date(a.created_at);
      const bTime = b.last_message ? new Date(b.last_message.created_at) : new Date(b.created_at);
      return bTime - aTime;
    });

    return reply.status(200).send({ chats });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/chats/direct
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/chats/direct', { preHandler: authenticate }, async (request, reply) => {
    const { user_id } = request.body || {};
    const myId = request.currentUser.id;

    if (!user_id) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'user_id is required', details: {} },
      });
    }

    if (user_id === myId) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'Cannot create a direct chat with yourself', details: {} },
      });
    }

    // Check target user exists
    const targetRes = await query('SELECT id FROM users WHERE id = $1', [user_id]);
    if (!targetRes.rows.length) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Target user not found', details: {} },
      });
    }

    // Check if a direct chat already exists between these two users
    const existingRes = await query(
      `SELECT c.id, c.type, c.name, c.avatar_url, c.created_by, c.created_at
       FROM chats c
       JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1
       JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2
       WHERE c.type = 'direct'`,
      [myId, user_id],
    );

    if (existingRes.rows.length) {
      const chat = await buildChatObject(existingRes.rows[0], myId);
      return reply.status(200).send({ chat });
    }

    // Create new direct chat
    const chatRow = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO chats (type, created_by) VALUES ('direct', $1)
         RETURNING id, type, name, avatar_url, created_by, created_at`,
        [myId],
      );
      const chat = rows[0];

      await client.query(
        `INSERT INTO chat_members (user_id, chat_id, role) VALUES ($1, $2, 'owner'), ($3, $2, 'member')`,
        [myId, chat.id, user_id],
      );

      return chat;
    });

    const chat = await buildChatObject(chatRow, myId);

    // Notify both users
    await publishToUser(myId, { type: 'chat.created', payload: { chat } });
    await publishToUser(user_id, { type: 'chat.created', payload: { chat } });

    return reply.status(201).send({ chat });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/chats/group
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/chats/group', { preHandler: authenticate }, async (request, reply) => {
    const { name, member_ids } = request.body || {};
    const myId = request.currentUser.id;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'name is required', details: {} },
      });
    }

    if (!Array.isArray(member_ids) || member_ids.length === 0) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'member_ids must be a non-empty array', details: {} },
      });
    }

    // Deduplicate and exclude self (self is added as owner below)
    const otherIds = [...new Set(member_ids.filter((id) => id !== myId))];

    // Verify all member IDs exist
    if (otherIds.length > 0) {
      const checkRes = await query(
        `SELECT id FROM users WHERE id = ANY($1::uuid[])`,
        [otherIds],
      );
      if (checkRes.rows.length !== otherIds.length) {
        return reply.status(422).send({
          error: { code: 'VALIDATION_ERROR', message: 'One or more member_ids do not exist', details: {} },
        });
      }
    }

    const chatRow = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO chats (type, name, created_by) VALUES ('group', $1, $2)
         RETURNING id, type, name, avatar_url, created_by, created_at`,
        [name.trim(), myId],
      );
      const chat = rows[0];

      // Insert creator as owner
      await client.query(
        `INSERT INTO chat_members (user_id, chat_id, role) VALUES ($1, $2, 'owner')`,
        [myId, chat.id],
      );

      // Insert other members
      for (const memberId of otherIds) {
        await client.query(
          `INSERT INTO chat_members (user_id, chat_id, role) VALUES ($1, $2, 'member')`,
          [memberId, chat.id],
        );
      }

      return chat;
    });

    const chat = await buildChatObject(chatRow, myId);

    // Notify all members
    const allMemberIds = [myId, ...otherIds];
    await Promise.all(
      allMemberIds.map((uid) => publishToUser(uid, { type: 'chat.created', payload: { chat } })),
    );

    return reply.status(201).send({ chat });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/chats/:id
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/chats/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params;
    const userId = request.currentUser.id;

    const member = await assertChatMember(request, reply, id);
    if (!member) return;

    const chatRes = await query(
      `SELECT id, type, name, avatar_url, created_by, created_at FROM chats WHERE id = $1`,
      [id],
    );

    const chat = await buildChatObject(chatRes.rows[0], userId);

    return reply.status(200).send({ chat, members: chat.members });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/chats/:id
  // -------------------------------------------------------------------------
  fastify.patch('/api/v1/chats/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params;

    const admin = await assertChatAdmin(request, reply, id);
    if (!admin) return;

    const { name } = request.body || {};

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'name is required', details: {} },
      });
    }

    const { rows } = await query(
      `UPDATE chats SET name = $1 WHERE id = $2
       RETURNING id, type, name, avatar_url, created_by, created_at`,
      [name.trim(), id],
    );

    const chat = await buildChatObject(rows[0], request.currentUser.id);

    return reply.status(200).send({ chat });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/chats/:id/members
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/chats/:id/members', { preHandler: authenticate }, async (request, reply) => {
    const { id: chatId } = request.params;

    const admin = await assertChatAdmin(request, reply, chatId);
    if (!admin) return;

    const { user_id } = request.body || {};

    if (!user_id) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'user_id is required', details: {} },
      });
    }

    // Check target user exists
    const userRes = await query(
      'SELECT id, username, display_name, avatar_url, created_at, last_seen_at FROM users WHERE id = $1',
      [user_id],
    );
    if (!userRes.rows.length) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'User not found', details: {} },
      });
    }

    // Check if already a member
    const existingRes = await query(
      'SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, user_id],
    );
    if (existingRes.rows.length) {
      return reply.status(409).send({
        error: { code: 'CONFLICT', message: 'User is already a member of this chat', details: {} },
      });
    }

    const { rows } = await query(
      `INSERT INTO chat_members (user_id, chat_id, role)
       VALUES ($1, $2, 'member')
       RETURNING user_id, chat_id, role, joined_at`,
      [user_id, chatId],
    );

    const member = rows[0];

    // Broadcast member.added to chat
    const addedUser = formatUser(userRes.rows[0]);
    await publishToChat(chatId, {
      type: 'member.added',
      payload: { chat_id: chatId, user: addedUser },
    });

    // Also notify the new member directly so they subscribe to the chat
    await publishToUser(user_id, {
      type: 'member.added',
      payload: { chat_id: chatId, user: addedUser },
    });

    return reply.status(201).send({ member });
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/chats/:id/members/:userId
  // -------------------------------------------------------------------------
  fastify.delete(
    '/api/v1/chats/:id/members/:userId',
    { preHandler: authenticate },
    async (request, reply) => {
      const { id: chatId, userId: targetUserId } = request.params;
      const myId = request.currentUser.id;

      // Verify chat exists and caller is a member
      const callerMemberRes = await query(
        'SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2',
        [chatId, myId],
      );

      const chatRes = await query('SELECT id FROM chats WHERE id = $1', [chatId]);
      if (!chatRes.rows.length) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Chat not found', details: {} },
        });
      }

      if (!callerMemberRes.rows.length) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You are not a member of this chat', details: {} },
        });
      }

      const callerRole = callerMemberRes.rows[0].role;
      const isSelf = targetUserId === myId;
      const isAdmin = ['owner', 'admin'].includes(callerRole);

      // Members can only remove themselves; admins/owners can remove anyone
      if (!isSelf && !isAdmin) {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'You can only remove yourself', details: {} },
        });
      }

      // Check target is actually a member
      const targetRes = await query(
        'SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2',
        [chatId, targetUserId],
      );
      if (!targetRes.rows.length) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Target user is not a member of this chat', details: {} },
        });
      }

      await query(
        'DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2',
        [chatId, targetUserId],
      );

      // Broadcast member.removed
      await publishToChat(chatId, {
        type: 'member.removed',
        payload: { chat_id: chatId, user_id: targetUserId },
      });

      return reply.status(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/v1/chats/:id/messages  — clear all messages in a chat
  // -------------------------------------------------------------------------
  fastify.delete('/api/v1/chats/:id/messages', { preHandler: authenticate }, async (request, reply) => {
    const { id: chatId } = request.params;

    const admin = await assertChatAdmin(request, reply, chatId);
    if (!admin) return;

    await query('DELETE FROM messages WHERE chat_id = $1', [chatId]);

    // Broadcast chat.cleared so clients remove messages from UI
    await publishToChat(chatId, {
      type: 'chat.cleared',
      payload: { chat_id: chatId },
    });

    return reply.status(204).send();
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/chats/:id  — delete entire chat
  // -------------------------------------------------------------------------
  fastify.delete('/api/v1/chats/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id: chatId } = request.params;

    const admin = await assertChatAdmin(request, reply, chatId);
    if (!admin) return;

    // Collect member IDs before deleting so we can notify them
    const { rows: memberRows } = await query(
      'SELECT user_id FROM chat_members WHERE chat_id = $1',
      [chatId],
    );
    const memberIds = memberRows.map((r) => r.user_id);

    // Broadcast chat.deleted to all members before the rows are gone
    await publishToChat(chatId, {
      type: 'chat.deleted',
      payload: { chat_id: chatId },
    });

    // Delete chat — cascades to chat_members, messages, message_reads, message_reactions
    await query('DELETE FROM chats WHERE id = $1', [chatId]);

    // Also notify each member via their personal channel in case they are not
    // subscribed to the chat channel anymore (e.g. after leaving)
    await Promise.all(
      memberIds.map((uid) =>
        publishToUser(uid, { type: 'chat.deleted', payload: { chat_id: chatId } }),
      ),
    );

    return reply.status(204).send();
  });
}

module.exports = chatRoutes;
