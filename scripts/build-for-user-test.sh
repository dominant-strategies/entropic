#!/usr/bin/env bash
set -euo pipefail

echo "🏗️  Building Entropic for end-user testing (production mode)..."
echo ""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RUNTIME_COMMON="$SCRIPT_DIR/runtime-common.sh"

if [ ! -f "$RUNTIME_COMMON" ]; then
    echo "ERROR: Missing runtime helper: $RUNTIME_COMMON" >&2
    exit 1
fi

export ENTROPIC_RUNTIME_MODE=prod
source "$RUNTIME_COMMON"
export ENTROPIC_COLIMA_HOME="${ENTROPIC_COLIMA_HOME:-$(entropic_default_colima_home)}"

cd "$PROJECT_ROOT"

DOCKER_BIN=""
COLIMA_BIN=""
ACTIVE_DOCKER_HOST=""

refresh_binaries() {
    DOCKER_BIN="$(entropic_find_docker_binary "$PROJECT_ROOT" || true)"
    COLIMA_BIN="$(entropic_find_colima_binary "$PROJECT_ROOT" || true)"
}

run_docker() {
    if [ -z "$DOCKER_BIN" ]; then
        echo "ERROR: Docker CLI not found." >&2
        return 1
    fi
    if [ -n "$ACTIVE_DOCKER_HOST" ]; then
        DOCKER_HOST="$ACTIVE_DOCKER_HOST" "$DOCKER_BIN" "$@"
    else
        "$DOCKER_BIN" "$@"
    fi
}

bundled_runtime_ready() {
    [ -x "$PROJECT_ROOT/src-tauri/resources/bin/colima" ] || return 1
    [ -x "$PROJECT_ROOT/src-tauri/resources/bin/limactl" ] || return 1
    [ -x "$PROJECT_ROOT/src-tauri/resources/bin/docker" ] || return 1
    [ -d "$PROJECT_ROOT/src-tauri/resources/share/lima" ] || return 1
    return 0
}

ensure_bundled_runtime() {
    if bundled_runtime_ready; then
        return 0
    fi

    echo "📦 Bundled runtime binaries missing. Running bundle-runtime.sh..."
    "$PROJECT_ROOT/scripts/bundle-runtime.sh"
}

ensure_prod_docker_ready() {
    refresh_binaries
    if [ -z "$DOCKER_BIN" ]; then
        echo "ERROR: Docker CLI not found (system or bundled)." >&2
        return 1
    fi

    ACTIVE_DOCKER_HOST="$(entropic_resolve_mode_docker_host "$DOCKER_BIN" || true)"
    if [ -z "$ACTIVE_DOCKER_HOST" ] && [ -n "$COLIMA_BIN" ]; then
        echo "🐳 Starting production Colima runtime..."
        ACTIVE_DOCKER_HOST="$(entropic_start_colima_for_mode "$DOCKER_BIN" "$COLIMA_BIN" "$PROJECT_ROOT" || true)"
    fi

    if [ -n "$ACTIVE_DOCKER_HOST" ]; then
        echo "🐳 Using production Docker host: $ACTIVE_DOCKER_HOST"
        return 0
    fi

    if entropic_default_context_allowed && "$DOCKER_BIN" info >/dev/null 2>&1; then
        echo "⚠️  Using default Docker context because ENTROPIC_BUILD_ALLOW_DOCKER_DESKTOP=1."
        return 0
    fi

    echo "ERROR: Production Colima daemon is not reachable."
    echo "Colima home: $ENTROPIC_COLIMA_HOME"
    echo "Set ENTROPIC_BUILD_ALLOW_DOCKER_DESKTOP=1 only for one-off Desktop fallback."
    return 1
}

echo "Mode: $(entropic_runtime_mode)"
echo "Colima home: $ENTROPIC_COLIMA_HOME"
echo ""

# ============================================
# 1. Ensure dependencies + runtime binaries
# ============================================
echo "📦 Installing dependencies..."
if [ ! -d "node_modules" ]; then
    pnpm install
else
    echo "✅ Dependencies already installed"
fi

ensure_bundled_runtime
refresh_binaries

# ============================================
# 2. Locate OpenClaw source
# ============================================
echo ""
echo "🔍 Locating OpenClaw..."

OPENCLAW_LOCATIONS=(
    "../openclaw"
    "../../openclaw"
    "$HOME/agent/openclaw"
    "$HOME/quai/openclaw"
)

OPENCLAW_SOURCE=""
for loc in "${OPENCLAW_LOCATIONS[@]}"; do
    expanded="$(eval echo "$loc")"
    if [ -d "$expanded/dist" ]; then
        OPENCLAW_SOURCE="$expanded"
        echo "✅ Found OpenClaw at: $OPENCLAW_SOURCE"
        break
    fi
done

if [ -z "$OPENCLAW_SOURCE" ]; then
    echo "❌ ERROR: OpenClaw not found in expected locations."
    printf '   - %s\n' "${OPENCLAW_LOCATIONS[@]}"
    exit 1
fi

# ============================================
# 3. Ensure production Docker daemon
# ============================================
echo ""
echo "🔍 Checking production Docker daemon..."
ensure_prod_docker_ready

