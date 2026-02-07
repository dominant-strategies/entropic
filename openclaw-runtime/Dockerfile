# OpenClaw Core Runtime Container
# Hardened, non-root, read-only filesystem

FROM node:22-bookworm-slim

# Install curl for health checks, create directories
RUN apt-get update && apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p /data /home/node/.openclaw && \
    chown -R node:node /data /home/node/.openclaw

WORKDIR /app

# Copy OpenClaw dist (built from clawdbot repo)
COPY dist ./dist
COPY package.json ./package.json
COPY node_modules ./node_modules
COPY docs ./docs
COPY extensions ./extensions

# Set ownership
RUN chown -R node:node /app

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
