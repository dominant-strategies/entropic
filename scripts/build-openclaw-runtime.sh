#!/usr/bin/env bash
set -euo pipefail

# Build the OpenClaw core runtime container in a mode-specific daemon:
# - ENTROPIC_RUNTIME_MODE=dev  -> ~/.entropic/colima-dev (default)
# - ENTROPIC_RUNTIME_MODE=prod -> ~/.entropic/colima

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RUNTIME_COMMON="$SCRIPT_DIR/runtime-common.sh"
RUNTIME_DIR="$PROJECT_ROOT/openclaw-runtime"
OPENCLAW_SOURCE="${OPENCLAW_SOURCE:-$PROJECT_ROOT/../openclaw}"
ENTROPIC_SKILLS_SOURCE="${ENTROPIC_SKILLS_SOURCE:-$PROJECT_ROOT/../entropic-skills}"

if [ ! -f "$RUNTIME_COMMON" ]; then
    echo "ERROR: Missing runtime helper: $RUNTIME_COMMON" >&2
    exit 1
fi

export ENTROPIC_RUNTIME_MODE="${ENTROPIC_RUNTIME_MODE:-dev}"
source "$RUNTIME_COMMON"
export ENTROPIC_COLIMA_HOME="${ENTROPIC_COLIMA_HOME:-$(entropic_default_colima_home)}"

ACTIVE_DOCKER_HOST=""
DOCKER_BIN=""
COLIMA_BIN=""

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

ensure_docker_ready_for_mode() {
    DOCKER_BIN="$(entropic_find_docker_binary "$PROJECT_ROOT" || true)"
    COLIMA_BIN="$(entropic_find_colima_binary "$PROJECT_ROOT" || true)"

    if [ -z "$DOCKER_BIN" ]; then
        echo "ERROR: Docker CLI not found (system or bundled)." >&2
        return 1
    fi

    ACTIVE_DOCKER_HOST="$(entropic_resolve_mode_docker_host "$DOCKER_BIN" || true)"
    if [ -z "$ACTIVE_DOCKER_HOST" ] && [ -n "$COLIMA_BIN" ]; then
        echo "Starting Colima for $(entropic_mode_label) runtime build..."
        ACTIVE_DOCKER_HOST="$(entropic_start_colima_for_mode "$DOCKER_BIN" "$COLIMA_BIN" "$PROJECT_ROOT" || true)"
    fi

    if [ -n "$ACTIVE_DOCKER_HOST" ]; then
        return 0
    fi

    if entropic_default_context_allowed && "$DOCKER_BIN" info >/dev/null 2>&1; then
        echo "WARNING: Using default Docker context because ENTROPIC_BUILD_ALLOW_DOCKER_DESKTOP=1."
        return 0
    fi

    echo "ERROR: No $(entropic_mode_label) Colima Docker socket is reachable."
    echo "Mode: $(entropic_runtime_mode)"
    echo "Colima home: $ENTROPIC_COLIMA_HOME"
    echo ""
    echo "Fix options:"
    echo "  1. Start mode runtime first:"
    if [ "$(entropic_runtime_mode)" = "dev" ]; then
        echo "     pnpm dev:runtime:start"
    else
        echo "     ENTROPIC_RUNTIME_MODE=prod ./scripts/build-for-user-test.sh"
    fi
    echo "  2. For one-off Desktop fallback (build scripts only):"
    echo "     ENTROPIC_BUILD_ALLOW_DOCKER_DESKTOP=1 $0"
    return 1
}

echo "=== Building OpenClaw Runtime Container ==="
echo "Mode: $(entropic_runtime_mode)"
echo "Colima home: $ENTROPIC_COLIMA_HOME"
echo ""

# Check if OpenClaw source exists
if [ ! -d "$OPENCLAW_SOURCE/dist" ]; then
    echo "ERROR: OpenClaw dist not found at $OPENCLAW_SOURCE/dist"
    echo "Please build openclaw first: cd $OPENCLAW_SOURCE && pnpm build"
    exit 1
fi

STAGING_DIR="$PROJECT_ROOT/.build/openclaw-runtime"
mkdir -p "$STAGING_DIR"

echo "Staging OpenClaw files..."

# Copy Dockerfile and entrypoint
rsync -a "$RUNTIME_DIR/Dockerfile" "$STAGING_DIR/Dockerfile"
rsync -a "$RUNTIME_DIR/entrypoint.sh" "$STAGING_DIR/entrypoint.sh"

