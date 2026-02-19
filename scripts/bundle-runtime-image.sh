#!/usr/bin/env bash
set -euo pipefail

# Export a Docker image as a compressed tar for app bundling.
# Defaults:
# - IMAGE=openclaw-runtime:latest
# - OUTPUT=src-tauri/resources/openclaw-runtime.tar.gz

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RUNTIME_COMMON="$SCRIPT_DIR/runtime-common.sh"
RESOURCES_DIR="$PROJECT_ROOT/src-tauri/resources"
IMAGE="${IMAGE:-openclaw-runtime:latest}"
OUTPUT="${OUTPUT:-$RESOURCES_DIR/openclaw-runtime.tar.gz}"

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

if [ -n "${DOCKER_HOST:-}" ]; then
    ACTIVE_DOCKER_HOST="$DOCKER_HOST"
else
    ACTIVE_DOCKER_HOST="$(entropic_resolve_mode_docker_host "$DOCKER_BIN" || true)"
fi

if [ -z "$ACTIVE_DOCKER_HOST" ] && [ -n "$COLIMA_BIN" ]; then
    ACTIVE_DOCKER_HOST="$(entropic_start_colima_for_mode "$DOCKER_BIN" "$COLIMA_BIN" "$PROJECT_ROOT" || true)"
fi

if [ -z "$ACTIVE_DOCKER_HOST" ] && ! entropic_default_context_allowed; then
    echo "ERROR: No $(entropic_mode_label) Colima Docker host is available for bundling."
    echo "Set ENTROPIC_BUILD_ALLOW_DOCKER_DESKTOP=1 for one-off Docker Desktop fallback."
    exit 1
fi

run_docker() {
    if [ -n "$ACTIVE_DOCKER_HOST" ]; then
        DOCKER_HOST="$ACTIVE_DOCKER_HOST" "$DOCKER_BIN" "$@"
    else
        "$DOCKER_BIN" "$@"
    fi
}

echo "=== Exporting Docker image for bundling ==="
echo "Mode: $(entropic_runtime_mode)"
echo "Colima home: $ENTROPIC_COLIMA_HOME"
echo "Image: $IMAGE"
echo "Output: $OUTPUT"
echo ""

# Check image exists
if ! run_docker image inspect "$IMAGE" > /dev/null 2>&1; then
    echo "ERROR: Image '$IMAGE' not found in selected runtime daemon."
    echo "Build it first: ./scripts/build-openclaw-runtime.sh"
    exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"

# Show image size
IMAGE_SIZE=$(run_docker image inspect "$IMAGE" --format '{{.Size}}')
IMAGE_SIZE_MB=$((IMAGE_SIZE / 1024 / 1024))
echo "Image size: ${IMAGE_SIZE_MB}MB (uncompressed)"
echo ""

echo "Exporting and compressing (this may take a minute)..."
run_docker save "$IMAGE" | gzip -1 > "$OUTPUT"

OUTPUT_SIZE=$(stat -f%z "$OUTPUT" 2>/dev/null || stat -c%s "$OUTPUT" 2>/dev/null)
OUTPUT_SIZE_MB=$((OUTPUT_SIZE / 1024 / 1024))
echo ""
echo "✅ Image exported: $OUTPUT (${OUTPUT_SIZE_MB}MB compressed)"
