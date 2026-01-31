#!/bin/bash
set -euo pipefail

# Bundle Node.js for macOS or Linux

NODE_VERSION="22.11.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/src-tauri/resources/bin"

mkdir -p "$RESOURCES_DIR"

# Detect OS and architecture
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$ARCH" in
    x86_64)
        NODE_ARCH="x64"
        ;;
    arm64|aarch64)
        NODE_ARCH="arm64"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${OS}-${NODE_ARCH}.tar.gz"

echo "Downloading Node.js v${NODE_VERSION} for ${OS}/${NODE_ARCH}..."
NODE_TMP=$(mktemp -d)
curl -L -o "$NODE_TMP/node.tar.gz" "$NODE_URL"
tar -xzf "$NODE_TMP/node.tar.gz" -C "$NODE_TMP"

# Copy node binary
cp "$NODE_TMP/node-v${NODE_VERSION}-${OS}-${NODE_ARCH}/bin/node" "$RESOURCES_DIR/"
chmod +x "$RESOURCES_DIR/node"

rm -rf "$NODE_TMP"

echo "Node.js bundled successfully: $RESOURCES_DIR/node"
