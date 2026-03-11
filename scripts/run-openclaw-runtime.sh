#!/bin/bash
set -euo pipefail

# Run OpenClaw core container with hardened settings

CONTAINER_NAME="openclaw-core"
IMAGE="openclaw-runtime:latest"
DATA_VOLUME="entropic-openclaw-data"
PORT="${OPENCLAW_PORT:-18789}"
BROWSER_HOST_PORT="${ENTROPIC_BROWSER_HOST_PORT:-19792}"
BROWSER_DESKTOP_HOST_PORT="${ENTROPIC_BROWSER_DESKTOP_HOST_PORT:-19793}"
REMOTE_DESKTOP_UI="${ENTROPIC_BROWSER_REMOTE_DESKTOP_UI:-0}"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}=== Starting OpenClaw Core ===${NC}"
echo ""

# Check if image exists
if ! docker image inspect "$IMAGE" &>/dev/null; then
    echo -e "${RED}ERROR: Image $IMAGE not found.${NC}"
    echo "Run: ./scripts/build-openclaw-runtime.sh first"
    exit 1
fi

# Stop existing container
if docker ps -q -f name="$CONTAINER_NAME" | grep -q .; then
    echo "Stopping existing container..."
    docker stop "$CONTAINER_NAME" >/dev/null
fi
docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

# Create data volume if needed
docker volume create "$DATA_VOLUME" >/dev/null 2>&1 || true

echo "Starting hardened container..."
echo ""

docker_args=(
    run -d
    --name "$CONTAINER_NAME"
    --user 1000:1000
    --cap-drop=ALL
    --security-opt no-new-privileges
    --read-only
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=100m
    --tmpfs /run:rw,noexec,nosuid,nodev,size=10m
    -v "$DATA_VOLUME":/data
    -e "ENTROPIC_BROWSER_HOST_PORT=${BROWSER_HOST_PORT}"
    -e "ENTROPIC_BROWSER_HEADFUL=1"
    -e "ENTROPIC_BROWSER_DESKTOP_PORT=19793"
    -e "ENTROPIC_BROWSER_DESKTOP_HOST_PORT=${BROWSER_DESKTOP_HOST_PORT}"
    -e "ENTROPIC_BROWSER_REMOTE_DESKTOP_UI=${REMOTE_DESKTOP_UI}"
    -e "ENTROPIC_BROWSER_ALLOW_UNSAFE_NO_SANDBOX=0"
    -e "ENTROPIC_BROWSER_ALLOW_INSECURE_SECURE_CONTEXTS=0"
    -e "ENTROPIC_BROWSER_BIND=0.0.0.0"
    -p "127.0.0.1:${PORT}:18789"
    -p "127.0.0.1:${BROWSER_HOST_PORT}:19791"
    --restart unless-stopped
    --health-cmd="curl -sf http://localhost:18789/health || exit 1"
    --health-interval=10s
    --health-timeout=3s
    --health-start-period=10s
)

if [ "$REMOTE_DESKTOP_UI" = "1" ]; then
    docker_args+=(-p "127.0.0.1:${BROWSER_DESKTOP_HOST_PORT}:19793")
fi

docker_args+=("$IMAGE")

# Run with hardened settings
docker "${docker_args[@]}"

echo "Container started: $CONTAINER_NAME"
echo ""

# Wait for health
echo "Waiting for gateway to be ready..."
for i in {1..30}; do
    if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
        echo -e "${GREEN}OpenClaw gateway is ready at http://127.0.0.1:${PORT}${NC}"
        exit 0
    fi
    sleep 1
done

echo -e "${YELLOW}Warning: Gateway may not be ready yet. Check logs:${NC}"
echo "  docker logs $CONTAINER_NAME"
