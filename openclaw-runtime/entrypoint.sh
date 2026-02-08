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

# Create other directories OpenClaw needs
mkdir -p /home/node/.openclaw/workspace
mkdir -p /home/node/.openclaw/canvas
mkdir -p /home/node/.openclaw/cron
mkdir -p /home/node/.openclaw/logs

# Write a minimal config to select the primary model when provided
MEMORY_SLOT="${OPENCLAW_MEMORY_SLOT:-}"
MEMORY_CONFIG=""

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
        MEMORY_CONFIG="\"entries\": { \"memory-lancedb\": { \"enabled\": true, \"config\": { \"embedding\": { \"apiKey\": \"${OPENAI_API_KEY}\", \"model\": \"text-embedding-3-small\" } } } }"
    else
        MEMORY_SLOT="memory-core"
    fi
fi

if [ -n "${OPENCLAW_MODEL:-}" ]; then
    TOOLS_BLOCK=""
    if [ -n "${NOVA_PROXY_MODE:-}" ] && [ -n "${NOVA_PROXY_BASE_URL:-}" ]; then
        TOOLS_BLOCK=",
  \"tools\": {
    \"web\": {
      \"search\": {
        \"provider\": \"perplexity\",
        \"perplexity\": {
          \"baseUrl\": \"${NOVA_PROXY_BASE_URL}\"
        }
      }
    }
  }"
    fi

    MODELS_BLOCK=""
    if [ -n "${NOVA_PROXY_BASE_URL:-}" ]; then
        MODEL_ID="${OPENCLAW_MODEL#openrouter/}"
        if [ "$MODEL_ID" = "free" ] || [ "$MODEL_ID" = "auto" ]; then
            MODEL_ID="${OPENCLAW_MODEL}"
        fi
        IMAGE_MODEL_ID=""
        if [ -n "${OPENCLAW_IMAGE_MODEL:-}" ]; then
            IMAGE_MODEL_ID="${OPENCLAW_IMAGE_MODEL#openrouter/}"
            if [ "$IMAGE_MODEL_ID" = "free" ] || [ "$IMAGE_MODEL_ID" = "auto" ]; then
                IMAGE_MODEL_ID="${OPENCLAW_IMAGE_MODEL}"
            fi
        fi
        MODELS_BLOCK=",
  \"models\": {
    \"providers\": {
      \"openrouter\": {
        \"baseUrl\": \"${NOVA_PROXY_BASE_URL}\",
        \"api\": \"openai-completions\",
        \"models\": [
          { \"id\": \"${MODEL_ID}\", \"name\": \"${MODEL_ID}\" }${IMAGE_MODEL_ID:+,
          { \"id\": \"${IMAGE_MODEL_ID}\", \"name\": \"${IMAGE_MODEL_ID}\" }}
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
        "primary": "${OPENCLAW_MODEL}"
      }${OPENCLAW_IMAGE_MODEL:+,
      "imageModel": { "primary": "${OPENCLAW_IMAGE_MODEL}" }}
    }
  },
  "plugins": {
    "slots": {
      "memory": "${MEMORY_SLOT}"
    }${MEMORY_CONFIG:+,
    ${MEMORY_CONFIG}}
  }${MODELS_BLOCK}${TOOLS_BLOCK}
}
EOF
fi

# Start the gateway
PORT="${OPENCLAW_GATEWAY_PORT:-18789}"
exec node /app/dist/index.js gateway --bind lan --port "${PORT}" --allow-unconfigured
