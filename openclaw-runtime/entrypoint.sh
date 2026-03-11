#!/bin/sh
set -e
# CACHE BUST: OPENCLAW_OAUTH_DIR persistence fix v2
# Create auth-profiles.json from environment variables
# Keys stay in memory (tmpfs), never written to host disk

json_escape() {
    node -e 'const v = process.argv[1] ?? ""; process.stdout.write(JSON.stringify(v).slice(1,-1));' "$1"
}

append_auth_profile() {
    key="$1"
    provider="$2"
    value="$3"

    if [ -n "${AUTH_PROFILES}" ]; then
        AUTH_PROFILES="${AUTH_PROFILES},"
    fi
    AUTH_PROFILES="${AUTH_PROFILES}
    \"${key}\": { \"type\": \"api_key\", \"provider\": \"${provider}\", \"key\": \"${value}\" }"
}

AUTH_PROFILES=""

AUTH_DIR="/home/node/.openclaw/agents/main/agent"
mkdir -p "$AUTH_DIR"

if [ -n "$ANTHROPIC_API_KEY" ]; then
    append_auth_profile "anthropic:default" "anthropic" "$(json_escape "${ANTHROPIC_API_KEY}")"
fi
if [ -n "$OPENROUTER_API_KEY" ]; then
    append_auth_profile "openrouter:default" "openrouter" "$(json_escape "${OPENROUTER_API_KEY}")"
fi
if [ -n "$OPENAI_API_KEY" ]; then
    append_auth_profile "openai:default" "openai" "$(json_escape "${OPENAI_API_KEY}")"
fi
if [ -n "$GEMINI_API_KEY" ]; then
    append_auth_profile "google:default" "google" "$(json_escape "${GEMINI_API_KEY}")"
fi

cat > "$AUTH_DIR/auth-profiles.json" << EOF
{
  "version": 1,
  "profiles": {${AUTH_PROFILES}
  }
}
EOF

# Create other directories OpenClaw needs.
# /home/node/.openclaw remains tmpfs-backed for sensitive runtime state.
mkdir -p /home/node/.openclaw/canvas
mkdir -p /home/node/.openclaw/cron
mkdir -p /home/node/.openclaw/logs
mkdir -p /home/node/.openclaw/.cache

# Durable Entropic storage classes (backed by /data volume).
mkdir -p /data/workspace
mkdir -p /data/skills
mkdir -p /data/skill-manifests

# Seed bundled skills into /data/skills/ AND /data/workspace/skills/
# so OpenClaw's workspace scanner discovers them for chat runs.
mkdir -p /data/workspace/skills
if [ -d /app/bundled-skills ]; then
    for skill_dir in /app/bundled-skills/*/; do
        skill_name="$(basename "$skill_dir")"
        if [ -n "$skill_name" ] && [ "$skill_name" != "*" ]; then
            cp -a "$skill_dir" "/data/skills/$skill_name"
            cp -a "$skill_dir" "/data/workspace/skills/$skill_name"
        fi
    done
fi
mkdir -p /data/.cache/qmd
# Python user package install target — persisted across restarts so skills
# don't need to reinstall their pip dependencies every container start.
mkdir -p /data/.local/bin /data/.local/lib
mkdir -p /data/.config
mkdir -p /data/.npm
mkdir -p /data/.bun
mkdir -p /data/playwright
# Symlink patchright browsers into PLAYWRIGHT_BROWSERS_PATH so chromium.launch() finds them
if [ -d /opt/patchright-browsers ]; then
    for browser_dir in /opt/patchright-browsers/*/; do
        browser_name="$(basename "$browser_dir")"
        if [ -n "$browser_name" ] && [ "$browser_name" != "*" ]; then
            ln -sfn "$browser_dir" "/data/playwright/$browser_name"
        fi
    done
fi
mkdir -p /data/tools
mkdir -p /data/browser/profile
mkdir -p /data/tmp
mkdir -p /data/qmd-models
mkdir -p /data/telegram
mkdir -p /data/sessions
mkdir -p /data/canvas

