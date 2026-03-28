'use strict';

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const { RateLimiterRedis } = require('rate-limiter-flexible');

const { query } = require('../db');
const { redis } = require('../redis');
const { authenticate } = require('../middleware/auth');
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

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

async function userRoutes(fastify) {
  const avatarLimiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rl:avatar',
    points: config.rateLimits.uploadAvatar.points,
    duration: config.rateLimits.uploadAvatar.duration,
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/users/check?username=
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/users/check', async (request, reply) => {
    const { username } = request.query;

    if (!username) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'username query param is required', details: {} },
      });
    }

    const { rows } = await query('SELECT id FROM users WHERE username = $1', [username]);
    return reply.status(200).send({ available: rows.length === 0 });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/users/search?q=&limit=20
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/users/search', { preHandler: authenticate }, async (request, reply) => {
    const q = (request.query.q || '').trim();
    const limit = Math.min(parseInt(request.query.limit || '20', 10), 50);

    if (!q) {
      return reply.status(200).send({ users: [] });
    }

    const pattern = `%${q}%`;
    const { rows } = await query(
      `SELECT id, username, display_name, avatar_url, created_at, last_seen_at
       FROM users
       WHERE (username ILIKE $1 OR display_name ILIKE $1) AND id != $2
       ORDER BY username
       LIMIT $3`,
      [pattern, request.currentUser.id, limit],
    );

    return reply.status(200).send({ users: rows.map(formatUser) });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/users/me
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/users/me', { preHandler: authenticate }, async (request, reply) => {
    return reply.status(200).send({ user: formatUser(request.currentUser) });
  });

  // -------------------------------------------------------------------------
  // PATCH /api/v1/users/me
  // -------------------------------------------------------------------------
  fastify.patch('/api/v1/users/me', { preHandler: authenticate }, async (request, reply) => {
    const { display_name } = request.body || {};

    if (!display_name) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'display_name is required', details: {} },
      });
    }

    if (display_name.length < 1 || display_name.length > 64) {
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'display_name must be 1–64 characters',
          details: { field: 'display_name' },
        },
      });
    }

    const { rows } = await query(
      `UPDATE users SET display_name = $1 WHERE id = $2
       RETURNING id, username, display_name, avatar_url, created_at, last_seen_at`,
      [display_name, request.currentUser.id],
    );

    return reply.status(200).send({ user: formatUser(rows[0]) });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/users/me/avatar
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/users/me/avatar', { preHandler: authenticate }, async (request, reply) => {
    try {
      await avatarLimiter.consume(request.currentUser.id);
    } catch (_) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Too many avatar uploads. Try again later.', details: {} },
      });
    }

    let data;
    try {
      data = await request.file();
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Expected multipart/form-data with avatar field', details: {} },
      });
    }

    if (!data) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'No file uploaded', details: {} },
      });
    }

    if (!config.uploads.allowedAvatarMimes.includes(data.mimetype)) {
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Avatar must be image/jpeg or image/png',
          details: { field: 'avatar' },
        },
      });
    }

    // Buffer the upload
    const chunks = [];
    let totalSize = 0;
    for await (const chunk of data.file) {
      totalSize += chunk.length;
      if (totalSize > config.uploads.maxAvatarSize) {
        return reply.status(422).send({
          error: {
            code: 'FILE_TOO_LARGE',
            message: 'Avatar must be under 5 MB',
            details: {},
          },
        });
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    // Resize to 256×256 (cover crop)
    const dim = config.uploads.avatarDimension;
    let resized;
    try {
      resized = await sharp(buffer)
        .resize(dim, dim, { fit: 'cover', position: 'center' })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch (err) {
      return reply.status(422).send({
        error: { code: 'INVALID_IMAGE', message: 'Could not process image', details: {} },
      });
    }

    // Ensure upload directory exists
    const uploadDir = path.join(config.uploadDir, 'avatars');
    fs.mkdirSync(uploadDir, { recursive: true });

    const filename = `${uuidv4()}.jpg`;
    const filePath = path.join(uploadDir, filename);
    fs.writeFileSync(filePath, resized);

    const avatarUrl = `${config.baseUrl}/uploads/avatars/${filename}`;

    const { rows } = await query(
      `UPDATE users SET avatar_url = $1 WHERE id = $2
       RETURNING id, username, display_name, avatar_url, created_at, last_seen_at`,
      [avatarUrl, request.currentUser.id],
    );

    return reply
      .header('Cache-Control', 'public, max-age=86400')
      .status(200)
      .send({ avatar_url: rows[0].avatar_url });
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/users/:id
  // -------------------------------------------------------------------------
  fastify.get('/api/v1/users/:id', { preHandler: authenticate }, async (request, reply) => {
    const { id } = request.params;

    const { rows } = await query(
      'SELECT id, username, display_name, avatar_url, created_at, last_seen_at FROM users WHERE id = $1',
      [id],
    );

    if (!rows.length) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'User not found', details: {} },
      });
    }

    return reply.status(200).send({ user: formatUser(rows[0]) });
  });
}

module.exports = userRoutes;
