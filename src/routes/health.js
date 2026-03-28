'use strict';

const { healthCheck: dbHealthCheck } = require('../db');
const { healthCheck: redisHealthCheck } = require('../redis');

async function healthRoutes(fastify) {
  fastify.get('/api/health', async (request, reply) => {
    let dbOk = false;
    let redisOk = false;

    try {
      dbOk = await dbHealthCheck();
    } catch (_) {
      // swallow — status reflects failure below
    }

    try {
      redisOk = await redisHealthCheck();
    } catch (_) {
      // swallow
    }

    const allOk = dbOk && redisOk;

    return reply.status(allOk ? 200 : 503).send({
      status: allOk ? 'ok' : 'degraded',
      version: '1.0.0',
      checks: {
        database: dbOk ? 'ok' : 'error',
        redis: redisOk ? 'ok' : 'error',
      },
    });
  });
}

module.exports = healthRoutes;
