#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RUNTIME_COMMON="$SCRIPT_DIR/runtime-common.sh"

if [ ! -f "$RUNTIME_COMMON" ]; then
    echo "ERROR: Missing runtime helper: $RUNTIME_COMMON" >&2
    exit 1
fi

export ENTROPIC_RUNTIME_MODE="${ENTROPIC_RUNTIME_MODE:-dev}"
source "$RUNTIME_COMMON"
export ENTROPIC_COLIMA_HOME="${ENTROPIC_COLIMA_HOME:-$(entropic_default_colima_home)}"

DOCKER_BIN="$(entropic_find_docker_binary "$PROJECT_ROOT" || true)"
COLIMA_BIN="$(entropic_find_colima_binary "$PROJECT_ROOT" || true)"
ACTIVE_DOCKER_HOST=""

if [ -z "$DOCKER_BIN" ]; then
    echo "ERROR: Docker CLI not found." >&2
    exit 1
fi

ACTIVE_DOCKER_HOST="$(entropic_resolve_mode_docker_host "$DOCKER_BIN" || true)"

if [ -z "$ACTIVE_DOCKER_HOST" ] && [ -n "$COLIMA_BIN" ]; then
    echo "Starting Colima for $(entropic_mode_label) scanner build..."
    ACTIVE_DOCKER_HOST="$(entropic_start_colima_for_mode "$DOCKER_BIN" "$COLIMA_BIN" "$PROJECT_ROOT" || true)"
fi

if [ -z "$ACTIVE_DOCKER_HOST" ] && ! entropic_default_context_allowed; then
    echo "ERROR: No $(entropic_mode_label) Colima Docker host is available."
    echo "Set ENTROPIC_BUILD_ALLOW_DOCKER_DESKTOP=1 for one-off Docker Desktop fallback."
    exit 1
fi

echo "=== Building Skill Scanner Container ==="
echo "Mode: $(entropic_runtime_mode)"
echo "Colima home: $ENTROPIC_COLIMA_HOME"

if [ -n "$ACTIVE_DOCKER_HOST" ]; then
    DOCKER_HOST="$ACTIVE_DOCKER_HOST" "$DOCKER_BIN" build -t entropic-skill-scanner:latest "$PROJECT_ROOT/skill-scanner"
    echo "=== Skill scanner image built: entropic-skill-scanner:latest ==="
    DOCKER_HOST="$ACTIVE_DOCKER_HOST" "$DOCKER_BIN" images entropic-skill-scanner:latest
else
    "$DOCKER_BIN" build -t entropic-skill-scanner:latest "$PROJECT_ROOT/skill-scanner"
    echo "=== Skill scanner image built: entropic-skill-scanner:latest ==="
    "$DOCKER_BIN" images entropic-skill-scanner:latest
fi