# Keep OpenClaw's expected ~/.openclaw path mapped to tmpfs-backed state
# even when HOME points at /data for durable tool caches.
if [ -d /data/.openclaw ] && [ ! -L /data/.openclaw ]; then
  cp -a /data/.openclaw/. /home/node/.openclaw/ 2>/dev/null || true
  rm -rf /data/.openclaw
fi
ln -sfn /home/node/.openclaw /data/.openclaw
ln -sfn /home/node/.openclaw /home/node/.openclaw/.openclaw
rm -rf /home/node/.openclaw/.cache/qmd
ln -sfn /data/.cache/qmd /home/node/.openclaw/.cache/qmd
rm -rf /data/.cache/qmd/models
ln -sfn /data/qmd-models /data/.cache/qmd/models

# Start a headed X display for the in-app sandbox browser viewer.
if [ "${ENTROPIC_BROWSER_HEADFUL:-1}" != "0" ]; then
  export ENTROPIC_BROWSER_HEADFUL=1
  export DISPLAY="${DISPLAY:-:99}"
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-node}"
  mkdir -p "$XDG_RUNTIME_DIR"
  chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true
  export LIBGL_ALWAYS_SOFTWARE=1

  BROWSER_SCREEN_SIZE="${ENTROPIC_BROWSER_SCREEN_SIZE:-1280x800x24}"
  BROWSER_DESKTOP_PORT="${ENTROPIC_BROWSER_DESKTOP_PORT:-19793}"
  export ENTROPIC_BROWSER_DESKTOP_PORT="$BROWSER_DESKTOP_PORT"
  X_DISPLAY_NUM="$(printf '%s' "$DISPLAY" | sed 's/^://; s/\..*$//')"
  X_SOCKET="/tmp/.X11-unix/X${X_DISPLAY_NUM}"

  Xvfb "$DISPLAY" -screen 0 "$BROWSER_SCREEN_SIZE" -ac -nolisten tcp +extension RANDR >/data/browser/xvfb.log 2>&1 &
  xvfb_pid="$!"
  xvfb_ready=0
  xvfb_attempt=0
  while [ "$xvfb_attempt" -lt 30 ]; do
      if [ -S "$X_SOCKET" ]; then
          xvfb_ready=1
          break
      fi
      if ! kill -0 "$xvfb_pid" >/dev/null 2>&1; then
          break
      fi
      xvfb_attempt=$((xvfb_attempt + 1))
      sleep 0.2
  done

  if [ "$xvfb_ready" -ne 1 ]; then
      echo "[entrypoint] Xvfb failed to become ready on $DISPLAY" >&2
      if [ -f /data/browser/xvfb.log ]; then
          tail -n 40 /data/browser/xvfb.log >&2 || true
      fi
  elif [ "${ENTROPIC_BROWSER_REMOTE_DESKTOP_UI:-0}" = "1" ]; then
      x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -localhost >/data/browser/x11vnc.log 2>&1 &
      x11vnc_pid="$!"
      x11vnc_ready=0
      x11vnc_attempt=0
      while [ "$x11vnc_attempt" -lt 30 ]; do
          if python3 -c 'import socket,sys; s=socket.socket(); s.settimeout(0.2); s.connect(("127.0.0.1", 5900)); s.close()' >/dev/null 2>&1; then
              x11vnc_ready=1
              break
          fi
          if ! kill -0 "$x11vnc_pid" >/dev/null 2>&1; then
              break
          fi
          x11vnc_attempt=$((x11vnc_attempt + 1))
          sleep 0.2
      done

      if [ "$x11vnc_ready" -ne 1 ]; then
          echo "[entrypoint] x11vnc failed to become ready on localhost:5900" >&2
          if [ -f /data/browser/x11vnc.log ]; then
              tail -n 40 /data/browser/x11vnc.log >&2 || true
          fi
      else
          websockify --web /usr/share/novnc/ "$BROWSER_DESKTOP_PORT" 127.0.0.1:5900 >/data/browser/websockify.log 2>&1 &
          websockify_pid="$!"
          websockify_ready=0
          websockify_attempt=0
          while [ "$websockify_attempt" -lt 30 ]; do
              if curl -fsS "http://127.0.0.1:${BROWSER_DESKTOP_PORT}/vnc_lite.html" >/dev/null 2>&1; then
                  websockify_ready=1
                  break
              fi
              if ! kill -0 "$websockify_pid" >/dev/null 2>&1; then
                  break
              fi
              websockify_attempt=$((websockify_attempt + 1))
              sleep 0.2
          done

          if [ "$websockify_ready" -ne 1 ]; then
              echo "[entrypoint] websockify failed to become ready on localhost:${BROWSER_DESKTOP_PORT}" >&2
              if [ -f /data/browser/websockify.log ]; then
                  tail -n 40 /data/browser/websockify.log >&2 || true
              fi
          fi
      fi
  else
      echo "[entrypoint] Remote desktop UI disabled; skipping x11vnc/websockify startup"
  fi
