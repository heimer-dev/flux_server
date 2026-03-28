FROM node:20-alpine

# Install native dependencies required by sharp (libvips) and bcrypt (python/make/gcc)
RUN apk add --no-cache \
    vips-dev \
    fftw-dev \
    gcc \
    g++ \
    make \
    python3 \
    libc6-compat \
    && rm -rf /var/cache/apk/*

# Create app directory
WORKDIR /app

# Copy package manifest first for better layer caching
COPY package.json package-lock.json ./

# Install production dependencies
# sharp needs --ignore-scripts=false to run its install script
RUN npm ci --omit=dev

# Copy application source
COPY src/ ./src/
COPY migrations/ ./migrations/

# Create uploads directory with correct permissions
RUN mkdir -p /uploads && chown node:node /uploads

# Run as non-root user
USER node

# Expose API port
EXPOSE 3000

# Start the server
CMD ["node", "src/index.js"]
