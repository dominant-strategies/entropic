# OpenClaw Core Runtime Container
# Hardened, non-root, read-only filesystem

FROM node:22-bookworm-slim

# Install runtime deps and create directories
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    sqlite3 \
    unzip && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /data /home/node/.openclaw /home/node/.bun /home/node/.cache/qmd && \
    ln -sfn /data/qmd-models /home/node/.cache/qmd/models && \
    chown -R node:node /data /home/node/.openclaw /home/node/.bun /home/node/.cache

ENV BUN_INSTALL=/data/.bun
ENV PATH="/data/.bun/bin:${PATH}"

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

# QMD is installed on-demand at runtime when enabled in Settings.
ENV NODE_PATH="/data/.bun/install/global/node_modules:/home/node/.bun/install/global/node_modules${NODE_PATH:+:$NODE_PATH}"

# Health check
# /health can return 503 when control-ui assets are intentionally omitted.
# Probe an authenticated endpoint that reflects gateway liveness instead.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
    CMD sh -c 'if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then curl -fsS -H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}" "http://localhost:${OPENCLAW_GATEWAY_PORT:-18789}/__openclaw__/canvas/" >/dev/null; else curl -fsS "http://localhost:${OPENCLAW_GATEWAY_PORT:-18789}/__openclaw__/canvas/" >/dev/null; fi || exit 1'

EXPOSE 18789

# Set credentials directory to persistent storage
ENV OPENCLAW_OAUTH_DIR=/data/credentials

# Entrypoint script that creates auth from env vars, then starts gateway
COPY --chown=node:node entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
