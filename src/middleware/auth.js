'use strict';

const { query } = require('../db');

/**
 * Fastify preHandler that validates the JWT and attaches the user record.
 * Sends a standard error response if unauthenticated.
 */
async function authenticate(request, reply) {
  try {
    await request.jwtVerify();
  } catch (err) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Missing or invalid authorization token',
        details: {},
      },
    });
  }

  // Attach full user record so routes don't have to re-fetch
  const { rows } = await query(
    'SELECT id, username, display_name, avatar_url, created_at, last_seen_at FROM users WHERE id = $1',
    [request.user.id],
  );

  if (!rows.length) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'User not found',
        details: {},
      },
    });
  }

  request.currentUser = rows[0];
}

/**
 * Helper: assert the current user is a member of a chat.
 * Returns the membership row or throws a 403/404 reply.
 */
async function assertChatMember(request, reply, chatId) {
  // First check the chat exists
  const chatRes = await query('SELECT id FROM chats WHERE id = $1', [chatId]);
  if (!chatRes.rows.length) {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Chat not found', details: {} },
    });
    return null;
  }

  const memberRes = await query(
    'SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2',
    [chatId, request.currentUser.id],
  );

  if (!memberRes.rows.length) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'You are not a member of this chat', details: {} },
    });
    return null;
  }

  return memberRes.rows[0];
}

/**
 * Helper: assert current user has owner or admin role in a chat.
 */
async function assertChatAdmin(request, reply, chatId) {
  const member = await assertChatMember(request, reply, chatId);
  if (!member) return null;

  if (!['owner', 'admin'].includes(member.role)) {
    reply.status(403).send({
      error: { code: 'FORBIDDEN', message: 'Owner or admin role required', details: {} },
    });
    return null;
  }

  return member;
}

module.exports = { authenticate, assertChatMember, assertChatAdmin };
