#!/bin/bash
set -euo pipefail

# Build the OpenClaw core runtime container

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RUNTIME_DIR="$PROJECT_ROOT/openclaw-runtime"
OPENCLAW_SOURCE="${OPENCLAW_SOURCE:-$HOME/agent/clawdbot}"

echo "=== Building OpenClaw Runtime Container ==="
echo ""

# Check if OpenClaw source exists
if [ ! -d "$OPENCLAW_SOURCE/dist" ]; then
    echo "ERROR: OpenClaw dist not found at $OPENCLAW_SOURCE/dist"
    echo "Please build openclaw first: cd $OPENCLAW_SOURCE && pnpm build"
    exit 1
fi

# Create staging directory
STAGING_DIR=$(mktemp -d)
trap "rm -rf $STAGING_DIR" EXIT

echo "Staging OpenClaw files..."

# Copy Dockerfile and entrypoint
cp "$RUNTIME_DIR/Dockerfile" "$STAGING_DIR/"
cp "$RUNTIME_DIR/entrypoint.sh" "$STAGING_DIR/"

# Copy dist
cp -r "$OPENCLAW_SOURCE/dist" "$STAGING_DIR/"

# Copy package.json
cp "$OPENCLAW_SOURCE/package.json" "$STAGING_DIR/"

# Copy docs/reference/templates (required for agent workspace)
echo "Copying templates..."
mkdir -p "$STAGING_DIR/docs/reference"
cp -r "$OPENCLAW_SOURCE/docs/reference/templates" "$STAGING_DIR/docs/reference/"

# Copy bundled plugins (curated set for the store)
mkdir -p "$STAGING_DIR/extensions"

PLUGINS_TO_BUNDLE=(
    "memory-core"
    "memory-lancedb"
    "discord"
    "telegram"
    "slack"
    "whatsapp"
    "imessage"
    "msteams"
    "voice-call"
    "matrix"
    "googlechat"
)

for plugin in "${PLUGINS_TO_BUNDLE[@]}"; do
    if [ -d "$OPENCLAW_SOURCE/extensions/$plugin" ]; then
        echo "Copying ${plugin} plugin..."
        rsync -a \
            --exclude='node_modules' \
            --exclude='.git' \
            "$OPENCLAW_SOURCE/extensions/$plugin/" "$STAGING_DIR/extensions/$plugin/"
    else
        echo "WARNING: ${plugin} plugin not found in OpenClaw source."
    fi
done

# Copy node_modules (production only)
echo "Copying node_modules (this may take a moment)..."
mkdir -p "$STAGING_DIR/node_modules"
rsync -a \
    --exclude='.cache' \
    --exclude='*.map' \
    --exclude='test' \
    --exclude='tests' \
    --exclude='.git' \
    "$OPENCLAW_SOURCE/node_modules/" "$STAGING_DIR/node_modules/"

# Security scan - check for actual secrets in config files only
echo ""
echo "Running security scan..."
if find "$STAGING_DIR" -type f \( -name "*.env" -o -name "*.json" -o -name "*.yaml" -o -name "*.yml" -o -name "*.toml" \) \
    -exec grep -lE "sk-[a-zA-Z0-9]{40,}|key-[a-zA-Z0-9]{40,}" {} \; 2>/dev/null | head -5 | grep -q .; then
    echo "ERROR: Potential secrets found! Aborting."
    exit 1
fi
echo "Security scan passed."

# Build container
echo ""
echo "Building container image..."
docker build -t openclaw-runtime:latest "$STAGING_DIR"

echo ""
echo "=== OpenClaw runtime image built: openclaw-runtime:latest ==="
docker images openclaw-runtime:latest
