#!/bin/bash
set -euo pipefail

# Bundle OpenClaw dist for the app
# SECURITY: This script explicitly excludes sensitive files

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/src-tauri/resources/openclaw"
OPENCLAW_SOURCE="${OPENCLAW_SOURCE:-$HOME/agent/clawdbot}"

# Files/patterns that should NEVER be bundled
SENSITIVE_PATTERNS=(
    ".env"
    ".env.*"
    "*.pem"
    "*.key"
    "*.p12"
    "*.pfx"
    "credentials*"
    "*secret*"
    "*token*"
    "*.session"
    "sessions/"
    ".clawdbot/"
    ".openclaw/"
    "config.json"
    "openclaw.json"
    ".secrets*"
    "*.credential*"
)

echo "=== OpenClaw Bundler (Secure) ==="
echo ""

mkdir -p "$RESOURCES_DIR"

if [ ! -d "$OPENCLAW_SOURCE/dist" ]; then
    echo "ERROR: OpenClaw dist not found at $OPENCLAW_SOURCE/dist"
    echo "Please build openclaw first: cd $OPENCLAW_SOURCE && pnpm build"
    exit 1
fi

# Pre-flight security scan of source
echo "Running security scan on source..."
FOUND_SENSITIVE=0
for pattern in "${SENSITIVE_PATTERNS[@]}"; do
    if find "$OPENCLAW_SOURCE/dist" -name "$pattern" 2>/dev/null | grep -q .; then
        echo "WARNING: Found potentially sensitive file matching '$pattern' in dist/"
        find "$OPENCLAW_SOURCE/dist" -name "$pattern" 2>/dev/null
        FOUND_SENSITIVE=1
    fi
done

if [ "$FOUND_SENSITIVE" -eq 1 ]; then
    echo ""
    echo "ERROR: Sensitive files detected in dist/. Aborting."
    echo "Please review and remove sensitive files before bundling."
    exit 1
fi

echo "Security scan passed."
echo ""

# Clean previous bundle
rm -rf "$RESOURCES_DIR"
mkdir -p "$RESOURCES_DIR"

echo "Copying OpenClaw dist..."

# Copy the built dist (compiled JS only, no source)
cp -r "$OPENCLAW_SOURCE/dist" "$RESOURCES_DIR/"

# Copy package.json for module resolution (check it first)
if grep -qiE "(token|secret|key|password|credential)" "$OPENCLAW_SOURCE/package.json"; then
    echo "WARNING: package.json may contain sensitive data. Please review."
fi
cp "$OPENCLAW_SOURCE/package.json" "$RESOURCES_DIR/"

# Copy node_modules with strict exclusions
if [ -d "$OPENCLAW_SOURCE/node_modules" ]; then
    echo "Copying node_modules (this may take a moment)..."
    rsync -a \
        --exclude='.cache' \
        --exclude='*.map' \
        --exclude='test' \
        --exclude='tests' \
        --exclude='.env*' \
        --exclude='*.pem' \
        --exclude='*.key' \
        --exclude='credentials*' \
        --exclude='.git' \
        "$OPENCLAW_SOURCE/node_modules" "$RESOURCES_DIR/"
fi

# Post-bundle security scan
echo ""
echo "Running post-bundle security scan..."
SECRETS_FOUND=0

# Check for common secret patterns in bundled files
if grep -rliE "(DISCORD_TOKEN|TELEGRAM_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|CLAUDE_API_KEY|sk-[a-zA-Z0-9]{20,})" "$RESOURCES_DIR" 2>/dev/null; then
    echo "ERROR: Potential API keys or tokens found in bundle!"
    SECRETS_FOUND=1
fi

# Check for .env files that slipped through
if find "$RESOURCES_DIR" -name ".env*" -type f 2>/dev/null | grep -q .; then
    echo "ERROR: .env files found in bundle!"
    find "$RESOURCES_DIR" -name ".env*" -type f
    SECRETS_FOUND=1
fi

if [ "$SECRETS_FOUND" -eq 1 ]; then
    echo ""
    echo "ERROR: Sensitive data detected in bundle. Cleaning up..."
    rm -rf "$RESOURCES_DIR"
    exit 1
fi

echo "Post-bundle scan passed."
echo ""
echo "OpenClaw bundled successfully: $RESOURCES_DIR"
echo ""

# Show size
echo "Bundle size:"
du -sh "$RESOURCES_DIR"
