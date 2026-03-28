'use strict';

const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const { RateLimiterRedis } = require('rate-limiter-flexible');

const { query, withTransaction } = require('../db');
const { redis, storeRefreshToken, getRefreshToken, deleteRefreshToken } = require('../redis');
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

function rateLimitError(reply) {
  return reply.status(429).send({
    error: {
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please try again later.',
      details: {},
    },
  });
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

async function authRoutes(fastify) {
  // Instantiate rate limiters (Redis-backed so they survive restarts / scale-out)
  const registerLimiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rl:register',
    points: config.rateLimits.register.points,
    duration: config.rateLimits.register.duration,
  });

  const loginLimiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rl:login',
    points: config.rateLimits.login.points,
    duration: config.rateLimits.login.duration,
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/register
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/auth/register', async (request, reply) => {
    const ip = request.ip;
    try {
      await registerLimiter.consume(ip);
    } catch (_) {
      return rateLimitError(reply);
    }

    const { username, display_name, password } = request.body || {};

    // Validation
    if (!username || !display_name || !password) {
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'username, display_name, and password are required',
          details: {},
        },
      });
    }

    if (!/^[a-z0-9_.\\-]{3,32}$/.test(username)) {
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'username must be 3–32 characters and match [a-z0-9_.-]',
          details: { field: 'username' },
        },
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

    if (password.length < 6) {
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'password must be at least 6 characters',
          details: { field: 'password' },
        },
      });
    }

    // Check uniqueness
    const existing = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length) {
      return reply.status(409).send({
        error: {
          code: 'USERNAME_TAKEN',
          message: 'Username is already taken',
          details: { field: 'username' },
        },
      });
    }

    const passwordHash = await bcrypt.hash(password, config.bcrypt.costFactor);

    const { rows } = await query(
      `INSERT INTO users (username, display_name, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, username, display_name, avatar_url, created_at, last_seen_at`,
      [username, display_name, passwordHash],
    );

    const user = rows[0];

    // Issue tokens
    const token = fastify.jwt.sign(
      { id: user.id },
      { expiresIn: config.jwt.accessTokenTtl },
    );
    const refreshToken = uuidv4();
    await storeRefreshToken(refreshToken, user.id, config.jwt.refreshTokenTtl);

    return reply.status(201).send({
      user: formatUser(user),
      token,
      refresh_token: refreshToken,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/login
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/auth/login', async (request, reply) => {
    const ip = request.ip;
    try {
      await loginLimiter.consume(ip);
    } catch (_) {
      return rateLimitError(reply);
    }

    const { username, password } = request.body || {};

    if (!username || !password) {
      return reply.status(422).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'username and password are required',
          details: {},
        },
      });
    }

    const { rows } = await query(
      `SELECT id, username, display_name, avatar_url, password_hash, created_at, last_seen_at
       FROM users WHERE username = $1`,
      [username],
    );

    if (!rows.length) {
      return reply.status(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password', details: {} },
      });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return reply.status(401).send({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid username or password', details: {} },
      });
    }

    const token = fastify.jwt.sign(
      { id: user.id },
      { expiresIn: config.jwt.accessTokenTtl },
    );
    const refreshToken = uuidv4();
    await storeRefreshToken(refreshToken, user.id, config.jwt.refreshTokenTtl);

    return reply.status(200).send({
      user: formatUser(user),
      token,
      refresh_token: refreshToken,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/refresh
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/auth/refresh', async (request, reply) => {
    const { refresh_token } = request.body || {};

    if (!refresh_token) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'refresh_token is required', details: {} },
      });
    }

    const userId = await getRefreshToken(refresh_token);
    if (!userId) {
      return reply.status(401).send({
        error: { code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token is invalid or expired', details: {} },
      });
    }

    // Rotate: delete old, issue new
    await deleteRefreshToken(refresh_token);

    const token = fastify.jwt.sign(
      { id: userId },
      { expiresIn: config.jwt.accessTokenTtl },
    );
    const newRefreshToken = uuidv4();
    await storeRefreshToken(newRefreshToken, userId, config.jwt.refreshTokenTtl);

    return reply.status(200).send({
      token,
      refresh_token: newRefreshToken,
    });
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/auth/logout
  // -------------------------------------------------------------------------
  fastify.post(
    '/api/v1/auth/logout',
    { preHandler: authenticate },
    async (request, reply) => {
      const { refresh_token } = request.body || {};

      if (refresh_token) {
        await deleteRefreshToken(refresh_token);
      }

      return reply.status(204).send();
    },
  );
}

module.exports = authRoutes;
