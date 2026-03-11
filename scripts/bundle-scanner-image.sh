#!/usr/bin/env bash
set -euo pipefail

# Export scanner Docker image as a compressed tar for app bundling.
# Defaults:
# - IMAGE=entropic-skill-scanner:<tag> (auto-computed from scanner config)
# - OUTPUT=src-tauri/resources/entropic-skill-scanner.tar.gz

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RUNTIME_COMMON="$SCRIPT_DIR/runtime-common.sh"
RESOURCES_DIR="$PROJECT_ROOT/src-tauri/resources"
OUTPUT="${OUTPUT:-$RESOURCES_DIR/entropic-skill-scanner.tar.gz}"
GZIP_LEVEL="${ENTROPIC_IMAGE_GZIP_LEVEL:-6}"

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

normalize_gzip_level() {
    if [[ ! "$GZIP_LEVEL" =~ ^[1-9]$ ]]; then
        echo "WARNING: Invalid ENTROPIC_IMAGE_GZIP_LEVEL='$GZIP_LEVEL'; defaulting to 6."
        GZIP_LEVEL=6
    fi
}

compress_stream() {
    if command -v pigz >/dev/null 2>&1; then
        pigz "-${GZIP_LEVEL}"
    else
        gzip "-${GZIP_LEVEL}"
    fi
}

# Determine the scanner image name (matches the tag computed by scanner_image_name() in commands.rs)
# Default base and pip spec from commands.rs
SCANNER_BASE_IMAGE="${ENTROPIC_SCANNER_BASE_IMAGE:-python:3.11-slim}"
SCANNER_GIT_REPO="${ENTROPIC_SCANNER_GIT_REPO:-https://github.com/cisco-ai-defense/skill-scanner.git}"
SCANNER_GIT_COMMIT="${ENTROPIC_SCANNER_GIT_COMMIT:-dff88dc5fa0fff6382ddb6eff19d245745b93f7a}"
SCANNER_PIP_SPEC="${ENTROPIC_SCANNER_PIP_SPEC:-git+${SCANNER_GIT_REPO}@${SCANNER_GIT_COMMIT}}"

# Compute the image tag (SHA256 hash of base+pip like Rust code does)
HASH_INPUT="${SCANNER_BASE_IMAGE}|${SCANNER_PIP_SPEC}"
TAG=$(printf "%s" "$HASH_INPUT" | shasum -a 256 | head -c 12)
SCANNER_IMAGE="entropic-skill-scanner:${TAG}"

# Allow override via IMAGE env var
SCANNER_IMAGE="${IMAGE:-$SCANNER_IMAGE}"

echo "=== Exporting Scanner Image for Bundling ==="
echo "Mode: $(entropic_runtime_mode)"
echo "Colima home: $ENTROPIC_COLIMA_HOME"
echo "Image: $SCANNER_IMAGE"
echo "Output: $OUTPUT"
echo ""

# Check if image exists with computed tag
if ! run_docker image inspect "$SCANNER_IMAGE" > /dev/null 2>&1; then
    # Try finding :latest and tagging it
    echo "Scanner image '$SCANNER_IMAGE' not found, checking for :latest..."
    if run_docker image inspect "entropic-skill-scanner:latest" > /dev/null 2>&1; then
        echo "Found entropic-skill-scanner:latest, tagging as $SCANNER_IMAGE..."
        run_docker tag "entropic-skill-scanner:latest" "$SCANNER_IMAGE"
    else
        echo "ERROR: Scanner image not found (tried $SCANNER_IMAGE and :latest)."
        echo "Build it first: ./scripts/build-skill-scanner.sh"
        exit 1
    fi
fi

mkdir -p "$(dirname "$OUTPUT")"
normalize_gzip_level

# Show image size
IMAGE_SIZE=$(run_docker image inspect "$SCANNER_IMAGE" --format '{{.Size}}')
IMAGE_SIZE_MB=$((IMAGE_SIZE / 1024 / 1024))
echo "Image size: ${IMAGE_SIZE_MB}MB (uncompressed)"
echo ""

echo "Exporting and compressing with gzip level ${GZIP_LEVEL} (this may take a minute)..."
run_docker save "$SCANNER_IMAGE" | compress_stream > "$OUTPUT"

OUTPUT_SIZE=$(stat -f%z "$OUTPUT" 2>/dev/null || stat -c%s "$OUTPUT" 2>/dev/null)
OUTPUT_SIZE_MB=$((OUTPUT_SIZE / 1024 / 1024))
echo ""
echo "✅ Scanner image exported: $OUTPUT (${OUTPUT_SIZE_MB}MB compressed)"