fi

# Persist Telegram runtime state (poll offsets, caches) across container restarts.
# This avoids replay storms and reconnect churn while keeping auth profiles in tmpfs.
if [ -d /home/node/.openclaw/telegram ] && [ ! -L /home/node/.openclaw/telegram ]; then
  if [ -n "$(ls -A /home/node/.openclaw/telegram 2>/dev/null)" ] && [ -z "$(ls -A /data/telegram 2>/dev/null)" ]; then
    cp -a /home/node/.openclaw/telegram/. /data/telegram/ 2>/dev/null || true
  fi
  rm -rf /home/node/.openclaw/telegram
fi
ln -sfn /data/telegram /home/node/.openclaw/telegram

# Persist chat sessions (transcripts + registry) across container restarts.
# Without this, all chat history is lost when the container recreates (tmpfs wipe).
SESSIONS_DIR="/home/node/.openclaw/agents/main/sessions"
mkdir -p "$(dirname "$SESSIONS_DIR")"
if [ -d "$SESSIONS_DIR" ] && [ ! -L "$SESSIONS_DIR" ]; then
  if [ -n "$(ls -A "$SESSIONS_DIR" 2>/dev/null)" ] && [ -z "$(ls -A /data/sessions 2>/dev/null)" ]; then
    cp -a "$SESSIONS_DIR/." /data/sessions/ 2>/dev/null || true
  fi
  rm -rf "$SESSIONS_DIR"
fi
ln -sfn /data/sessions "$SESSIONS_DIR"

# Persist canvas files across container restarts.
if [ -d /home/node/.openclaw/canvas ] && [ ! -L /home/node/.openclaw/canvas ]; then
  if [ -n "$(ls -A /home/node/.openclaw/canvas 2>/dev/null)" ] && [ -z "$(ls -A /data/canvas 2>/dev/null)" ]; then
    cp -a /home/node/.openclaw/canvas/. /data/canvas/ 2>/dev/null || true
  fi
  rm -rf /home/node/.openclaw/canvas
fi
ln -sfn /data/canvas /home/node/.openclaw/canvas

# Persist credentials (pairing data, etc.) in durable storage by overriding OPENCLAW_OAUTH_DIR
# This environment variable tells OpenClaw to store credentials directly in /data/credentials
# instead of trying to create ~/.openclaw/credentials (which would be ephemeral)
mkdir -p /data/credentials
chmod 700 /data/credentials
export OPENCLAW_OAUTH_DIR=/data/credentials

# Migrate legacy workspace (if present) and bind Home/workspace to durable storage.
if [ -d /home/node/.openclaw/workspace ] && [ ! -L /home/node/.openclaw/workspace ]; then
  if [ -n "$(ls -A /home/node/.openclaw/workspace 2>/dev/null)" ] && [ -z "$(ls -A /data/workspace 2>/dev/null)" ]; then
    cp -a /home/node/.openclaw/workspace/. /data/workspace/ 2>/dev/null || true
  fi
  rm -rf /home/node/.openclaw/workspace
