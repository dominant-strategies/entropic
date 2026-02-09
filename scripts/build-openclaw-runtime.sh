#!/bin/bash
set -euo pipefail

# Build the OpenClaw core runtime container

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RUNTIME_DIR="$PROJECT_ROOT/openclaw-runtime"
OPENCLAW_SOURCE="${OPENCLAW_SOURCE:-$PROJECT_ROOT/../openclaw}"
NOVA_SKILLS_SOURCE="${NOVA_SKILLS_SOURCE:-$PROJECT_ROOT/../nova-skills}"

echo "=== Building OpenClaw Runtime Container ==="
echo ""

# Check if OpenClaw source exists
if [ ! -d "$OPENCLAW_SOURCE/dist" ]; then
    echo "ERROR: OpenClaw dist not found at $OPENCLAW_SOURCE/dist"
    echo "Please build openclaw first: cd $OPENCLAW_SOURCE && pnpm build"
    exit 1
fi

STAGING_DIR="$PROJECT_ROOT/.build/openclaw-runtime"
mkdir -p "$STAGING_DIR"

echo "Staging OpenClaw files..."

# Copy Dockerfile and entrypoint
rsync -a "$RUNTIME_DIR/Dockerfile" "$STAGING_DIR/Dockerfile"
rsync -a "$RUNTIME_DIR/entrypoint.sh" "$STAGING_DIR/entrypoint.sh"

# Copy dist
rsync -a --delete "$OPENCLAW_SOURCE/dist/" "$STAGING_DIR/dist/"

# Copy package.json
rsync -a "$OPENCLAW_SOURCE/package.json" "$STAGING_DIR/package.json"

# Copy docs/reference/templates (required for agent workspace)
echo "Copying templates..."
mkdir -p "$STAGING_DIR/docs/reference"
rsync -a --delete "$OPENCLAW_SOURCE/docs/reference/templates/" "$STAGING_DIR/docs/reference/templates/"

# Copy bundled plugins (curated set for the store)
mkdir -p "$STAGING_DIR/extensions"

PLUGINS_TO_BUNDLE=(
    "memory-core"
    "memory-lancedb"
    "nova-integrations"
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
        rsync -a --delete \
            --exclude='node_modules' \
            --exclude='.git' \
            "$OPENCLAW_SOURCE/extensions/$plugin/" "$STAGING_DIR/extensions/$plugin/"
    else
        echo "WARNING: ${plugin} plugin not found in OpenClaw source."
    fi
done

# Copy Nova-owned skills/plugins (optional)
if [ -d "$NOVA_SKILLS_SOURCE" ]; then
    echo "Copying Nova skills from $NOVA_SKILLS_SOURCE..."
    for plugin_dir in "$NOVA_SKILLS_SOURCE"/*; do
        if [ -d "$plugin_dir" ] && [ -f "$plugin_dir/openclaw.plugin.json" ]; then
            plugin_name="$(basename "$plugin_dir")"
            echo "Copying ${plugin_name} plugin..."
            rsync -a --delete \
                --exclude='node_modules' \
                --exclude='.git' \
                "$plugin_dir/" "$STAGING_DIR/extensions/$plugin_name/"
        fi
    done
else
    echo "No Nova skills directory found at $NOVA_SKILLS_SOURCE (skipping)."
fi

# Copy node_modules (production only)
echo "Copying node_modules (this may take a moment)..."
mkdir -p "$STAGING_DIR/node_modules"
rsync -a --delete \
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
export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"
docker build --cache-from openclaw-runtime:latest -t openclaw-runtime:latest "$STAGING_DIR"

echo ""
echo "=== OpenClaw runtime image built: openclaw-runtime:latest ==="
docker images openclaw-runtime:latest
