#!/usr/bin/env bash
set -euo pipefail

echo "🧹 Cleaning Entropic user-test environment (production mode only)..."
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

ENTROPIC_APP_DATA_DIR_MAC="$HOME/Library/Application Support/ai.openclaw.entropic"
LEGACY_NOVA_APP_DATA_DIR_MAC="$HOME/Library/Application Support/ai.openclaw.nova"
ENTROPIC_APP_DATA_DIR_LINUX="$HOME/.local/share/ai.openclaw.entropic"
LEGACY_NOVA_APP_DATA_DIR_LINUX="$HOME/.local/share/ai.openclaw.nova"

DOCKER_BIN="$(entropic_find_docker_binary "$PROJECT_ROOT" || true)"
COLIMA_BIN="$(entropic_find_colima_binary "$PROJECT_ROOT" || true)"
ACTIVE_DOCKER_HOST=""

run_docker() {
    if [ -z "$DOCKER_BIN" ]; then
        return 1
    fi
    if [ -n "$ACTIVE_DOCKER_HOST" ]; then
        DOCKER_HOST="$ACTIVE_DOCKER_HOST" "$DOCKER_BIN" "$@"
    else
        "$DOCKER_BIN" "$@"
    fi
}

# ============================================
# 1. Stop Entropic app processes and mounted DMGs
# ============================================
echo "🛑 Stopping Entropic app processes..."
if [ "${ENTROPIC_FORCE_KILL_APP:-0}" = "1" ]; then
    pkill -9 -i entropic 2>/dev/null || true
else
    echo "  ⚠️  Skipping process kill (set ENTROPIC_FORCE_KILL_APP=1 to force)."
fi

echo "📀 Unmounting Entropic DMGs..."
for dmg in "/Volumes/Entropic"*; do
    if [ -d "$dmg" ]; then
        hdiutil detach "$dmg" -force 2>/dev/null || true
    fi
done

# ============================================
# 2. Clean prod daemon containers/images/networks
# ============================================
echo ""
echo "🐳 Cleaning production runtime Docker artifacts..."

if [ -n "$DOCKER_BIN" ]; then
    ACTIVE_DOCKER_HOST="$(entropic_resolve_mode_docker_host "$DOCKER_BIN" || true)"
fi

if [ -n "$ACTIVE_DOCKER_HOST" ]; then
    echo "Using Docker host: $ACTIVE_DOCKER_HOST"

    run_docker stop entropic-openclaw entropic-skill-scanner nova-openclaw nova-skill-scanner 2>/dev/null || true
    run_docker rm -f entropic-openclaw entropic-skill-scanner nova-openclaw nova-skill-scanner 2>/dev/null || true
    run_docker network rm entropic-net nova-net 2>/dev/null || true
    run_docker volume rm entropic-openclaw-data entropic-skill-scanner-data nova-openclaw-data nova-skill-scanner-data 2>/dev/null || true
    run_docker rmi -f openclaw-runtime:latest entropic-skill-scanner:latest 2>/dev/null || true
    echo "✅ Production daemon artifacts cleaned"
else
    echo "⚠️  Production Colima Docker socket not reachable; skipping daemon cleanup."
fi

# ============================================
# 3. Stop/delete prod Colima profiles and homes
# ============================================
echo ""
echo "📦 Cleaning production Colima runtime..."

if [ -n "$COLIMA_BIN" ]; then
    entropic_delete_colima_profiles "$COLIMA_BIN" "$PROJECT_ROOT" || true
fi

while IFS= read -r colima_home; do
    if entropic_remove_colima_home_if_safe "$colima_home"; then
        echo "  → Removed $colima_home"
    else
        echo "  ⚠️  Skipped unsafe Colima path: $colima_home"
    fi
done < <(entropic_colima_home_candidates)

echo "✅ Production Colima home cleanup complete"

# ============================================
# 4. Clean persisted app data
# ============================================
echo ""
echo "🗃️  Cleaning persisted app data..."
for app_data_dir in \
    "$ENTROPIC_APP_DATA_DIR_MAC" \
    "$LEGACY_NOVA_APP_DATA_DIR_MAC" \
    "$ENTROPIC_APP_DATA_DIR_LINUX" \
    "$LEGACY_NOVA_APP_DATA_DIR_LINUX"
do
    if [ -e "$app_data_dir" ]; then
        echo "  → Removing $app_data_dir"
        rm -rf "$app_data_dir"
    fi
done

# ============================================
# 5. Clean project build artifacts
# ============================================
echo ""
echo "📦 Cleaning project build artifacts..."
cd "$PROJECT_ROOT"

rm -rf dist .build
rm -rf src-tauri/target
rm -rf src-tauri/gen
rm -rf src-tauri/resources/bin/*
rm -rf src-tauri/resources/share/*
rm -f src-tauri/resources/openclaw-runtime.tar.gz
rm -f src-tauri/resources/entropic-skill-scanner.tar.gz

cargo clean --manifest-path src-tauri/Cargo.toml 2>/dev/null || true

# ============================================
# 6. Clean logs
# ============================================
echo ""
echo "📝 Cleaning runtime logs..."
rm -f ~/entropic-runtime.log

echo ""
echo "✅ Production user-test cleanup complete."
echo ""
echo "Mode: $(entropic_runtime_mode)"
echo "Colima home: $ENTROPIC_COLIMA_HOME"
echo ""
echo "Next step:"
echo "  ./scripts/build-for-user-test.sh"