fi
ln -sfn /data/workspace /home/node/.openclaw/workspace
mkdir -p /data/workspace/node_modules

# Ensure qmd's workspace-local tsx resolver stays available even in ESM context.
# Prefer persistent /data/.bun install path; fall back to legacy /home/node/.bun path.
if [ -d /data/.bun/install/global/node_modules/tsx ]; then
  ln -sfn /data/.bun/install/global/node_modules/tsx /data/workspace/node_modules/tsx
elif [ -d /home/node/.bun/install/global/node_modules/tsx ]; then
  ln -sfn /home/node/.bun/install/global/node_modules/tsx /data/workspace/node_modules/tsx
fi

# Runtime environment for durable user assets and tool/browser caches.
export ENTROPIC_WORKSPACE_PATH="${ENTROPIC_WORKSPACE_PATH:-/data/workspace}"
export ENTROPIC_SKILLS_PATH="${ENTROPIC_SKILLS_PATH:-/data/skills}"
export ENTROPIC_SKILL_MANIFESTS_PATH="${ENTROPIC_SKILL_MANIFESTS_PATH:-/data/skill-manifests}"
export ENTROPIC_BROWSER_PROFILE="${ENTROPIC_BROWSER_PROFILE:-/data/browser/profile}"
export HOME="${HOME:-/data}"
export BUN_INSTALL="${BUN_INSTALL:-/data/.bun}"
export PATH="/data/.bun/bin:${PATH}"
export TMPDIR="${TMPDIR:-/data/tmp}"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-/data/.config}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/data/.cache}"
export npm_config_cache="${npm_config_cache:-/data/.npm}"
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/data/playwright}"
export NODE_PATH="/data/.bun/install/global/node_modules:/home/node/.bun/install/global/node_modules${NODE_PATH:+:$NODE_PATH}"

# Write a minimal config to select the primary model when provided
MEMORY_SLOT="${OPENCLAW_MEMORY_SLOT:-}"
MEMORY_CONFIG=""
PLUGIN_ENTRIES=""

if [ -z "$MEMORY_SLOT" ]; then
    if [ -d "/app/extensions/memory-core" ]; then
        MEMORY_SLOT="memory-core"
    elif [ -d "/app/extensions/memory-lancedb" ] && [ -n "${OPENAI_API_KEY:-}" ]; then
        MEMORY_SLOT="memory-lancedb"
    else
        MEMORY_SLOT="none"
    fi
fi

if [ "$MEMORY_SLOT" = "memory-lancedb" ]; then
    if [ -n "${OPENAI_API_KEY:-}" ]; then
        OPENAI_API_KEY_ESC="$(json_escape "${OPENAI_API_KEY}")"
        MEMORY_CONFIG="\"memory-lancedb\": { \"enabled\": true, \"config\": { \"embedding\": { \"apiKey\": \"${OPENAI_API_KEY_ESC}\", \"model\": \"text-embedding-3-small\" } } }"
    else
        MEMORY_SLOT="memory-core"
    fi
fi

# Note: The top-level "memory" config block was removed in OpenClaw >= 2026.1.29.
# The memory-core plugin now handles memory search internally via api.runtime.tools.

PLUGIN_ENTRIES="\"entropic-integrations\": { \"enabled\": true }"
ALSO_ALLOW="\"entropic-integrations\""

if [ -d "/app/extensions/entropic-x" ] || [ -d "/data/entropic-skills/entropic-x" ] || [ -d "${ENTROPIC_SKILLS_PATH}/entropic-x" ] || [ -d "${ENTROPIC_SKILLS_PATH}/entropic-x/current" ]; then
    PLUGIN_ENTRIES="${PLUGIN_ENTRIES}, \"entropic-x\": { \"enabled\": true }"
    ALSO_ALLOW="${ALSO_ALLOW}, \"x_search\", \"x_profile\", \"x_thread\", \"x_user_tweets\""