# Copy dist
rsync -a --delete "$OPENCLAW_SOURCE/dist/" "$STAGING_DIR/dist/"

# Copy package.json
rsync -a "$OPENCLAW_SOURCE/package.json" "$STAGING_DIR/package.json"

# Copy docs/reference/templates (required for agent workspace)
echo "Copying templates..."
mkdir -p "$STAGING_DIR/docs/reference"
rsync -a --delete "$OPENCLAW_SOURCE/docs/reference/templates/" "$STAGING_DIR/docs/reference/templates/"

# Copy bundled plugins (curated set for the store)
mkdir -p "$STAGING_DIR/extensions"

PLUGINS_TO_BUNDLE=(
    "memory-core"
    "memory-lancedb"
    "entropic-integrations"
    "discord"
    "telegram"
    "slack"
    "whatsapp"
    "msteams"
    "voice-call"
    "matrix"
    "googlechat"
)

for plugin in "${PLUGINS_TO_BUNDLE[@]}"; do
    if [ -d "$OPENCLAW_SOURCE/extensions/$plugin" ]; then
        echo "Copying ${plugin} plugin..."
        rsync -a --delete \
            --exclude='node_modules' \
            --exclude='.git' \
            "$OPENCLAW_SOURCE/extensions/$plugin/" "$STAGING_DIR/extensions/$plugin/"
    else
        echo "WARNING: ${plugin} plugin not found in OpenClaw source."
    fi
done

