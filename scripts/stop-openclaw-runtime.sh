#!/bin/bash
set -euo pipefail

# Stop OpenClaw core container

CONTAINER_NAME="openclaw-core"

echo "Stopping OpenClaw core..."

if docker ps -q -f name="$CONTAINER_NAME" | grep -q .; then
    docker stop "$CONTAINER_NAME"
    echo "Stopped."
else
    echo "Container not running."
fi
