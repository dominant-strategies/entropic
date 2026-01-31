#!/bin/bash
set -euo pipefail

# Bundle container runtime for macOS or Linux
# - macOS: Colima + Lima (VM-based Docker)
# - Linux: Just Docker CLI (Docker runs natively)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESOURCES_DIR="$PROJECT_ROOT/src-tauri/resources/bin"

mkdir -p "$RESOURCES_DIR"

OS=$(uname -s)
ARCH=$(uname -m)

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
    COLIMA_VERSION="0.6.8"
    LIMA_VERSION="0.20.1"

    echo "=== macOS: Bundling Colima + Lima ==="

    # Download Colima
    COLIMA_URL="https://github.com/abiosoft/colima/releases/download/v${COLIMA_VERSION}/colima-Darwin-${ARCH_NORMALIZED}"
    echo "Downloading Colima v${COLIMA_VERSION}..."
    curl -L -o "$RESOURCES_DIR/colima" "$COLIMA_URL"
    chmod +x "$RESOURCES_DIR/colima"

    # Download Lima
    LIMA_URL="https://github.com/lima-vm/lima/releases/download/v${LIMA_VERSION}/lima-${LIMA_VERSION}-Darwin-${ARCH_NORMALIZED}.tar.gz"
    echo "Downloading Lima v${LIMA_VERSION}..."
    LIMA_TMP=$(mktemp -d)
    curl -L -o "$LIMA_TMP/lima.tar.gz" "$LIMA_URL"
    tar -xzf "$LIMA_TMP/lima.tar.gz" -C "$LIMA_TMP"
    cp "$LIMA_TMP/bin/limactl" "$RESOURCES_DIR/"
    chmod +x "$RESOURCES_DIR/limactl"
    rm -rf "$LIMA_TMP"

    echo "Colima + Lima bundled for macOS"

elif [ "$OS" = "Linux" ]; then
    echo "=== Linux: Docker runs natively ==="
    echo "No VM runtime needed - Docker daemon runs directly on Linux."
    echo "Users need Docker installed (docker.io or docker-ce package)."

    # Create a helper script to check Docker
    cat > "$RESOURCES_DIR/check-docker.sh" << 'EOF'
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
    chmod +x "$RESOURCES_DIR/check-docker.sh"

    echo "Linux helper script created"
else
    echo "Unsupported OS: $OS"
    exit 1
fi

echo ""
echo "Runtime bundled successfully for $OS/$ARCH_NORMALIZED"
