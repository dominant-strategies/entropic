#!/bin/bash
set -e

echo "🧹 Cleaning up for fresh end-user experience test..."

NOVA_COLIMA_HOME="${NOVA_COLIMA_HOME:-$HOME/.nova/colima-dev}"
LEGACY_COLIMA_HOME="$HOME/.nova/colima"
NOVA_RUNTIME_HOME="${NOVA_RUNTIME_HOME:-$HOME}"
USER_UID="$(id -u)"
FALLBACK_COLIMA_HOME_SHARED="/Users/Shared/nova/colima-${USER_UID}"
FALLBACK_COLIMA_HOME_TMP="/tmp/nova-colima-${USER_UID}"
FALLBACK_RUNTIME_HOME_SHARED="/Users/Shared/nova/home-${USER_UID}"
FALLBACK_RUNTIME_HOME_TMP="/tmp/nova-home-${USER_UID}"
echo ""

# ============================================
# 1. KILL RUNNING NOVA PROCESSES & UNMOUNT DMGS
# ============================================

echo "🛑 Stopping all Nova processes..."

# Kill all Nova app instances
echo "  → Killing Nova processes..."
pkill -9 -i nova 2>/dev/null || true

# Kill Colima and Lima processes
echo "  → Killing Colima/Lima processes..."
pkill -9 limactl 2>/dev/null || true
pkill -9 colima 2>/dev/null || true

# Unmount any mounted Nova DMGs
echo "  → Unmounting Nova DMGs..."
for dmg in "/Volumes/Nova"*; do
    if [ -d "$dmg" ]; then
        hdiutil detach "$dmg" -force 2>/dev/null || true
    fi
done

echo "✅ All processes stopped and DMGs unmounted"

# ============================================
# 2. CLEAN NOVA'S ISOLATED RUNTIME
# ============================================

echo "🗑️  Cleaning Nova's isolated runtime..."

# Nova uses NOVA_COLIMA_HOME as isolated home - just delete it
echo "  → Removing $NOVA_COLIMA_HOME..."
rm -rf "$NOVA_COLIMA_HOME"

# Backward-compatible cleanup for legacy paths
echo "  → Removing legacy $LEGACY_COLIMA_HOME..."
rm -rf "$LEGACY_COLIMA_HOME"

# Cleanup fallback Colima homes used when user home contains whitespace
echo "  → Removing fallback $FALLBACK_COLIMA_HOME_SHARED..."
rm -rf "$FALLBACK_COLIMA_HOME_SHARED"
echo "  → Removing fallback $FALLBACK_COLIMA_HOME_TMP..."
rm -rf "$FALLBACK_COLIMA_HOME_TMP"

# Cleanup fallback runtime HOME locations used by bundled Colima/Lima commands
if [[ "$NOVA_RUNTIME_HOME" != "$HOME" ]]; then
    echo "  → Removing NOVA_RUNTIME_HOME override $NOVA_RUNTIME_HOME..."
    rm -rf "$NOVA_RUNTIME_HOME"
fi
echo "  → Removing fallback $FALLBACK_RUNTIME_HOME_SHARED..."
rm -rf "$FALLBACK_RUNTIME_HOME_SHARED"
echo "  → Removing fallback $FALLBACK_RUNTIME_HOME_TMP..."
rm -rf "$FALLBACK_RUNTIME_HOME_TMP"

echo "✅ Nova runtime cleaned"

# ============================================
# 3. CLEAN GLOBAL COLIMA (optional)
# ============================================

echo ""
echo "🌍 Cleaning global Colima state (if any)..."

# Try to stop global colima if command exists
if command -v colima &> /dev/null; then
    echo "  → Stopping global colima..."
    colima stop 2>/dev/null || true
    colima delete -f 2>/dev/null || true
    echo "  → Global colima stopped"
fi

# Remove directories even if command doesn't exist
rm -rf ~/.colima
rm -rf ~/.lima

echo "✅ Global Colima state cleaned"

# ============================================
# 4. DOCKER CLEANUP
# ============================================

echo ""
echo "🐳 Cleaning Docker resources..."

# Make sure we're using a working Docker context
docker context use desktop-linux 2>/dev/null || docker context use default 2>/dev/null || true

