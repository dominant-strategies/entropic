#!/bin/bash
set -euo pipefail

# Bundle Colima binary for macOS
# Downloads the appropriate binary for the target architecture

COLIMA_VERSION="0.8.1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/src-tauri/resources/bin"

mkdir -p "$RESOURCES_DIR"

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
    x86_64)
        COLIMA_ARCH="x86_64"
        ;;
    arm64|aarch64)
        COLIMA_ARCH="arm64"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

COLIMA_URL="https://github.com/abiosoft/colima/releases/download/v${COLIMA_VERSION}/colima-Darwin-${COLIMA_ARCH}"

echo "Downloading Colima v${COLIMA_VERSION} for ${COLIMA_ARCH}..."
curl -L -o "$RESOURCES_DIR/colima" "$COLIMA_URL"
chmod +x "$RESOURCES_DIR/colima"

echo "Colima bundled successfully: $RESOURCES_DIR/colima"

# Also download Lima (dependency)
LIMA_VERSION="0.23.2"
LIMA_URL="https://github.com/lima-vm/lima/releases/download/v${LIMA_VERSION}/lima-${LIMA_VERSION}-Darwin-${COLIMA_ARCH}.tar.gz"

echo "Downloading Lima v${LIMA_VERSION}..."
LIMA_TMP=$(mktemp -d)
curl -L -o "$LIMA_TMP/lima.tar.gz" "$LIMA_URL"
tar -xzf "$LIMA_TMP/lima.tar.gz" -C "$LIMA_TMP"

# Copy Lima binaries
cp "$LIMA_TMP/bin/limactl" "$RESOURCES_DIR/"
cp "$LIMA_TMP/bin/lima" "$RESOURCES_DIR/" 2>/dev/null || true
chmod +x "$RESOURCES_DIR/limactl"
[ -f "$RESOURCES_DIR/lima" ] && chmod +x "$RESOURCES_DIR/lima"

# Copy Lima share directory (templates)
SHARE_DIR="$PROJECT_ROOT/src-tauri/resources/share"
mkdir -p "$SHARE_DIR"
if [ -d "$LIMA_TMP/share/lima" ]; then
    cp -r "$LIMA_TMP/share/lima" "$SHARE_DIR/"
    echo "Lima templates copied to $SHARE_DIR/lima"
fi

rm -rf "$LIMA_TMP"

echo "Lima bundled successfully"
