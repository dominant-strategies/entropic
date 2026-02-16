#!/bin/bash
set -e

echo "🏗️  Building Nova for end-user testing..."
echo ""

USER_UID="$(id -u)"
TMP_BASE="${TMPDIR:-/tmp}"
TMP_BASE="${TMP_BASE%/}"
if [[ -z "$TMP_BASE" ]]; then
    TMP_BASE="/tmp"
fi
FALLBACK_COLIMA_HOME_SHARED="/Users/Shared/nova/colima-${USER_UID}"
FALLBACK_COLIMA_HOME_TMP="${TMP_BASE}/nova-colima-${USER_UID}"
FALLBACK_RUNTIME_HOME_SHARED="/Users/Shared/nova/home-${USER_UID}"
FALLBACK_RUNTIME_HOME_TMP="${TMP_BASE}/nova-home-${USER_UID}"

# Change to project root (parent of scripts directory)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

echo "📁 Working directory: $PROJECT_ROOT"
echo ""

# ============================================
# 0. PRE-FLIGHT CHECK: DOCKER RUNNING?
# ============================================

echo "🔍 Checking if Docker is available..."

# Unset DOCKER_HOST to use Docker Desktop if it's running
# (User might have stale DOCKER_HOST from previous Colima usage)
if [ -n "$DOCKER_HOST" ]; then
    echo "  ℹ️  Unsetting DOCKER_HOST (was: $DOCKER_HOST)"
    unset DOCKER_HOST
fi

echo "  Docker path: $(which docker 2>&1 || echo 'not found')"
echo ""

# Try docker info and capture both stdout and stderr
echo "  Running: docker info..."
if docker info > /tmp/docker-check.out 2> /tmp/docker-check.err; then
    echo "✅ Docker is running"
else
    echo ""
    echo "❌ Docker is not running!"
    echo ""
    echo "Debug info:"
    echo "  Exit code: $?"
    if [ -s /tmp/docker-check.err ]; then
        echo "  Error output:"
        cat /tmp/docker-check.err | head -5 | sed 's/^/    /'
    fi
    echo ""
    echo "You need Docker running to build the OpenClaw runtime image."
    echo "Choose one option:"
    echo ""
    echo "Option 1 - Use Docker Desktop (if installed):"
    echo "   → Open Docker Desktop app"
    echo ""
    echo "Option 2 - Install Homebrew Colima temporarily:"
    echo "   brew install colima"
    echo "   colima start --cpu 4 --memory 8 --vm-type vz"
    echo ""
    echo "Then run this script again."
    rm -f /tmp/docker-check.out /tmp/docker-check.err
    exit 1
fi

rm -f /tmp/docker-check.out /tmp/docker-check.err

# ============================================
# 1. INSTALL DEPENDENCIES
# ============================================

echo ""
echo "📦 Installing dependencies..."

if [ ! -d "node_modules" ]; then
    pnpm install
else
    echo "✅ Dependencies already installed"
fi

# ============================================
# 2. CHECK OPENCLAW
# ============================================

echo ""
echo "🔍 Locating OpenClaw..."

# Try to find OpenClaw in common locations
OPENCLAW_LOCATIONS=(
    "../openclaw"
    "../../openclaw"
    "$HOME/agent/openclaw"
    "$HOME/quai/openclaw"
)

OPENCLAW_SOURCE=""
for loc in "${OPENCLAW_LOCATIONS[@]}"; do
    # Expand ~ if present
    expanded=$(eval echo "$loc")
    if [ -d "$expanded/dist" ]; then
        OPENCLAW_SOURCE="$expanded"
        echo "✅ Found OpenClaw at: $OPENCLAW_SOURCE"
        break
    fi
done

if [ -z "$OPENCLAW_SOURCE" ]; then
    echo "❌ ERROR: OpenClaw not found in any of these locations:"
    for loc in "${OPENCLAW_LOCATIONS[@]}"; do
        echo "   - $(eval echo "$loc")"
    done
    echo ""
    echo "Clone and build OpenClaw first:"
    echo "   cd ~/agent  # or ~/quai or any directory"
    echo "   git clone https://github.com/dominant-strategies/openclaw"
    echo "   cd openclaw"
    echo "   pnpm install"
    echo "   pnpm build"
    echo ""
    echo "Then make sure it's in one of the above locations."
    exit 1
