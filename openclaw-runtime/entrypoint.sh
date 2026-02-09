#!/bin/sh
set -e

# Create auth-profiles.json from environment variables
# Keys stay in memory (tmpfs), never written to host disk

AUTH_DIR="/home/node/.openclaw/agents/main/agent"
mkdir -p "$AUTH_DIR"

{
    echo "{"
    echo "  \"version\": 1,"
    echo "  \"profiles\": {"

    FIRST=true

    if [ -n "$ANTHROPIC_API_KEY" ]; then
        echo "    \"anthropic:default\": { \"type\": \"api_key\", \"provider\": \"anthropic\", \"key\": \"${ANTHROPIC_API_KEY}\" }"
        FIRST=false
    fi

    if [ -n "$OPENROUTER_API_KEY" ]; then
        if [ "$FIRST" = false ]; then echo ","; fi
        echo "    \"openrouter:default\": { \"type\": \"api_key\", \"provider\": \"openrouter\", \"key\": \"${OPENROUTER_API_KEY}\" }"
        FIRST=false
    fi

    if [ -n "$OPENAI_API_KEY" ]; then
        if [ "$FIRST" = false ]; then echo ","; fi
        echo "    \"openai:default\": { \"type\": \"api_key\", \"provider\": \"openai\", \"key\": \"${OPENAI_API_KEY}\" }"
        FIRST=false
    fi

    if [ -n "$GEMINI_API_KEY" ]; then
        if [ "$FIRST" = false ]; then echo ","; fi
        echo "    \"google:default\": { \"type\": \"api_key\", \"provider\": \"google\", \"key\": \"${GEMINI_API_KEY}\" }"
    fi

    echo "  }"
    echo "}"
} > "$AUTH_DIR/auth-profiles.json"

json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\r/\\r/g' -e 's/\n/\\n/g'
}

# Create other directories OpenClaw needs
mkdir -p /home/node/.openclaw/workspace
mkdir -p /home/node/.openclaw/canvas
mkdir -p /home/node/.openclaw/cron
mkdir -p /home/node/.openclaw/logs

# Write a minimal config to select the primary model when provided
MEMORY_SLOT="${OPENCLAW_MEMORY_SLOT:-}"
MEMORY_CONFIG=""
PLUGIN_ENTRIES=""

if [ -z "$MEMORY_SLOT" ]; then
    if [ -d "/app/extensions/memory-lancedb" ] && [ -n "${OPENAI_API_KEY:-}" ]; then
        MEMORY_SLOT="memory-lancedb"
    elif [ -d "/app/extensions/memory-core" ]; then
        MEMORY_SLOT="memory-core"
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

PLUGIN_ENTRIES="\"nova-integrations\": { \"enabled\": true }"
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
    \"alsoAllow\": [\"nova-integrations\"]"
    if [ -n "${NOVA_PROXY_MODE:-}" ] && [ -n "${NOVA_PROXY_BASE_URL:-}" ]; then
        NOVA_PROXY_BASE_URL_ESC="$(json_escape "${NOVA_PROXY_BASE_URL}")"
        TOOLS_BLOCK="${TOOLS_BLOCK},
    \"web\": {
      \"search\": {
        \"provider\": \"perplexity\",
        \"perplexity\": {
          \"baseUrl\": \"${NOVA_PROXY_BASE_URL_ESC}\"
        }
      }
    }"
    fi
    TOOLS_BLOCK="${TOOLS_BLOCK}
  }"

    MODELS_BLOCK=""
    if [ -n "${NOVA_PROXY_BASE_URL:-}" ]; then
        NOVA_PROXY_BASE_URL_ESC="$(json_escape "${NOVA_PROXY_BASE_URL}")"
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
        \"baseUrl\": \"${NOVA_PROXY_BASE_URL_ESC}\",
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
  "plugins": {
    "slots": {
      "memory": "${MEMORY_SLOT}"
    },
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
