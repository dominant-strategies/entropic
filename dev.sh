#!/bin/bash
set -e

# Zara Development Environment
# Runs in Docker with Ubuntu 24.04 for latest dependencies
# Uses xauth for X11 isolation (container can display, but isolated auth)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER_NAME="zara-dev"
IMAGE_NAME="zara-dev:latest"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}=== Zara Development Environment ===${NC}"
echo ""

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo "Docker is not installed. Please install Docker first."
    exit 1
fi

# Setup xauth for X11 isolation
XAUTH=/tmp/.zara.xauth
if [ -n "$DISPLAY" ]; then
    echo "Setting up X11 authentication..."
    touch "$XAUTH"
    xauth nlist "$DISPLAY" 2>/dev/null | sed -e 's/^..../ffff/' | xauth -f "$XAUTH" nmerge - 2>/dev/null
    chmod 644 "$XAUTH"
fi

# Check if we need to build the dev image
if ! docker image inspect "$IMAGE_NAME" &> /dev/null; then
    echo -e "${YELLOW}Building development image (first time only)...${NC}"
    echo ""

    docker build -t "$IMAGE_NAME" -f - "$SCRIPT_DIR" << 'DOCKERFILE'
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies + Docker CLI
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    pkg-config \
    libwebkit2gtk-4.1-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    libssl-dev \
    git \
    docker.io \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm globally
RUN npm install -g pnpm

# Install Rust to a shared location
ENV RUSTUP_HOME=/opt/rust
ENV CARGO_HOME=/opt/rust
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
RUN chmod -R 755 /opt/rust

# Install Tauri CLI
ENV PATH="/opt/rust/bin:$PATH"
RUN cargo install tauri-cli
RUN chmod -R 755 /opt/rust

# Create writable directories for any user
RUN mkdir -p /home/user/.cargo \
    /home/user/.local/share/pnpm \
    /home/user/.cache \
    && chmod -R 777 /home/user

ENV HOME=/home/user
ENV PATH="/opt/rust/bin:$PATH"

WORKDIR /app

CMD ["bash"]
DOCKERFILE

    echo ""
    echo -e "${GREEN}Development image built successfully!${NC}"
fi

# Stop existing container if running
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# Detect Docker socket location
if [ -S "/var/run/docker.sock" ]; then
    DOCKER_SOCK="/var/run/docker.sock"
elif [ -S "$HOME/.colima/default/docker.sock" ]; then
    DOCKER_SOCK="$HOME/.colima/default/docker.sock"
elif [ -S "$HOME/.docker/run/docker.sock" ]; then
    DOCKER_SOCK="$HOME/.docker/run/docker.sock"
else
    echo -e "${YELLOW}Warning: Docker socket not found. Container-in-container won't work.${NC}"
    DOCKER_SOCK=""
fi

DOCKER_MOUNT=""
if [ -n "$DOCKER_SOCK" ]; then
    DOCKER_MOUNT="-v $DOCKER_SOCK:/var/run/docker.sock"
    echo "Docker socket: $DOCKER_SOCK"
fi

# X11 auth mount
XAUTH_MOUNT=""
if [ -f "$XAUTH" ]; then
    XAUTH_MOUNT="-v $XAUTH:/tmp/.xauth:ro -e XAUTHORITY=/tmp/.xauth"
    echo "X11 auth: $XAUTH (isolated)"
fi

echo ""
echo "Starting development container..."
echo ""

# Run the container as your UID
# Create shared network if it doesn't exist
docker network create zara-net 2>/dev/null || true

docker run -it --rm \
    --name "$CONTAINER_NAME" \
    --user "$(id -u):$(id -g)" \
    --network zara-net \
    -v "$SCRIPT_DIR":/app \
    -v zara-cargo-cache:/home/user/.cargo \
    -v zara-pnpm-cache:/home/user/.local/share/pnpm \
    -e CARGO_HOME=/home/user/.cargo \
    -e RUSTUP_HOME=/opt/rust \
    -e PATH="/opt/rust/bin:/home/user/.cargo/bin:/usr/local/bin:/usr/bin:/bin" \
    -e HOME=/home/user \
    -e PNPM_HOME=/home/user/.local/share/pnpm \
    $DOCKER_MOUNT \
    $XAUTH_MOUNT \
    -p 1420:1420 \
    -p 5174:5174 \
    -e DISPLAY="$DISPLAY" \
    -v /tmp/.X11-unix:/tmp/.X11-unix \
    "$IMAGE_NAME" \
    bash -c '
        echo ""
        echo "=== Zara Dev Container ==="
        echo ""
        echo "Commands:"
        echo "  pnpm install      - Install dependencies"
        echo "  pnpm dev          - Run React frontend only (http://localhost:5174)"
        echo "  pnpm tauri dev    - Run full Tauri app"
        echo "  pnpm tauri build  - Build release binary"
        echo ""
        echo "First time? Run: pnpm install"
        echo ""
        exec bash
    '
