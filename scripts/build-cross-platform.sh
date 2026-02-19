#!/usr/bin/env bash
set -euo pipefail

# Cross-platform Entropic build script
# Automatically detects platform and bundles appropriate runtime

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PLATFORM=$(uname -s)
ARCH=$(uname -m)

cd "$PROJECT_ROOT"

echo "=== Entropic Cross-Platform Build ==="
echo "Platform: $PLATFORM"
echo "Architecture: $ARCH"
echo "=================================="

# Clean previous builds
echo "Cleaning previous resources..."
rm -rf src-tauri/resources/
rm -rf src-tauri/target/release/bundle/

case "$PLATFORM" in
    "Darwin")
        echo "Building for macOS with Colima runtime..."

        # Bundle macOS-specific runtime
        echo "Bundling Colima + Lima + Docker CLI..."
        pnpm bundle:runtime

        # Bundle the OpenClaw runtime Docker image (if available)
        if docker image inspect openclaw-runtime:latest > /dev/null 2>&1; then
            echo "Bundling OpenClaw runtime image..."
            pnpm bundle:runtime-image
        else
            echo "⚠️  openclaw-runtime:latest image not found locally."
            echo "   The app will pull it from the registry on first launch."
            echo "   To bundle it: ./scripts/build-openclaw-runtime.sh && pnpm bundle:runtime-image"
        fi

        # Verify macOS runtime components
        echo "Verifying bundled components:"
        ls -lah src-tauri/resources/bin/ | head -10

        echo "Building macOS app bundle..."
        pnpm tauri build

        # Copy bundled runtime image into the app bundle (if available)
        # Tauri doesn't support optional resources, so we copy it post-build
        APP_RESOURCES="src-tauri/target/release/bundle/macos/Entropic.app/Contents/Resources"
        if [ -f src-tauri/resources/openclaw-runtime.tar.gz ]; then
            echo "Copying bundled runtime image into app..."
            cp src-tauri/resources/openclaw-runtime.tar.gz "$APP_RESOURCES/"
        elif [ -f src-tauri/resources/openclaw-runtime.tar ]; then
            echo "Copying bundled runtime image into app..."
            cp src-tauri/resources/openclaw-runtime.tar "$APP_RESOURCES/"
        fi

        # Show build results
        echo ""
        echo "✅ macOS Build Complete!"
        echo "📦 Location: src-tauri/target/release/bundle/macos/Entropic.app"
        du -sh src-tauri/target/release/bundle/macos/Entropic.app
        echo ""
        echo "Runtime components included:"
        echo "  ✅ Colima (container runtime)"
        echo "  ✅ Lima (virtualization)"
        echo "  ✅ Docker CLI"
        if [ -f src-tauri/resources/openclaw-runtime.tar.gz ]; then
            echo "  ✅ OpenClaw runtime image (bundled)"
        else
            echo "  ⚠️  OpenClaw runtime image (will pull from registry)"
        fi
        echo "  ✅ Self-contained - no Docker Desktop required"
        ;;

    "Linux")
        echo "Building for Linux with native Docker runtime..."

        # For Linux, we only need Docker CLI (uses native Docker daemon)
        echo "Bundling Docker CLI for Linux..."
        pnpm bundle:docker

        # Note: Linux doesn't need Colima - uses native Docker
        echo "Linux build uses native Docker daemon (no Colima needed)"

        # Verify Linux runtime components
        echo "Verifying bundled components:"
        ls -lah src-tauri/resources/bin/ | head -10

        echo "Building Linux AppImage/DEB..."
        pnpm tauri build

        # Show build results
        echo ""
        echo "✅ Linux Build Complete!"
        echo "📦 Locations:"
        find src-tauri/target/release/bundle/ -name "*.AppImage" -o -name "*.deb" | head -5
        echo ""
        echo "Runtime components included:"
        echo "  ✅ Docker CLI"
        echo "  ✅ Uses native Docker daemon"
        echo "  ⚠️  Requires: Docker Engine installed on target system"
        ;;

    *)
        echo "❌ Unsupported platform: $PLATFORM"
        echo "Supported platforms: Darwin (macOS), Linux"
        exit 1
        ;;
esac

echo ""
echo "🎉 Build completed for $PLATFORM!"
echo "Files ready for distribution and testing."