# ============================================
# 4. Build runtime images in production daemon
# ============================================
echo ""
echo "🐳 Building OpenClaw runtime image (prod daemon)..."
ENTROPIC_RUNTIME_MODE=prod \
ENTROPIC_COLIMA_HOME="$ENTROPIC_COLIMA_HOME" \
DOCKER_HOST="$ACTIVE_DOCKER_HOST" \
OPENCLAW_SOURCE="$OPENCLAW_SOURCE" \
    "$PROJECT_ROOT/scripts/build-openclaw-runtime.sh"

echo ""
echo "🔍 Building Skill Scanner image (prod daemon)..."
ENTROPIC_RUNTIME_MODE=prod \
ENTROPIC_COLIMA_HOME="$ENTROPIC_COLIMA_HOME" \
DOCKER_HOST="$ACTIVE_DOCKER_HOST" \
    "$PROJECT_ROOT/scripts/build-skill-scanner.sh"

if ! run_docker image inspect openclaw-runtime:latest >/dev/null 2>&1; then
    echo "❌ ERROR: openclaw-runtime:latest image missing after build"
    exit 1
fi
if ! run_docker image inspect entropic-skill-scanner:latest >/dev/null 2>&1; then
    echo "❌ ERROR: entropic-skill-scanner:latest image missing after build"
    exit 1
fi

# ============================================
# 5. Build app bundle
# ============================================
echo ""
echo "🚀 Running cross-platform build..."
if [ -n "$ACTIVE_DOCKER_HOST" ]; then
    DOCKER_HOST="$ACTIVE_DOCKER_HOST" "$PROJECT_ROOT/scripts/build-cross-platform.sh" || {
        if [ ! -d "src-tauri/target/release/bundle/macos/Entropic.app" ]; then
            echo "❌ Build failed: app bundle not created"
            exit 1
        fi
        echo "⚠️  Build completed with signing warnings (acceptable for user testing)."
    }
else
    "$PROJECT_ROOT/scripts/build-cross-platform.sh" || {
        if [ ! -d "src-tauri/target/release/bundle/macos/Entropic.app" ]; then
            echo "❌ Build failed: app bundle not created"
            exit 1
        fi
        echo "⚠️  Build completed with signing warnings (acceptable for user testing)."
    }
fi

# ============================================
# 6. Export runtime tars from production daemon
# ============================================
echo ""
echo "📦 Exporting production runtime images..."

ENTROPIC_RUNTIME_MODE=prod \
ENTROPIC_COLIMA_HOME="$ENTROPIC_COLIMA_HOME" \
DOCKER_HOST="$ACTIVE_DOCKER_HOST" \
OUTPUT="$PROJECT_ROOT/src-tauri/resources/openclaw-runtime.tar.gz" \
    "$PROJECT_ROOT/scripts/bundle-runtime-image.sh"

ENTROPIC_RUNTIME_MODE=prod \
ENTROPIC_COLIMA_HOME="$ENTROPIC_COLIMA_HOME" \
DOCKER_HOST="$ACTIVE_DOCKER_HOST" \
IMAGE="entropic-skill-scanner:latest" \
OUTPUT="$PROJECT_ROOT/src-tauri/resources/entropic-skill-scanner.tar.gz" \
    "$PROJECT_ROOT/scripts/bundle-runtime-image.sh"

# ============================================
# 7. Copy exported tars into app bundle
# ============================================
echo ""
echo "📦 Copying runtime images into app bundle..."
APP_RESOURCES="src-tauri/target/release/bundle/macos/Entropic.app/Contents/Resources"

if [ ! -d "$APP_RESOURCES" ]; then
    echo "❌ ERROR: App resources directory not found: $APP_RESOURCES"
    exit 1
fi

cp "$PROJECT_ROOT/src-tauri/resources/openclaw-runtime.tar.gz" "$APP_RESOURCES/"
cp "$PROJECT_ROOT/src-tauri/resources/entropic-skill-scanner.tar.gz" "$APP_RESOURCES/"

# ============================================
# Done
# ============================================
echo ""
echo "✅ Production user-test build complete."
echo "📦 App: src-tauri/target/release/bundle/macos/Entropic.app"
du -sh "src-tauri/target/release/bundle/macos/Entropic.app"
echo ""
echo "Bundled resources:"
echo "  Colima:  $(ls -lh src-tauri/resources/bin/colima 2>/dev/null | awk '{print $5}' || echo 'missing')"
echo "  Lima:    $(ls -lh src-tauri/resources/bin/limactl 2>/dev/null | awk '{print $5}' || echo 'missing')"
echo "  Docker:  $(ls -lh src-tauri/resources/bin/docker 2>/dev/null | awk '{print $5}' || echo 'missing')"
echo "  Runtime: $(ls -lh "$APP_RESOURCES/openclaw-runtime.tar.gz" 2>/dev/null | awk '{print $5}' || echo 'missing')"
echo "  Scanner: $(ls -lh "$APP_RESOURCES/entropic-skill-scanner.tar.gz" 2>/dev/null | awk '{print $5}' || echo 'missing')"