fi
if [ -n "$MEMORY_CONFIG" ]; then
    PLUGIN_ENTRIES="${PLUGIN_ENTRIES}, ${MEMORY_CONFIG}"
fi

GATEWAY_AUTH_BLOCK=""
if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    OPENCLAW_GATEWAY_TOKEN_ESC="$(json_escape "${OPENCLAW_GATEWAY_TOKEN}")"
    GATEWAY_AUTH_BLOCK=",
    \"auth\": { \"token\": \"${OPENCLAW_GATEWAY_TOKEN_ESC}\" }"
fi

if [ -n "${OPENCLAW_MODEL:-}" ]; then
    OPENCLAW_MODEL_ESC="$(json_escape "${OPENCLAW_MODEL}")"
    IMAGE_MODEL_BLOCK=""
    if [ -n "${OPENCLAW_IMAGE_MODEL:-}" ]; then
        OPENCLAW_IMAGE_MODEL_ESC="$(json_escape "${OPENCLAW_IMAGE_MODEL}")"
        IMAGE_MODEL_BLOCK=",
      \"imageModel\": { \"primary\": \"${OPENCLAW_IMAGE_MODEL_ESC}\" }"
    else
        OPENCLAW_IMAGE_MODEL_ESC=""
    fi
    TOOLS_BLOCK=",
  \"tools\": {
    \"alsoAllow\": [${ALSO_ALLOW}]"
    if [ -n "${ENTROPIC_PROXY_MODE:-}" ] && [ -n "${ENTROPIC_PROXY_BASE_URL:-}" ]; then
        ENTROPIC_PROXY_BASE_URL_ESC="$(json_escape "${ENTROPIC_PROXY_BASE_URL}")"
        TOOLS_BLOCK="${TOOLS_BLOCK},
    \"web\": {
      \"search\": {
        \"provider\": \"perplexity\",
        \"perplexity\": {
          \"baseUrl\": \"${ENTROPIC_PROXY_BASE_URL_ESC}\"
        }
      }
    }"
    fi
    TOOLS_BLOCK="${TOOLS_BLOCK}
  }"

    MODELS_BLOCK=""
    LOAD_PATHS_BLOCK=""
    if [ -d "${ENTROPIC_SKILLS_PATH}/entropic-x/current" ]; then
        LOAD_PATHS_BLOCK=",
    \"load\": { \"paths\": [\"${ENTROPIC_SKILLS_PATH}/entropic-x/current\"] }"
    elif [ -d "${ENTROPIC_SKILLS_PATH}/entropic-x" ]; then
        LOAD_PATHS_BLOCK=",
    \"load\": { \"paths\": [\"${ENTROPIC_SKILLS_PATH}/entropic-x\"] }"
    elif [ -d "/data/entropic-skills/entropic-x" ]; then
        LOAD_PATHS_BLOCK=",
    \"load\": { \"paths\": [\"/data/entropic-skills/entropic-x\"] }"
    fi
    if [ -n "${ENTROPIC_PROXY_BASE_URL:-}" ]; then
        ENTROPIC_PROXY_BASE_URL_ESC="$(json_escape "${ENTROPIC_PROXY_BASE_URL}")"
        MODEL_ID_RAW="${OPENCLAW_MODEL#openrouter/}"
        if [ "$MODEL_ID_RAW" = "free" ] || [ "$MODEL_ID_RAW" = "auto" ]; then
            MODEL_ID_RAW="${OPENCLAW_MODEL}"
        fi
        MODEL_ID_ESC="$(json_escape "${MODEL_ID_RAW}")"
        IMAGE_MODEL_ID_RAW=""
        IMAGE_MODEL_ID_ESC=""
        if [ -n "${OPENCLAW_IMAGE_MODEL:-}" ]; then
            IMAGE_MODEL_ID_RAW="${OPENCLAW_IMAGE_MODEL#openrouter/}"
            if [ "$IMAGE_MODEL_ID_RAW" = "free" ] || [ "$IMAGE_MODEL_ID_RAW" = "auto" ]; then
                IMAGE_MODEL_ID_RAW="${OPENCLAW_IMAGE_MODEL}"
            fi
            IMAGE_MODEL_ID_ESC="$(json_escape "${IMAGE_MODEL_ID_RAW}")"
        fi
        MODELS_BLOCK=",
  \"models\": {
    \"providers\": {
      \"openrouter\": {
        \"baseUrl\": \"${ENTROPIC_PROXY_BASE_URL_ESC}\",
        \"api\": \"openai-completions\",
        \"models\": [
          { \"id\": \"${MODEL_ID_ESC}\", \"name\": \"${MODEL_ID_ESC}\" }${IMAGE_MODEL_ID_ESC:+,
          { \"id\": \"${IMAGE_MODEL_ID_ESC}\", \"name\": \"${IMAGE_MODEL_ID_ESC}\" }}
        ]
      }
    }
  }"
    fi

    cat > /home/node/.openclaw/openclaw.json << EOF
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "${OPENCLAW_MODEL_ESC}"
      }${IMAGE_MODEL_BLOCK}
    }
  },
  "cron": {
    "store": "/data/cron/jobs.json"
  },
  "session": {
    "store": "/data/sessions/sessions.json"
  },
  "gateway": {
    "controlUi": {
      "allowInsecureAuth": true,
      "dangerouslyDisableDeviceAuth": true,
      "dangerouslyAllowHostHeaderOriginFallback": true,
      "allowedOrigins": [
        "null",
        "http://localhost",
        "http://127.0.0.1",
        "https://localhost",
        "https://127.0.0.1",
        "tauri://localhost",
        "http://localhost:5174",
        "http://127.0.0.1:5174"
      ]
    }${GATEWAY_AUTH_BLOCK}
  },
  "plugins": {
    "slots": {
      "memory": "${MEMORY_SLOT}"
    }${LOAD_PATHS_BLOCK},
    "entries": {
      ${PLUGIN_ENTRIES}
    }
  }${MODELS_BLOCK}${TOOLS_BLOCK}
}
EOF
fi

