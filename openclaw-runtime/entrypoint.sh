#!/bin/sh
set -e

# Create auth-profiles.json from environment variables
# Keys stay in memory (tmpfs), never written to host disk

AUTH_DIR="/home/node/.openclaw/agents/main/agent"
mkdir -p "$AUTH_DIR"

# Build JSON with available API keys (OpenClaw auth-profiles schema)
{
    echo "{"
    echo "  \"version\": 1,"
    echo "  \"profiles\": {"

    FIRST=true

    if [ -n "$ANTHROPIC_API_KEY" ]; then
        echo "    \"anthropic:default\": { \"type\": \"api_key\", \"provider\": \"anthropic\", \"key\": \"${ANTHROPIC_API_KEY}\" }"
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
MEMORY_SLOT="none"
MEMORY_CONFIG=""
if [ -d "/app/extensions/memory-lancedb" ] && [ -n "${OPENAI_API_KEY:-}" ]; then
    MEMORY_SLOT="memory-lancedb"
    MEMORY_CONFIG="\"entries\": { \"memory-lancedb\": { \"enabled\": true, \"config\": { \"embedding\": { \"apiKey\": \"${OPENAI_API_KEY}\", \"model\": \"text-embedding-3-small\" } } } }"
elif [ -d "/app/extensions/memory-core" ]; then
    MEMORY_SLOT="memory-core"
fi

if [ -n "${OPENCLAW_MODEL:-}" ]; then
    cat > /home/node/.openclaw/openclaw.json << EOF
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "${OPENCLAW_MODEL}"
      }
    }
  },
  "plugins": {
    "slots": {
      "memory": "${MEMORY_SLOT}"
    }${MEMORY_CONFIG:+,
    ${MEMORY_CONFIG}}
  }
}
EOF
fi

# Start the gateway
exec node /app/dist/index.js gateway --bind lan --port 18789 --allow-unconfigured
