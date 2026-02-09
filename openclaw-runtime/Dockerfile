# OpenClaw Core Runtime Container
# Hardened, non-root, read-only filesystem

FROM node:22-bookworm-slim

# Install curl for health checks, create directories
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /data /home/node/.openclaw && \
    chown -R node:node /data /home/node/.openclaw

WORKDIR /app

# Copy OpenClaw package metadata and deps first (stable for caching)
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node node_modules ./node_modules
COPY --chown=node:node docs ./docs
COPY --chown=node:node extensions ./extensions

# Copy OpenClaw dist last (changes most often)
COPY --chown=node:node dist ./dist

# Fix clipboard module for ARM64 Linux (create stub)
RUN echo "module.exports = { read: () => '', write: () => {}, readSync: () => '', writeSync: () => {}, clear: () => {}, clearSync: () => {} };" > /app/node_modules/.pnpm/@mariozechner+clipboard@0.3.0/node_modules/@mariozechner/clipboard/index.js || true

# Switch to non-root user
USER node

# Health check
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
    CMD sh -c 'curl -f http://localhost:${OPENCLAW_GATEWAY_PORT:-18789}/health || exit 1'

EXPOSE 18789

# Entrypoint script that creates auth from env vars, then starts gateway
COPY --chown=node:node entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
