#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
OUTPUT="${OUTPUT:-$PROJECT_ROOT/src-tauri/resources/runtime/entropic-runtime.tar}"
BASE_IMAGE="${ENTROPIC_WINDOWS_WSL_ROOTFS_IMAGE:-ubuntu:24.04}"
PLATFORM="${ENTROPIC_WINDOWS_WSL_ROOTFS_PLATFORM:-linux/amd64}"

mkdir -p "$(dirname -- "$OUTPUT")"

container_name="entropic-windows-rootfs-$$-$(date +%s)"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}

trap cleanup EXIT

echo "=== Building Windows WSL rootfs artifact ==="
echo "Base image: $BASE_IMAGE"
echo "Platform:   $PLATFORM"
echo "Output:     $OUTPUT"

docker pull --platform "$PLATFORM" "$BASE_IMAGE"
docker create --platform "$PLATFORM" --name "$container_name" "$BASE_IMAGE" /bin/sh >/dev/null
docker export --output "$OUTPUT" "$container_name"

if [ ! -s "$OUTPUT" ]; then
  echo "Windows WSL rootfs export failed: $OUTPUT is missing or empty" >&2
  exit 1
fi

echo "Windows WSL rootfs artifact ready:"
ls -lh "$OUTPUT"
