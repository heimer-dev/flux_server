'use strict';

const path = require('path');
const fastify = require('fastify')({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
  trustProxy: true,
});

const config = require('./config');

// ---------------------------------------------------------------------------
// Plugin registrations
// ---------------------------------------------------------------------------

// JWT
fastify.register(require('@fastify/jwt'), {
  secret: config.jwtSecret,
  sign: { algorithm: 'HS256' },
});

// Multipart (file uploads)
fastify.register(require('@fastify/multipart'), {
  limits: {
    fileSize: config.uploads.maxMediaSize, // 50 MB global cap
    files: 1,
  },
});

// WebSocket support
fastify.register(require('@fastify/websocket'));

// Static file serving for the web UI
fastify.register(require('@fastify/static'), {
  root: path.join(__dirname, '../public'),
  prefix: '/',
});

// Static file serving for uploads
fastify.register(require('@fastify/static'), {
  root: config.uploadDir,
  prefix: '/uploads/',
  decorateReply: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  },
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

fastify.register(require('./routes/health'));
fastify.register(require('./routes/auth'));
fastify.register(require('./routes/users'));
fastify.register(require('./routes/chats'));
fastify.register(require('./routes/messages'));
fastify.register(require('./routes/media'));

// WebSocket handler
fastify.register(require('./websocket/handler'));

// ---------------------------------------------------------------------------
// Global error handler — converts all unhandled errors to the standard shape
// ---------------------------------------------------------------------------

fastify.setErrorHandler((err, request, reply) => {
  fastify.log.error({ err, url: request.url }, 'Unhandled error');

  if (err.statusCode === 429) {
    return reply.status(429).send({
      error: { code: 'RATE_LIMITED', message: 'Too many requests', details: {} },
    });
  }

  if (err.validation) {
    return reply.status(422).send({
      error: { code: 'VALIDATION_ERROR', message: err.message, details: err.validation },
    });
  }

  const status = err.statusCode || 500;
  return reply.status(status).send({
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: status === 500 ? 'Internal server error' : err.message,
      details: {},
    },
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function start() {
  try {
    await fastify.listen({ port: config.port, host: '0.0.0.0' });
    fastify.log.info(`Flux server listening on port ${config.port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
