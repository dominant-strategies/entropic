# OpenClaw Core Runtime Container
# Hardened, non-root, read-only filesystem

FROM node:22-bookworm-slim

# Install runtime deps and create directories
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    python3 \
    python3-pip \
    python3-venv \
    sqlite3 \
    unzip \
    # Headless Chromium runtime dependencies (patchright)
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    fonts-liberation \
    fonts-noto-color-emoji \
    # Additional fonts for realistic browser fingerprint
    fonts-noto-core \
    fonts-dejavu-core \
    fonts-freefont-ttf \
    fonts-roboto \
    # Video codec libraries (h264 support for Chromium)
    libavcodec59 \
    libavformat59 \
    libavutil57 && \
    rm -rf /var/lib/apt/lists/* && \
    # Make `python` resolve to python3 so skills can call either name
    ln -sfn /usr/bin/python3 /usr/local/bin/python && \
    mkdir -p /data /data/python-envs /home/node/.openclaw /home/node/.bun /home/node/.cache/qmd && \
    ln -sfn /data/qmd-models /home/node/.cache/qmd/models && \
    chown -R node:node /data /home/node/.openclaw /home/node/.bun /home/node/.cache

# Install patchright's patched Chromium:
# 1. Symlink to /usr/bin/chromium (OpenClaw's findChromeExecutableLinux() searches there)
# 2. Copy browsers to /opt/patchright-browsers/ so entrypoint can symlink into
#    PLAYWRIGHT_BROWSERS_PATH (/data/playwright/) for patchright's chromium.launch()
RUN npx patchright@latest install chromium && \
    cp -a /root/.cache/ms-playwright /opt/patchright-browsers && \
    chmod -R a+rX /opt/patchright-browsers && \
    CHROME_BIN=$(find /opt/patchright-browsers -name 'chrome' -type f | head -1) && \
    if [ -n "$CHROME_BIN" ]; then ln -sfn "$CHROME_BIN" /usr/bin/chromium; fi && \
    rm -rf /root/.cache/ms-playwright /tmp/.npm /tmp/patchright-*

ENV BUN_INSTALL=/data/.bun
# Python user installs land in /data/.local so they survive container restarts
# (the node user's HOME is /home/node but /data is the persistent volume)
ENV PYTHONUSERBASE=/data/.local
ENV PATH="/data/.bun/bin:/data/.local/bin:${PATH}"

WORKDIR /app

# Copy OpenClaw package metadata and deps first (stable for caching)
COPY --chown=node:node package.json ./package.json
COPY --chown=node:node node_modules ./node_modules
COPY --chown=node:node docs ./docs
COPY --chown=node:node extensions ./extensions

# Copy OpenClaw dist last (changes most often)
COPY --chown=node:node dist ./dist

# Copy bundled skills (seeded into /data/skills/ at startup by entrypoint)
COPY --chown=node:node bundled-skills /app/bundled-skills

# Install bundled skill dependencies (runs as root before USER node)
RUN for skill in /app/bundled-skills/*/; do \
      if [ -f "$skill/package.json" ]; then \
        echo "Installing deps for $(basename "$skill")..." && \
        cd "$skill" && npm install --omit=dev && cd /; \
      fi; \
    done

# Fix clipboard module for ARM64 Linux (create stub)
RUN echo "module.exports = { read: () => '', write: () => {}, readSync: () => '', writeSync: () => {}, clear: () => {}, clearSync: () => {} };" > /app/node_modules/.pnpm/@mariozechner+clipboard@0.3.0/node_modules/@mariozechner/clipboard/index.js || true

# Fix sharp native bindings for Linux (node_modules copied from macOS build host).
# pnpm-managed node_modules uses symlinks; npm install inside them is unreliable.
# Detect the installed sharp version, fetch matching linux-arm64 bindings in a
# temp dir, then copy them into sharp's @img directory.
RUN SHARP_PNPM="$(find /app/node_modules/.pnpm -maxdepth 1 -name 'sharp@*' -type d | head -1)" && \
    SHARP_VER="$(basename "$SHARP_PNPM" | sed 's/sharp@//')" && \
    SHARP_IMG_DIR="$SHARP_PNPM/node_modules/@img" && \
    LIBVIPS_VER="$(ls -d /app/node_modules/.pnpm/@img+sharp-libvips-darwin-arm64@* 2>/dev/null | head -1 | sed 's/.*@//')" && \
    echo "sharp=$SHARP_VER libvips=$LIBVIPS_VER img_dir=$SHARP_IMG_DIR" && \
    if [ -d "$SHARP_IMG_DIR" ] && [ -n "$SHARP_VER" ]; then \
      cd /tmp && mkdir sharp-fix && cd sharp-fix && \
      npm init -y --silent 2>/dev/null && \
      npm install "@img/sharp-linux-arm64@$SHARP_VER" "@img/sharp-libvips-linux-arm64@${LIBVIPS_VER:-1.2.4}" 2>&1 && \
      ls -la node_modules/@img/ && \
      cp -a node_modules/@img/sharp-linux-arm64 "$SHARP_IMG_DIR/sharp-linux-arm64" && \
      cp -a node_modules/@img/sharp-libvips-linux-arm64 "$SHARP_IMG_DIR/sharp-libvips-linux-arm64" && \
      echo "Installed sharp linux-arm64 bindings into $SHARP_IMG_DIR" && \
      cd / && rm -rf /tmp/sharp-fix; \
    fi

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