fi

# ============================================
# 3. BUILD OPENCLAW RUNTIME IMAGE
# ============================================

echo ""
echo "🐳 Building OpenClaw runtime image..."

# Pass the found location to the build script
export OPENCLAW_SOURCE
"$PROJECT_ROOT/scripts/build-openclaw-runtime.sh"

echo "✅ OpenClaw runtime image built"

# Check image exists
if ! docker image inspect openclaw-runtime:latest > /dev/null 2>&1; then
    echo "❌ ERROR: openclaw-runtime:latest image not found after build"
    exit 1
fi

# ============================================
# 4. RUN THE STANDARD BUILD SCRIPT
# ============================================

echo ""
echo "🚀 Running standard cross-platform build..."
echo "   (ignoring code signing warnings - not needed for testing)"
echo ""

# Run build script, ignore signing errors (exit code 1 from signing)
"$PROJECT_ROOT/scripts/build-cross-platform.sh" || {
    # Check if the app was actually built despite the signing error
    if [ ! -d "src-tauri/target/release/bundle/macos/Nova.app" ]; then
        echo ""
        echo "❌ Build failed - app bundle not created"
        exit 1
    fi
    echo ""
    echo "⚠️  Build completed but code signing failed (this is OK for testing)"
}

# ============================================
# 5. COPY RUNTIME IMAGE INTO APP BUNDLE
# ============================================

echo ""
echo "📦 Copying runtime image into app bundle..."

APP_RESOURCES="src-tauri/target/release/bundle/macos/Nova.app/Contents/Resources"

if [ -f "src-tauri/resources/openclaw-runtime.tar.gz" ]; then
    cp "src-tauri/resources/openclaw-runtime.tar.gz" "$APP_RESOURCES/"
    echo "✅ Runtime image copied into app"
else
    echo "❌ ERROR: Runtime image not found at src-tauri/resources/openclaw-runtime.tar.gz"
    exit 1
fi

# ============================================
# DONE
# ============================================

echo ""
echo "✅ Build complete!"
echo ""
echo "📦 Bundled app location:"
if [ -d "src-tauri/target/release/bundle/macos/Nova.app" ]; then
    APP_PATH="src-tauri/target/release/bundle/macos/Nova.app"
    echo "   $APP_PATH"
    du -sh "$APP_PATH"
else
    echo "   ❌ App not found!"
    exit 1
fi

# Show what's bundled
echo ""
echo "📦 Bundled resources:"
echo "   Colima:  $(ls -lh src-tauri/resources/bin/colima 2>/dev/null | awk '{print $5}' || echo 'missing')"
echo "   Lima:    $(ls -lh src-tauri/resources/bin/limactl 2>/dev/null | awk '{print $5}' || echo 'missing')"
echo "   Docker:  $(ls -lh src-tauri/resources/bin/docker 2>/dev/null | awk '{print $5}' || echo 'missing')"
echo "   Runtime: $(ls -lh "$APP_RESOURCES/openclaw-runtime.tar.gz" 2>/dev/null | awk '{print $5}' || echo 'missing')"

echo ""
echo "🎯 To test as end user:"
echo ""
echo "   1. STOP Docker Desktop (or colima stop)"
echo ""
echo "   2. Clean Nova's isolated runtime locations:"
echo "      rm -rf ~/.nova/colima ~/.nova/colima-dev"
echo "      rm -rf ${FALLBACK_COLIMA_HOME_SHARED} ${FALLBACK_COLIMA_HOME_TMP}"
echo "      rm -rf ${FALLBACK_RUNTIME_HOME_SHARED} ${FALLBACK_RUNTIME_HOME_TMP}"
echo ""
echo "   3. Kill all old Colima processes:"
echo "      pkill -f colima || true"
echo "      pkill -f lima || true"
echo ""
echo "   4. Launch the app:"
echo "      open src-tauri/target/release/bundle/macos/Nova.app"
echo ""
echo "   5. Monitor startup logs (in another terminal):"
echo "      tail -f ~/nova-runtime.log"
echo ""
echo "The app will start its own isolated Colima and load the bundled runtime!"