# Start the browser service in the background for desktop/browser bridge commands.
BROWSER_SERVICE_PORT="${ENTROPIC_BROWSER_SERVICE_PORT:-19791}"
export ENTROPIC_BROWSER_SERVICE_PORT="$BROWSER_SERVICE_PORT"
if [ -f /app/browser-service/server.mjs ]; then
    node /app/browser-service/server.mjs >/data/browser/browser-service.log 2>&1 &
    browser_service_pid="$!"
    browser_service_ready=0
    browser_service_attempt=0
    while [ "$browser_service_attempt" -lt 20 ]; do
        if curl -fsS "http://127.0.0.1:${BROWSER_SERVICE_PORT}/health" >/dev/null 2>&1; then
            browser_service_ready=1
            break
        fi
        if ! kill -0 "$browser_service_pid" >/dev/null 2>&1; then
            break
        fi
        browser_service_attempt=$((browser_service_attempt + 1))
        sleep 0.3
    done

    if [ "$browser_service_ready" -ne 1 ]; then
        echo "[entrypoint] Browser service failed to become ready on 127.0.0.1:${BROWSER_SERVICE_PORT}" >&2
        if [ -f /data/browser/browser-service.log ]; then
            tail -n 40 /data/browser/browser-service.log >&2 || true
        fi
    fi
fi

# Start the gateway
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
TOKEN_PARAM=""
if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    TOKEN_PARAM="--token ${OPENCLAW_GATEWAY_TOKEN}"
fi
exec node /app/dist/index.js gateway --bind lan --port "${PORT}" --allow-unconfigured ${TOKEN_PARAM}
