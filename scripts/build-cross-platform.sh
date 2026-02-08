#!/usr/bin/env bash
set -euo pipefail

# Cross-platform Nova build script
# Automatically detects platform and bundles appropriate runtime

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PLATFORM=$(uname -s)
ARCH=$(uname -m)

cd "$PROJECT_ROOT"

echo "=== Nova Cross-Platform Build ==="
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
        echo "Bundling Colima + Docker CLI..."
        pnpm bundle:colima
        pnpm bundle:docker

        # Verify macOS runtime components
        echo "Verifying bundled components:"
        ls -lah src-tauri/resources/bin/ | head -10

        echo "Building macOS app bundle..."
        pnpm tauri build

        # Show build results
        echo ""
        echo "✅ macOS Build Complete!"
        echo "📦 Location: src-tauri/target/release/bundle/macos/Nova.app"
        du -sh src-tauri/target/release/bundle/macos/Nova.app
        echo ""
        echo "Runtime components included:"
        echo "  ✅ Colima (container runtime)"
        echo "  ✅ Lima (virtualization)"
        echo "  ✅ Docker CLI"
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