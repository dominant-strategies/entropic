#!/bin/bash
set -euo pipefail

# Build Nova release with all bundled dependencies
#
# Usage:
#   ./build-release.sh                           # Build for current platform
#   ./build-release.sh --target darwin-aarch64   # Cross-compile for macOS ARM
#   ./build-release.sh --target darwin-x86_64    # Cross-compile for macOS Intel
#   ./build-release.sh --target linux-x86_64     # Build for Linux

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_ROOT"

# Parse arguments
TARGET=""
TAURI_TARGET=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --target)
            TARGET="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done

# Map target to OS/arch for bundle script and Tauri
if [ -n "$TARGET" ]; then
    case "$TARGET" in
        darwin-aarch64|macos-arm64|aarch64-apple-darwin)
            TARGET_OS="darwin"
            TARGET_ARCH="arm64"
            TAURI_TARGET="aarch64-apple-darwin"
            ;;
        darwin-x86_64|macos-x86_64|x86_64-apple-darwin)
            TARGET_OS="darwin"
            TARGET_ARCH="x86_64"
            TAURI_TARGET="x86_64-apple-darwin"
            ;;
        linux-x86_64|x86_64-unknown-linux-gnu)
            TARGET_OS="linux"
            TARGET_ARCH="x86_64"
            TAURI_TARGET="x86_64-unknown-linux-gnu"
            ;;
        linux-aarch64|aarch64-unknown-linux-gnu)
            TARGET_OS="linux"
            TARGET_ARCH="aarch64"
            TAURI_TARGET="aarch64-unknown-linux-gnu"
            ;;
        *)
            echo "Unknown target: $TARGET"
            echo "Supported: darwin-aarch64, darwin-x86_64, linux-x86_64, linux-aarch64"
            exit 1
            ;;
    esac
    export TARGET_OS TARGET_ARCH
    echo "=== Nova Release Build (cross-compile for $TARGET) ==="
else
    echo "=== Nova Release Build ==="
fi
echo ""

# Step 1: Bundle runtime (Colima/Lima on macOS, Docker helper on Linux)
echo "Step 1: Bundling container runtime..."
"$SCRIPT_DIR/bundle-runtime.sh" ${TARGET_OS:-} ${TARGET_ARCH:-}

# Step 2: Bundle Docker CLI (if not using system docker)
# echo "Step 2: Bundling Docker CLI..."
# "$SCRIPT_DIR/bundle-docker.sh"

# Step 3: Build OpenClaw runtime image (for development/testing)
# In production, we'd ship a pre-built image or pull on first run
if [ "${SKIP_OPENCLAW_IMAGE:-}" != "1" ]; then
    echo ""
    echo "Step 2: Building OpenClaw runtime image..."
    "$SCRIPT_DIR/build-openclaw-runtime.sh"
fi

# Step 4: Build Tauri app
echo ""
echo "Step 3: Building Tauri application..."
pnpm build

if [ -n "${TAURI_TARGET:-}" ]; then
    echo "Cross-compiling for target: $TAURI_TARGET"
    pnpm tauri build --target "$TAURI_TARGET"
else
    pnpm tauri build
fi

echo ""
echo "=== Build Complete ==="
echo ""
echo "Output location:"
if [ -n "${TAURI_TARGET:-}" ]; then
    ls -la "$PROJECT_ROOT/src-tauri/target/$TAURI_TARGET/release/bundle/" 2>/dev/null || echo "Check src-tauri/target/$TAURI_TARGET/release/bundle/"
else
    ls -la "$PROJECT_ROOT/src-tauri/target/release/bundle/" 2>/dev/null || echo "Check src-tauri/target/release/bundle/"
fi
