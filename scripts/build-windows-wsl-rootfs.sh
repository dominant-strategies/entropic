#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RUNTIME_DIR="$PROJECT_ROOT/src-tauri/resources/runtime"
OUTPUT="${ENTROPIC_WINDOWS_WSL_ROOTFS_OUTPUT:-$RUNTIME_DIR/entropic-runtime.tar}"
BASE_IMAGE="${ENTROPIC_WINDOWS_WSL_ROOTFS_IMAGE:-ubuntu:24.04}"
PLATFORM="${ENTROPIC_WINDOWS_WSL_ROOTFS_PLATFORM:-linux/amd64}"
CONTAINER_NAME="entropic-windows-rootfs-$$"

cleanup() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$RUNTIME_DIR"

if ! docker info >/dev/null 2>&1; then
    echo "ERROR: Docker daemon is not ready on the build host." >&2
    exit 1
fi

echo "=== Building Windows WSL rootfs ==="
echo "Base image: $BASE_IMAGE"
echo "Platform:   $PLATFORM"
echo "Output:     $OUTPUT"
echo ""

docker pull --platform "$PLATFORM" "$BASE_IMAGE" >/dev/null
docker create --platform "$PLATFORM" --name "$CONTAINER_NAME" "$BASE_IMAGE" bash -lc "sleep infinity" >/dev/null
docker start "$CONTAINER_NAME" >/dev/null

docker exec "$CONTAINER_NAME" bash -lc '
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

cat >/usr/sbin/policy-rc.d <<'"'"'POLICY'"'"'
#!/bin/sh
exit 101
POLICY
chmod 755 /usr/sbin/policy-rc.d

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  dbus \
  docker.io \
  iproute2 \
  iptables \
  kmod \
  procps \
  uidmap

mkdir -p /etc/docker /var/lib/docker /var/run
cat >/etc/docker/daemon.json <<'"'"'JSON'"'"'
{
  "features": {
    "buildkit": true
  },
  "hosts": [
    "unix:///var/run/docker.sock"
  ]
}
JSON

cat >/etc/wsl.conf <<'"'"'CONF'"'"'
[interop]
enabled=false
appendWindowsPath=false

[network]
generateResolvConf=true
CONF

rm -f /usr/sbin/policy-rc.d
apt-get clean
rm -rf /var/lib/apt/lists/*
'

rm -f "$OUTPUT"
docker export "$CONTAINER_NAME" -o "$OUTPUT"

if [ ! -s "$OUTPUT" ]; then
    echo "ERROR: Rootfs export failed: $OUTPUT is empty." >&2
    exit 1
fi

echo "WSL rootfs created at $OUTPUT"
