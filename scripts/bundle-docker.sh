#!/bin/bash
set -euo pipefail

# Bundle Docker CLI for macOS or Linux

DOCKER_VERSION="24.0.7"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/src-tauri/resources/bin"

mkdir -p "$RESOURCES_DIR"

# Detect OS and architecture
OS=$(uname -s)
ARCH=$(uname -m)

case "$ARCH" in
    x86_64)
        DOCKER_ARCH="x86_64"
        ;;
    arm64|aarch64)
        DOCKER_ARCH="aarch64"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

case "$OS" in
    Darwin)
        DOCKER_URL="https://download.docker.com/mac/static/stable/${DOCKER_ARCH}/docker-${DOCKER_VERSION}.tgz"
        ;;
    Linux)
        DOCKER_URL="https://download.docker.com/linux/static/stable/${DOCKER_ARCH}/docker-${DOCKER_VERSION}.tgz"
        ;;
    *)
        echo "Unsupported OS: $OS"
        exit 1
        ;;
esac

echo "Downloading Docker CLI v${DOCKER_VERSION} for ${OS}/${DOCKER_ARCH}..."
DOCKER_TMP=$(mktemp -d)
curl -L -o "$DOCKER_TMP/docker.tgz" "$DOCKER_URL"
tar -xzf "$DOCKER_TMP/docker.tgz" -C "$DOCKER_TMP"

# Copy only the docker CLI binary (not the daemon)
cp "$DOCKER_TMP/docker/docker" "$RESOURCES_DIR/"
chmod +x "$RESOURCES_DIR/docker"

rm -rf "$DOCKER_TMP"

echo "Docker CLI bundled successfully: $RESOURCES_DIR/docker"
