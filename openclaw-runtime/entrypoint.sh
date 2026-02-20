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
mkdir -p /data/.cache/qmd
mkdir -p /data/.config
mkdir -p /data/.npm
mkdir -p /data/.bun
mkdir -p /data/playwright
mkdir -p /data/tools
mkdir -p /data/browser/profile
mkdir -p /data/tmp
mkdir -p /data/qmd-models
mkdir -p /data/telegram

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

# Persist Telegram runtime state (poll offsets, caches) across container restarts.
# This avoids replay storms and reconnect churn while keeping auth profiles in tmpfs.
if [ -d /home/node/.openclaw/telegram ] && [ ! -L /home/node/.openclaw/telegram ]; then
  if [ -n "$(ls -A /home/node/.openclaw/telegram 2>/dev/null)" ] && [ -z "$(ls -A /data/telegram 2>/dev/null)" ]; then
    cp -a /home/node/.openclaw/telegram/. /data/telegram/ 2>/dev/null || true
  fi
  rm -rf /home/node/.openclaw/telegram
fi
ln -sfn /data/telegram /home/node/.openclaw/telegram

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

# Start the gateway
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
TOKEN_PARAM=""
if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    TOKEN_PARAM="--token ${OPENCLAW_GATEWAY_TOKEN}"
fi
exec node /app/dist/index.js gateway --bind lan --port "${PORT}" --allow-unconfigured ${TOKEN_PARAM}
