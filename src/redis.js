'use strict';

const Redis = require('ioredis');
const config = require('./config');

function createRedisClient(name) {
  const client = new Redis(config.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy(times) {
      const delay = Math.min(times * 100, 3000);
      console.warn(`[Redis:${name}] Retry attempt ${times}, next in ${delay}ms`);
      return delay;
    },
  });

  client.on('connect', () => console.info(`[Redis:${name}] Connected`));
  client.on('error', (err) => console.error(`[Redis:${name}] Error:`, err.message));
  client.on('close', () => console.warn(`[Redis:${name}] Connection closed`));

  return client;
}

// Main client used for all regular commands (get/set/del/expire etc.)
const redis = createRedisClient('main');

// Dedicated subscriber client — ioredis does not allow regular commands
// on a client that has entered subscribe mode.
const redisSub = createRedisClient('sub');

/**
 * Verify Redis is reachable.
 * @returns {Promise<boolean>}
 */
async function healthCheck() {
  const result = await redis.ping();
  return result === 'PONG';
}

/**
 * Store a refresh token with TTL.
 * @param {string} token
 * @param {string} userId
 * @param {number} ttlSeconds
 */
async function storeRefreshToken(token, userId, ttlSeconds) {
  await redis.setex(`refresh:${token}`, ttlSeconds, userId);
}

/**
 * Retrieve the user ID associated with a refresh token.
 * @param {string} token
 * @returns {Promise<string|null>}
 */
async function getRefreshToken(token) {
  return redis.get(`refresh:${token}`);
}

/**
 * Delete a refresh token (logout / rotation).
 * @param {string} token
 */
async function deleteRefreshToken(token) {
  await redis.del(`refresh:${token}`);
}

/**
 * Publish an event to a chat pub/sub channel.
 * @param {string} chatId
 * @param {object} event
 */
async function publishToChat(chatId, event) {
  await redis.publish(`chat:${chatId}`, JSON.stringify(event));
}

/**
 * Publish an event directly to a specific user channel.
 * @param {string} userId
 * @param {object} event
 */
async function publishToUser(userId, event) {
  await redis.publish(`user:${userId}`, JSON.stringify(event));
}

module.exports = {
  redis,
  redisSub,
  healthCheck,
  storeRefreshToken,
  getRefreshToken,
  deleteRefreshToken,
  publishToChat,
  publishToUser,
};