# Check if Docker is accessible
if docker info &> /dev/null; then
    # Stop and remove nova containers
    echo "  → Stopping Nova containers..."
    NOVA_CONTAINERS=$(docker ps -aq --filter "name=nova" 2>/dev/null)
    if [ -n "$NOVA_CONTAINERS" ]; then
        echo "$NOVA_CONTAINERS" | xargs docker stop 2>/dev/null || true
        echo "$NOVA_CONTAINERS" | xargs docker rm -f 2>/dev/null || true
    fi
    
    OPENCLAW_CONTAINERS=$(docker ps -aq --filter "name=openclaw" 2>/dev/null)
    if [ -n "$OPENCLAW_CONTAINERS" ]; then
        echo "$OPENCLAW_CONTAINERS" | xargs docker rm -f 2>/dev/null || true
    fi
    
    # Remove nova images (but keep openclaw-runtime:latest for bundling)
    echo "  → Removing Nova images (keeping openclaw-runtime for bundling)..."
    NOVA_IMAGES=$(docker images -q "nova-*" 2>/dev/null)
    if [ -n "$NOVA_IMAGES" ]; then
        echo "$NOVA_IMAGES" | xargs docker rmi -f 2>/dev/null || true
    fi
    
    # Remove nova volumes
    echo "  → Removing Nova volumes..."
    NOVA_VOLUMES=$(docker volume ls -q --filter "name=nova" 2>/dev/null)
    if [ -n "$NOVA_VOLUMES" ]; then
        echo "$NOVA_VOLUMES" | xargs docker volume rm 2>/dev/null || true
    fi
    
    # Remove nova networks
    echo "  → Removing Nova networks..."
    docker network rm nova-net 2>/dev/null || true
    
    echo "✅ Docker resources cleaned"
else
    echo "  ⚠️  Docker not accessible (this is OK for testing)"
fi

# ============================================
# 5. PROJECT BUILD ARTIFACTS
# ============================================

echo ""
echo "📦 Cleaning project build artifacts..."

cd "$(dirname "$0")"

# JavaScript artifacts
echo "  → Removing node_modules..."
rm -rf node_modules

echo "  → Removing dist..."
rm -rf dist

echo "  → Removing .build..."
rm -rf .build

# Rust artifacts (large!)
echo "  → Removing Rust target directory (~14GB)..."
rm -rf src-tauri/target

echo "  → Removing generated files..."
rm -rf src-tauri/gen

# Cargo clean
echo "  → Running cargo clean..."
cargo clean --manifest-path src-tauri/Cargo.toml 2>/dev/null || true

# ============================================
# 6. REMOVE OLD BUNDLED RESOURCES
# ============================================

echo ""
echo "🗑️  Removing old bundled resources..."
rm -rf src-tauri/resources/bin/*
rm -rf src-tauri/resources/share/*
rm -f src-tauri/resources/openclaw-runtime.tar.gz

# ============================================
# 7. CLEAN APP LOGS
# ============================================

echo ""
echo "📝 Cleaning runtime logs..."
rm -f ~/nova-runtime.log

# ============================================
# DONE
# ============================================

echo ""
echo "✅ Complete cleanup done!"
echo ""
echo "📊 Current state:"
echo "  • ${NOVA_COLIMA_HOME}: $([ -d "$NOVA_COLIMA_HOME" ] && echo "EXISTS" || echo "REMOVED ✓")"
echo "  • ${LEGACY_COLIMA_HOME}: $([ -d "$LEGACY_COLIMA_HOME" ] && echo "EXISTS" || echo "REMOVED ✓")"
echo "  • ${FALLBACK_COLIMA_HOME_SHARED}: $([ -d "$FALLBACK_COLIMA_HOME_SHARED" ] && echo "EXISTS" || echo "REMOVED ✓")"
echo "  • ${FALLBACK_COLIMA_HOME_TMP}: $([ -d "$FALLBACK_COLIMA_HOME_TMP" ] && echo "EXISTS" || echo "REMOVED ✓")"
echo "  • ${FALLBACK_RUNTIME_HOME_SHARED}: $([ -d "$FALLBACK_RUNTIME_HOME_SHARED" ] && echo "EXISTS" || echo "REMOVED ✓")"
echo "  • ${FALLBACK_RUNTIME_HOME_TMP}: $([ -d "$FALLBACK_RUNTIME_HOME_TMP" ] && echo "EXISTS" || echo "REMOVED ✓")"
echo "  • ~/.colima: $([ -d ~/.colima ] && echo "EXISTS" || echo "REMOVED ✓")"
echo "  • src-tauri/target: $([ -d src-tauri/target ] && echo "EXISTS" || echo "REMOVED ✓")"
echo "  • node_modules: $([ -d node_modules ] && echo "EXISTS" || echo "REMOVED ✓")"
echo ""
echo "🎯 Next steps:"
echo ""
echo "1. Make sure Docker is running:"
echo "   docker context use desktop-linux"
echo "   # Open Docker Desktop if not running"
echo ""
echo "2. Run the build:"
echo "   ./build-for-user-test.sh"
