'use strict';

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  databaseUrl: process.env.DATABASE_URL || 'postgresql://flux:flux@localhost:5432/flux',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
  uploadDir: process.env.UPLOAD_DIR || '/uploads',
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',

  jwt: {
    accessTokenTtl: 7 * 24 * 60 * 60,       // 7 days in seconds
    refreshTokenTtl: 30 * 24 * 60 * 60,      // 30 days in seconds
  },

  bcrypt: {
    costFactor: 12,
  },

  rateLimits: {
    register: { points: 5, duration: 60 * 60 },         // 5/hour per IP
    login: { points: 10, duration: 60 },                 // 10/min per IP
    sendMessage: { points: 60, duration: 60 },           // 60/min per user
    uploadAvatar: { points: 10, duration: 60 * 60 },     // 10/hour per user
    uploadMedia: { points: 30, duration: 60 * 60 },      // 30/hour per user
  },

  uploads: {
    maxAvatarSize: 5 * 1024 * 1024,    // 5 MB
    maxMediaSize: 50 * 1024 * 1024,    // 50 MB
    avatarDimension: 256,
    allowedAvatarMimes: ['image/jpeg', 'image/png'],
    allowedMediaMimes: ['image/jpeg', 'image/png', 'audio/m4a', 'audio/mpeg'],
  },
};

module.exports = config;
