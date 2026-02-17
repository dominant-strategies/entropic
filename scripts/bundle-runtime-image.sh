#!/bin/bash
set -euo pipefail

# Export the openclaw-runtime Docker image as a compressed tar for bundling
# into the app. This allows the app to load the image on first launch without
# requiring an internet connection or a registry pull.
#
# The resulting file lands in src-tauri/resources/openclaw-runtime.tar.gz
# and Tauri will bundle it into the .app/Resources directory automatically
# (via the "resources" key in tauri.conf.json).
#
# Usage:
#   ./scripts/bundle-runtime-image.sh           # export openclaw-runtime:latest
#   IMAGE=myregistry/rt:v1 ./scripts/bundle-runtime-image.sh  # custom image
#   IMAGE=nova-skill-scanner:latest OUTPUT=src-tauri/resources/nova-skill-scanner.tar.gz ./scripts/bundle-runtime-image.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/src-tauri/resources"
IMAGE="${IMAGE:-openclaw-runtime:latest}"
OUTPUT="${OUTPUT:-$RESOURCES_DIR/openclaw-runtime.tar.gz}"

# Auto-detect the Colima Docker socket so this script finds images that were
# built inside a Colima VM even when no DOCKER_HOST is set in the environment.
if [ -z "${DOCKER_HOST:-}" ]; then
    for _sock in \
        "$HOME/.nova/colima-dev/nova-vz/docker.sock" \
        "$HOME/.nova/colima-dev/nova-qemu/docker.sock" \
        "$HOME/.nova/colima/nova-vz/docker.sock" \
        "$HOME/.nova/colima/nova-qemu/docker.sock"; do
        if [ -S "$_sock" ]; then
            export DOCKER_HOST="unix://$_sock"
            break
        fi
    done
fi

echo "=== Exporting Docker image for bundling ==="
echo "Image: $IMAGE"
echo "Output: $OUTPUT"
echo ""

# Check image exists
if ! docker image inspect "$IMAGE" > /dev/null 2>&1; then
    echo "ERROR: Image '$IMAGE' not found."
    echo "Build it first: ./scripts/build-openclaw-runtime.sh"
    exit 1
fi

mkdir -p "$RESOURCES_DIR"

# Show image size
IMAGE_SIZE=$(docker image inspect "$IMAGE" --format '{{.Size}}')
IMAGE_SIZE_MB=$((IMAGE_SIZE / 1024 / 1024))
echo "Image size: ${IMAGE_SIZE_MB}MB (uncompressed)"
echo ""

echo "Exporting and compressing (this may take a minute)..."
docker save "$IMAGE" | gzip -1 > "$OUTPUT"

OUTPUT_SIZE=$(stat -f%z "$OUTPUT" 2>/dev/null || stat -c%s "$OUTPUT" 2>/dev/null)
OUTPUT_SIZE_MB=$((OUTPUT_SIZE / 1024 / 1024))
echo ""
echo "✅ Image exported: $OUTPUT (${OUTPUT_SIZE_MB}MB compressed)"
echo ""
echo "The image will be bundled into the app and loaded on first launch."
echo "To skip bundling the image (pull from registry instead), delete:"
echo "  rm $OUTPUT"
