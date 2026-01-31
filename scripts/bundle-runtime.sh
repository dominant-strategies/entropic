#!/bin/bash
set -euo pipefail

# Bundle container runtime for macOS or Linux
# - macOS: Colima + Lima (VM-based Docker)
# - Linux: Just Docker CLI (Docker runs natively)
#
# Usage:
#   ./bundle-runtime.sh              # Auto-detect OS/arch
#   ./bundle-runtime.sh darwin arm64 # Cross-compile for macOS ARM
#   ./bundle-runtime.sh darwin x86_64 # Cross-compile for macOS Intel
#   ./bundle-runtime.sh linux x86_64  # Target Linux

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_BASE="$PROJECT_ROOT/src-tauri/resources"
RESOURCES_BIN="$RESOURCES_BASE/bin"

mkdir -p "$RESOURCES_BIN"

# Allow override via arguments or env vars
TARGET_OS="${1:-${TARGET_OS:-$(uname -s | tr '[:upper:]' '[:lower:]')}}"
TARGET_ARCH="${2:-${TARGET_ARCH:-$(uname -m)}}"

# Normalize OS name
case "$TARGET_OS" in
    darwin|Darwin|macos|macOS)
        OS="Darwin"
        ;;
    linux|Linux)
        OS="Linux"
        ;;
    *)
        OS="$TARGET_OS"
        ;;
esac

ARCH="$TARGET_ARCH"

case "$ARCH" in
    x86_64)
        ARCH_NORMALIZED="x86_64"
        ;;
    arm64|aarch64)
        ARCH_NORMALIZED="aarch64"
        ;;
    *)
        echo "Unsupported architecture: $ARCH"
        exit 1
        ;;
esac

if [ "$OS" = "Darwin" ]; then
    # macOS needs Colima + Lima for Docker
    COLIMA_VERSION="0.9.1"
    LIMA_VERSION="2.0.3"

    echo "=== macOS: Bundling Colima + Lima ==="

    # Map architecture names - both use arm64 for Darwin ARM
    case "$ARCH_NORMALIZED" in
        aarch64|arm64)
            COLIMA_ARCH="arm64"
            LIMA_ARCH="arm64"
            ;;
        x86_64)
            COLIMA_ARCH="x86_64"
            LIMA_ARCH="x86_64"
            ;;
        *)
            echo "Unsupported architecture for macOS: $ARCH_NORMALIZED"
            exit 1
            ;;
    esac

    # Download Colima
    COLIMA_URL="https://github.com/abiosoft/colima/releases/download/v${COLIMA_VERSION}/colima-Darwin-${COLIMA_ARCH}"
    echo "Downloading Colima v${COLIMA_VERSION} for ${COLIMA_ARCH}..."
    curl -fSL -o "$RESOURCES_BIN/colima" "$COLIMA_URL"
    chmod +x "$RESOURCES_BIN/colima"

    # Download Lima (full installation including templates)
    LIMA_URL="https://github.com/lima-vm/lima/releases/download/v${LIMA_VERSION}/lima-${LIMA_VERSION}-Darwin-${LIMA_ARCH}.tar.gz"
    echo "Downloading Lima v${LIMA_VERSION} for ${LIMA_ARCH}..."
    LIMA_TMP=$(mktemp -d)
    curl -fSL -o "$LIMA_TMP/lima.tar.gz" "$LIMA_URL"
    tar -xzf "$LIMA_TMP/lima.tar.gz" -C "$LIMA_TMP"

    # Copy limactl binary
    cp "$LIMA_TMP/bin/limactl" "$RESOURCES_BIN/"
    chmod +x "$RESOURCES_BIN/limactl"

    # Create 'lima' wrapper script (like the official installation)
    # This wrapper passes commands to limactl shell
    cat > "$RESOURCES_BIN/lima" << 'LIMA_WRAPPER'
#!/bin/bash
# Lima wrapper script - executes commands inside the default Lima VM
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/limactl" shell "${LIMA_INSTANCE:-default}" "$@"
LIMA_WRAPPER
    chmod +x "$RESOURCES_BIN/lima"

    # Copy Lima share directory (contains templates needed by Colima)
    # This goes in resources/share, not resources/bin/share
    mkdir -p "$RESOURCES_BASE/share"
    cp -r "$LIMA_TMP/share/lima" "$RESOURCES_BASE/share/"

    rm -rf "$LIMA_TMP"

    # Download Docker CLI (static binary)
    # Docker provides static builds at https://download.docker.com/mac/static/stable/
    DOCKER_VERSION="27.5.1"
    case "$COLIMA_ARCH" in
        arm64)
            DOCKER_ARCH="aarch64"
            ;;
        x86_64)
            DOCKER_ARCH="x86_64"
            ;;
    esac
    DOCKER_URL="https://download.docker.com/mac/static/stable/${DOCKER_ARCH}/docker-${DOCKER_VERSION}.tgz"
    echo "Downloading Docker CLI v${DOCKER_VERSION} for ${DOCKER_ARCH}..."
    DOCKER_TMP=$(mktemp -d)
    curl -fSL -o "$DOCKER_TMP/docker.tgz" "$DOCKER_URL"
    tar -xzf "$DOCKER_TMP/docker.tgz" -C "$DOCKER_TMP"
    cp "$DOCKER_TMP/docker/docker" "$RESOURCES_BIN/"
    chmod +x "$RESOURCES_BIN/docker"
    rm -rf "$DOCKER_TMP"

    echo "Colima + Lima + Docker CLI bundled for macOS"

elif [ "$OS" = "Linux" ]; then
    echo "=== Linux: Docker runs natively ==="
    echo "No VM runtime needed - Docker daemon runs directly on Linux."
    echo "Users need Docker installed (docker.io or docker-ce package)."

    # Create a helper script to check Docker
    cat > "$RESOURCES_BIN/check-docker.sh" << 'EOF'
#!/bin/bash
if command -v docker &> /dev/null; then
    if docker info &> /dev/null; then
        echo "Docker is ready"
        exit 0
    else
        echo "Docker is installed but not running or no permission"
        echo "Try: sudo systemctl start docker"
        echo "Or add yourself to docker group: sudo usermod -aG docker $USER"
        exit 1
    fi
else
    echo "Docker is not installed"
    echo "Install with: sudo apt install docker.io"
    exit 1
fi
EOF
    chmod +x "$RESOURCES_BIN/check-docker.sh"

    echo "Linux helper script created"
else
    echo "Unsupported OS: $OS"
    exit 1
fi

echo ""
echo "Runtime bundled successfully for $OS/$ARCH_NORMALIZED"
