#!/bin/bash
set -euo pipefail

# Build Zara on a remote macOS machine via SSH
#
# Usage:
#   ./scripts/build-remote-mac.sh <user@host>
#   REMOTE_MAC_HOST=user@host ./scripts/build-remote-mac.sh
#
# Example:
#   ./scripts/build-remote-mac.sh builder@mac-mini.local

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
REMOTE_HOST="${1:-${REMOTE_MAC_HOST:-}}"
REMOTE_DIR="~/zara-build"

if [ -z "$REMOTE_HOST" ]; then
    echo "ERROR: Remote host not specified."
    echo ""
    echo "Usage: $0 <user@host>"
    echo "   or: REMOTE_MAC_HOST=user@host $0"
    echo ""
    echo "Example: $0 builder@mac-mini.local"
    exit 1
fi

echo "=== Remote macOS Build ==="
echo "Host: $REMOTE_HOST"
echo "Remote directory: $REMOTE_DIR"
echo ""

# Step 1: Check SSH connectivity
echo "Step 1: Checking SSH connection..."
if ! ssh -o ConnectTimeout=5 "$REMOTE_HOST" "echo 'Connected to macOS build host'"; then
    echo "ERROR: Cannot connect to $REMOTE_HOST"
    echo "Make sure SSH is enabled and the host is reachable."
    exit 1
fi

# Step 2: Check prerequisites on remote
echo ""
echo "Step 2: Checking prerequisites on remote..."
ssh "$REMOTE_HOST" bash << 'PREREQ_CHECK'
set -e

# Source cargo and nvm for non-interactive shell
[ -f ~/.cargo/env ] && source ~/.cargo/env
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

echo "  Checking Rust..."
if ! command -v cargo &> /dev/null; then
    echo "ERROR: Rust not installed. Run: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi
echo "  Rust: $(rustc --version)"

echo "  Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js not installed. Run: brew install node"
    exit 1
fi
echo "  Node: $(node --version)"

echo "  Checking pnpm..."
if ! command -v pnpm &> /dev/null; then
    echo "  Installing pnpm..."
    npm install -g pnpm
fi
echo "  pnpm: $(pnpm --version)"

echo "  All prerequisites OK"
PREREQ_CHECK

# Step 3: Sync project files to remote
echo ""
echo "Step 3: Syncing project files to remote..."
ssh "$REMOTE_HOST" "mkdir -p $REMOTE_DIR"

# Sync everything except build artifacts and node_modules
rsync -avz --progress \
    --exclude 'node_modules' \
    --exclude 'target' \
    --exclude 'dist' \
    --exclude '.git' \
    --exclude '*.dmg' \
    --exclude '*.app' \
    "$PROJECT_ROOT/" "$REMOTE_HOST:$REMOTE_DIR/"

# Step 4: Run build on remote
echo ""
echo "Step 4: Running build on remote macOS..."
ssh "$REMOTE_HOST" bash << REMOTE_BUILD
set -e

# Source cargo and nvm for non-interactive shell
[ -f ~/.cargo/env ] && source ~/.cargo/env
export NVM_DIR="\$HOME/.nvm"
[ -s "\$NVM_DIR/nvm.sh" ] && \. "\$NVM_DIR/nvm.sh"

cd $REMOTE_DIR

echo "Installing dependencies..."
pnpm install

echo ""
echo "Bundling runtime (Colima + Lima)..."
./scripts/bundle-runtime.sh

echo ""
echo "Building frontend..."
pnpm build

echo ""
echo "Building Tauri app..."
pnpm tauri build

echo ""
echo "Build complete on remote!"
ls -la src-tauri/target/release/bundle/
REMOTE_BUILD

# Step 5: Copy artifacts back
echo ""
echo "Step 5: Copying build artifacts back..."
mkdir -p "$PROJECT_ROOT/dist-macos"

# Copy app bundle
rsync -avz --progress \
    "$REMOTE_HOST:$REMOTE_DIR/src-tauri/target/release/bundle/macos/" \
    "$PROJECT_ROOT/dist-macos/"

echo ""
echo "=== Build Complete ==="
echo ""
echo "macOS artifacts:"
ls -la "$PROJECT_ROOT/dist-macos/"
echo ""
echo "To create a DMG manually, run:"
echo "  hdiutil create -volname Zara -srcfolder dist-macos/Zara.app -ov -format UDZO dist-macos/Zara.dmg"
