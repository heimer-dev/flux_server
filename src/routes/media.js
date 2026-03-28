'use strict';

const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { RateLimiterRedis } = require('rate-limiter-flexible');

const { redis } = require('../redis');
const { authenticate } = require('../middleware/auth');
const config = require('../config');

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

async function mediaRoutes(fastify) {
  const mediaLimiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: 'rl:media',
    points: config.rateLimits.uploadMedia.points,
    duration: config.rateLimits.uploadMedia.duration,
  });

  // Allowed MIME types and their canonical file extensions
  const MIME_TO_EXT = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'audio/m4a': '.m4a',
    'audio/mpeg': '.mp3',
    // Some clients send this for m4a
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
  };

  // -------------------------------------------------------------------------
  // POST /api/v1/media
  // -------------------------------------------------------------------------
  fastify.post('/api/v1/media', { preHandler: authenticate }, async (request, reply) => {
    const userId = request.currentUser.id;

    try {
      await mediaLimiter.consume(userId);
    } catch (_) {
      return reply.status(429).send({
        error: { code: 'RATE_LIMITED', message: 'Media upload rate limit exceeded (30/hour)', details: {} },
      });
    }

    let data;
    try {
      data = await request.file({ limits: { fileSize: config.uploads.maxMediaSize } });
    } catch (err) {
      if (err.code === 'FST_FILES_LIMIT' || err.code === 'FST_REQ_FILE_TOO_LARGE') {
        return reply.status(422).send({
          error: { code: 'FILE_TOO_LARGE', message: 'File exceeds maximum size of 50 MB', details: {} },
        });
      }
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Expected multipart/form-data with file field', details: {} },
      });
    }

    if (!data) {
      return reply.status(422).send({
        error: { code: 'VALIDATION_ERROR', message: 'No file uploaded', details: {} },
      });
    }

    const mimeType = data.mimetype;
    const ext = MIME_TO_EXT[mimeType];

    if (!ext) {
      // Drain the stream to avoid hanging
      data.file.resume();
      return reply.status(422).send({
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Allowed types: image/jpeg, image/png, audio/m4a, audio/mpeg',
          details: { mimetype: mimeType },
        },
      });
    }

    // Buffer the upload, enforcing size limit
    const chunks = [];
    let totalSize = 0;
    try {
      for await (const chunk of data.file) {
        totalSize += chunk.length;
        if (totalSize > config.uploads.maxMediaSize) {
          return reply.status(422).send({
            error: { code: 'FILE_TOO_LARGE', message: 'File exceeds maximum size of 50 MB', details: {} },
          });
        }
        chunks.push(chunk);
      }
    } catch (err) {
      return reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to read uploaded file', details: {} },
      });
    }

    const buffer = Buffer.concat(chunks);

    // Determine subdirectory by type
    const subDir = mimeType.startsWith('image/') ? 'images' : 'audio';
    const uploadDir = path.join(config.uploadDir, subDir);
    fs.mkdirSync(uploadDir, { recursive: true });

    const filename = `${uuidv4()}${ext}`;
    const filePath = path.join(uploadDir, filename);

    try {
      fs.writeFileSync(filePath, buffer);
    } catch (err) {
      return reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to save uploaded file', details: {} },
      });
    }

    const url = `${config.baseUrl}/uploads/${subDir}/${filename}`;

    return reply
      .header('Cache-Control', 'public, max-age=86400')
      .status(200)
      .send({ url });
  });
}

module.exports = mediaRoutes;
