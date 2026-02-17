#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Auto-detect dev runtime Docker socket if DOCKER_HOST is not already set
if [ -z "${DOCKER_HOST:-}" ]; then
    DEV_SOCK="$HOME/.nova/colima-dev/nova-vz/docker.sock"
    PROD_SOCK="$HOME/.nova/colima/nova-vz/docker.sock"
    if [ -S "$DEV_SOCK" ]; then
        export DOCKER_HOST="unix://$DEV_SOCK"
    elif [ -S "$PROD_SOCK" ]; then
        export DOCKER_HOST="unix://$PROD_SOCK"
    fi
fi

echo "=== Building Skill Scanner Container ==="
docker build -t nova-skill-scanner:latest "$PROJECT_ROOT/skill-scanner"
echo "=== Skill Scanner image built: nova-skill-scanner:latest ==="
docker images nova-skill-scanner:latest