# Copy Entropic-owned skills/plugins (optional)
if [ -d "$ENTROPIC_SKILLS_SOURCE" ]; then
    echo "Copying Entropic skills from $ENTROPIC_SKILLS_SOURCE..."
    for plugin_dir in "$ENTROPIC_SKILLS_SOURCE"/*; do
        if [ -d "$plugin_dir" ] && [ -f "$plugin_dir/openclaw.plugin.json" ]; then
            plugin_name="$(basename "$plugin_dir")"
            echo "Copying ${plugin_name} plugin..."
            rsync -a --delete \
                --exclude='node_modules' \
                --exclude='.git' \
                "$plugin_dir/" "$STAGING_DIR/extensions/$plugin_name/"
        fi
    done
else
    echo "No Entropic skills directory found at $ENTROPIC_SKILLS_SOURCE (skipping)."
fi

# Materialize production-only node_modules for runtime packaging.
# Prefer pnpm deploy for deterministic prod dependency closure. If that fails
# (for example offline local builds), fall back to staged prune.
echo "Materializing production node_modules..."
mkdir -p "$STAGING_DIR/node_modules"

PROD_DEPLOY_DIR="$PROJECT_ROOT/.build/openclaw-runtime-prod"
rm -rf "$PROD_DEPLOY_DIR"

copy_source_node_modules() {
    rsync -a --delete \
        --exclude='.cache' \
        --exclude='*.map' \
        --exclude='test' \
        --exclude='tests' \
        --exclude='.git' \
        "$OPENCLAW_SOURCE/node_modules/" "$STAGING_DIR/node_modules/"
}

if command -v pnpm >/dev/null 2>&1; then
    if pnpm --dir "$OPENCLAW_SOURCE" --filter openclaw deploy --prod --legacy "$PROD_DEPLOY_DIR"; then
        if [ -d "$PROD_DEPLOY_DIR/node_modules" ]; then
            echo "Using prod-only node_modules from pnpm deploy."
            rsync -a --delete \
                --exclude='.cache' \
                --exclude='*.map' \
                --exclude='test' \
                --exclude='tests' \
                --exclude='.git' \
                "$PROD_DEPLOY_DIR/node_modules/" "$STAGING_DIR/node_modules/"
        else
            echo "WARNING: pnpm deploy succeeded but node_modules was missing. Falling back to staged prune."
            copy_source_node_modules
            if [ -f "$OPENCLAW_SOURCE/pnpm-lock.yaml" ]; then
                rsync -a "$OPENCLAW_SOURCE/pnpm-lock.yaml" "$STAGING_DIR/pnpm-lock.yaml"
            fi
            if pnpm --dir "$STAGING_DIR" prune --prod; then
                echo "Pruned staged node_modules to production dependencies."
            else
                echo "WARNING: pnpm prune --prod failed; continuing with copied node_modules."
            fi
        fi
    else
        echo "WARNING: pnpm deploy --prod failed. Falling back to staged prune."
        copy_source_node_modules
        if [ -f "$OPENCLAW_SOURCE/pnpm-lock.yaml" ]; then
            rsync -a "$OPENCLAW_SOURCE/pnpm-lock.yaml" "$STAGING_DIR/pnpm-lock.yaml"
        fi
        if pnpm --dir "$STAGING_DIR" prune --prod; then
            echo "Pruned staged node_modules to production dependencies."
        else
            echo "WARNING: pnpm prune --prod failed; continuing with copied node_modules."
        fi
    fi
else
    echo "WARNING: pnpm not found. Falling back to source node_modules copy."
    copy_source_node_modules
fi

# Remove macOS and Windows native binaries from staged node_modules.
# Packages like koffi ship prebuilt .node binaries for every platform.
# These binaries are unused in the Linux container and can make Apple
# notarization reject the bundled runtime image tar.
echo "Stripping non-Linux native binaries from node_modules..."
STRIPPED_DIRS=0
while IFS= read -r -d '' dir; do
    rm -rf "$dir"
    STRIPPED_DIRS=$((STRIPPED_DIRS + 1))
done < <(
    find "$STAGING_DIR/node_modules" -type d \
        \( \
            -name "darwin_*" -o -name "darwin-*" -o -name "*-darwin-*" -o \
            -name "win32_*" -o -name "win32-*" -o -name "*-win32-*" -o \
            -name "macos-*" -o -name "*-mac-*" -o -name "*-windows-*" -o \
            -name "fsevents" \
        \) \
        -print0
)
echo "Removed $STRIPPED_DIRS non-Linux native directories."

if command -v file >/dev/null 2>&1; then
    STRIPPED_NODE_BINARIES=0
    while IFS= read -r -d '' node_binary; do
        file_desc="$(file -b "$node_binary" 2>/dev/null || true)"
        if echo "$file_desc" | grep -Eq "Mach-O|PE32"; then
            rm -f "$node_binary"
            STRIPPED_NODE_BINARIES=$((STRIPPED_NODE_BINARIES + 1))
        fi
    done < <(find "$STAGING_DIR/node_modules" -type f -name "*.node" -print0)
    echo "Removed $STRIPPED_NODE_BINARIES non-Linux native .node binaries."

    # Guardrail: fail fast if any macOS/Windows native Node addon remains.
    NON_LINUX_NATIVE_COUNT=0
    while IFS= read -r -d '' node_binary; do
        file_desc="$(file -b "$node_binary" 2>/dev/null || true)"
        if echo "$file_desc" | grep -Eq "Mach-O|PE32"; then
            echo "ERROR: Non-Linux native Node binary remains in runtime staging:"
            echo "  $node_binary"
            echo "  ($file_desc)"
            NON_LINUX_NATIVE_COUNT=$((NON_LINUX_NATIVE_COUNT + 1))
        fi
    done < <(find "$STAGING_DIR/node_modules" -type f -name "*.node" -print0)

    if [ "$NON_LINUX_NATIVE_COUNT" -gt 0 ]; then
        echo "ERROR: Found $NON_LINUX_NATIVE_COUNT non-Linux native Node binaries after pruning."
        echo "Refusing to build runtime image because notarization will reject the bundle."
        exit 1
    fi
else
    echo "WARNING: 'file' command unavailable; skipping native binary type validation."
fi

# Security scan - check for actual secrets in config files only
echo ""
echo "Running security scan..."
if find "$STAGING_DIR" -type f \( -name "*.env" -o -name "*.json" -o -name "*.yaml" -o -name "*.yml" -o -name "*.toml" \) \
    -exec grep -lE "sk-[a-zA-Z0-9]{40,}|key-[a-zA-Z0-9]{40,}" {} \; 2>/dev/null | head -5 | grep -q .; then
    echo "ERROR: Potential secrets found! Aborting."
    exit 1
fi
echo "Security scan passed."

# Build container
echo ""
echo "Building container image..."
ensure_docker_ready_for_mode

if [ -n "${ACTIVE_DOCKER_HOST}" ]; then
    echo "Using Docker host: ${ACTIVE_DOCKER_HOST}"
else
    echo "Using default Docker context."
fi

export DOCKER_BUILDKIT="${DOCKER_BUILDKIT:-1}"
run_docker build \
    --cache-from openclaw-runtime:latest \
    -t openclaw-runtime:latest \
    "$STAGING_DIR"

echo ""
echo "=== OpenClaw runtime image built: openclaw-runtime:latest ==="
run_docker images openclaw-runtime:latest
