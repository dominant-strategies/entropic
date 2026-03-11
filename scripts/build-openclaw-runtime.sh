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

resolve_buildkit_setting() {
    local requested="${DOCKER_BUILDKIT:-1}"
    if [ "$requested" != "1" ]; then
        export DOCKER_BUILDKIT="$requested"
        return 0
    fi

    if run_docker buildx version >/dev/null 2>&1; then
        export DOCKER_BUILDKIT=1
        return 0
    fi

    echo "WARNING: docker buildx is unavailable in the selected Docker context."
    echo "Falling back to the classic docker builder (DOCKER_BUILDKIT=0)."
    export DOCKER_BUILDKIT=0
}

ensure_docker_ready_for_mode() {
    DOCKER_BIN="$(entropic_find_docker_binary "$PROJECT_ROOT" || true)"
    COLIMA_BIN="$(entropic_find_colima_binary "$PROJECT_ROOT" || true)"

    if [ -z "$DOCKER_BIN" ]; then
        echo "ERROR: Docker CLI not found (system or bundled)." >&2
        return 1
    fi

    # Windows local user-test builds run this script inside the managed WSL
    # distro, where Docker lives on the in-distro unix socket rather than a
    # Colima context. Only prefer that engine when we are actually inside WSL.
    if [ -n "${WSL_DISTRO_NAME:-}" ] && \
        env -u DOCKER_CONTEXT DOCKER_HOST=unix:///var/run/docker.sock "$DOCKER_BIN" info >/dev/null 2>&1; then
        ACTIVE_DOCKER_HOST="unix:///var/run/docker.sock"
        return 0
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

default_build_root() {
    if [ -f /proc/version ] \
        && grep -qi microsoft /proc/version 2>/dev/null \
        && [[ "$PROJECT_ROOT" == /mnt/* ]]; then
        local cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/entropic-build"
        local build_key
        build_key="$(basename "$PROJECT_ROOT")"
        if command -v sha256sum >/dev/null 2>&1; then
            build_key="${build_key}-$(printf '%s' "$PROJECT_ROOT" | sha256sum | cut -c1-12)"
        fi
        printf '%s\n' "$cache_root/$build_key"
        return 0
    fi

    printf '%s\n' "$PROJECT_ROOT/.build"
}

normalize_lf_file() {
    local path="$1"
    [ -f "$path" ] || return 0
    perl -0pi -e 's/\r\n/\n/g' "$path"
}

assert_no_crlf_file() {
    local path="$1"
    [ -f "$path" ] || return 0
    if LC_ALL=C grep -q $'\r' "$path"; then
        echo "ERROR: CRLF line endings detected in $path after normalization" >&2
        return 1
    fi
}

normalize_tree_permissions() {
    local root="$1"
    [ -d "$root" ] || return 0

    find "$root" -type d -exec chmod 755 {} +
    find "$root" -type f -print0 | while IFS= read -r -d '' file; do
        local mode
        mode="$(stat -c '%a' "$file" 2>/dev/null || stat -f '%OLp' "$file" 2>/dev/null || echo 644)"
        mode="${mode##*$'\n'}"
        mode="${mode//[!0-7]/}"
        if [ -z "$mode" ]; then
            mode="644"
        fi
        if [ $((8#$mode & 0111)) -ne 0 ]; then
            chmod 755 "$file"
        else
            chmod 644 "$file"
        fi
    done
}

# Check if OpenClaw source exists
if [ ! -d "$OPENCLAW_SOURCE/dist" ]; then
    echo "ERROR: OpenClaw dist not found at $OPENCLAW_SOURCE/dist"
    echo "Please build openclaw first: cd $OPENCLAW_SOURCE && pnpm build"
    exit 1
fi

BUILD_ROOT="${ENTROPIC_BUILD_ROOT:-$(default_build_root)}"
STAGING_DIR="$BUILD_ROOT/openclaw-runtime"
mkdir -p "$STAGING_DIR"
echo "Build root: $BUILD_ROOT"

echo "Staging OpenClaw files..."

# Copy Dockerfile and entrypoint
rsync -a "$RUNTIME_DIR/Dockerfile" "$STAGING_DIR/Dockerfile"
rsync -a "$RUNTIME_DIR/entrypoint.sh" "$STAGING_DIR/entrypoint.sh"
normalize_lf_file "$STAGING_DIR/entrypoint.sh"
assert_no_crlf_file "$STAGING_DIR/entrypoint.sh"
rsync -a --delete "$RUNTIME_DIR/browser-service/" "$STAGING_DIR/browser-service/"

# Copy dist
rsync -a --delete "$OPENCLAW_SOURCE/dist/" "$STAGING_DIR/dist/"

# Newer OpenClaw channel extensions import plugin-sdk subpaths such as
# `openclaw/plugin-sdk/telegram`. If the local OpenClaw `dist/` is stale or
# partially built, those concrete `dist/plugin-sdk/<entry>.js` files may be
# missing even though `dist/plugin-sdk/index.js` still exports the required
# symbols. Synthesize minimal JS entry shims so bundled extensions keep loading.
if [ -f "$STAGING_DIR/dist/plugin-sdk/index.js" ] && command -v node >/dev/null 2>&1; then
    while IFS= read -r entry; do
        [ -n "$entry" ] || continue
        target="$STAGING_DIR/dist/plugin-sdk/${entry}.js"
        if [ ! -f "$target" ]; then
            printf 'export * from "./index.js";\n' > "$target"
        fi
    done < <(node -e '
const pkg = require(process.argv[1]);
for (const key of Object.keys(pkg.exports || {})) {
  if (!key.startsWith("./plugin-sdk/")) continue;
  const entry = key.slice("./plugin-sdk/".length);
  if (!entry || entry.includes("/")) continue;
  console.log(entry);
}
' "$OPENCLAW_SOURCE/package.json")
elif [ -f "$STAGING_DIR/dist/plugin-sdk/index.js" ]; then
    echo "WARNING: node not found in build distro; skipping plugin-sdk shim synthesis." >&2
fi

# Copy package.json
rsync -a "$OPENCLAW_SOURCE/package.json" "$STAGING_DIR/package.json"

# Copy docs/reference/templates (required for agent workspace)
echo "Copying templates..."
mkdir -p "$STAGING_DIR/docs/reference"
rsync -a --delete "$OPENCLAW_SOURCE/docs/reference/templates/" "$STAGING_DIR/docs/reference/templates/"

# Copy bundled plugins (curated set for the store)
mkdir -p "$STAGING_DIR/extensions"
mkdir -p "$STAGING_DIR/bundled-skills"

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
        elif [ -d "$plugin_dir" ] && [ -f "$plugin_dir/SKILL.md" ]; then
            skill_name="$(basename "$plugin_dir")"
            echo "Copying ${skill_name} skill..."
            mkdir -p "$STAGING_DIR/bundled-skills/$skill_name"
            rsync -a --delete \
                --exclude='.git' \
                --exclude='node_modules' \
                "$plugin_dir/" "$STAGING_DIR/bundled-skills/$skill_name/"
        fi
    done
else
    echo "No Entropic skills directory found at $ENTROPIC_SKILLS_SOURCE (skipping)."
fi

normalize_tree_permissions "$STAGING_DIR/extensions"
normalize_tree_permissions "$STAGING_DIR/bundled-skills"

# Materialize production-only node_modules for runtime packaging.
# Prefer pnpm deploy for deterministic prod dependency closure. If that fails
# (for example offline local builds), fall back to staged prune.
echo "Materializing production node_modules..."
mkdir -p "$STAGING_DIR/node_modules"

PROD_DEPLOY_DIR="$BUILD_ROOT/openclaw-runtime-prod"
rm -rf "$PROD_DEPLOY_DIR"

copy_source_node_modules() {
    copy_filtered_node_modules "$OPENCLAW_SOURCE/node_modules" "$STAGING_DIR/node_modules"
}

copy_filtered_node_modules() {
    local source_dir="$1"
    local dest_dir="$2"
    local staging_dir="${dest_dir}.incoming"
    local backup_dir="${dest_dir}.previous"

    rm -rf "$staging_dir" "$backup_dir"
    mkdir -p "$staging_dir"

    if rsync -a --delete \
        --exclude='.cache' \
        --exclude='*.map' \
        --exclude='test' \
        --exclude='tests' \
        --exclude='.git' \
        "$source_dir/" "$staging_dir/"; then
        :
    else
        echo "WARNING: rsync copy failed for $source_dir. Retrying with tar stream..."
        rm -rf "$staging_dir"
        mkdir -p "$staging_dir"

        tar -C "$source_dir" \
            --exclude='.cache' \
            --exclude='*.map' \
            --exclude='test' \
            --exclude='tests' \
            --exclude='.git' \
            -cf - . | tar -C "$staging_dir" -xf -
    fi

    if [ -e "$dest_dir" ]; then
        chmod -R u+w "$dest_dir" 2>/dev/null || true
        mv "$dest_dir" "$backup_dir"
    fi

    mv "$staging_dir" "$dest_dir"
    rm -rf "$backup_dir" 2>/dev/null || true
}

if command -v pnpm >/dev/null 2>&1; then
    if pnpm --dir "$OPENCLAW_SOURCE" --filter openclaw deploy --prod --legacy "$PROD_DEPLOY_DIR"; then
        if [ -d "$PROD_DEPLOY_DIR/node_modules" ]; then
            echo "Using prod-only node_modules from pnpm deploy."
            copy_filtered_node_modules "$PROD_DEPLOY_DIR/node_modules" "$STAGING_DIR/node_modules"
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
        echo "WARNING: pnpm deploy --prod failed. Falling back to staged prune (install Linux node/pnpm in entropic-dev for faster local Windows builds)."
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
    echo "WARNING: pnpm not found. Falling back to source node_modules copy (run 'pnpm.cmd dev:wsl:start:dev' to bootstrap the Linux toolchain)."
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

echo "Stripping known non-runtime packages from node_modules..."
KNOWN_NON_RUNTIME_PATTERNS=(
    "@node-llama-cpp+mac-arm64-metal@*"
    "@cloudflare+workers-types@*"
    "@typescript+native-preview@*"
    "@types+*"
    "bun-types@*"
    "typescript@*"
)
KNOWN_NON_RUNTIME_SYMLINKS=(
    "@cloudflare/workers-types"
    "@types"
    "@typescript/native-preview"
    "bun-types"
    "typescript"
)
STRIPPED_KNOWN_PACKAGES=0
for pattern in "${KNOWN_NON_RUNTIME_PATTERNS[@]}"; do
    while IFS= read -r -d '' package_dir; do
        rm -rf "$package_dir"
        STRIPPED_KNOWN_PACKAGES=$((STRIPPED_KNOWN_PACKAGES + 1))
    done < <(find "$STAGING_DIR/node_modules/.pnpm" -maxdepth 1 -mindepth 1 -type d -name "$pattern" -print0 2>/dev/null)
done
for symlink_path in "${KNOWN_NON_RUNTIME_SYMLINKS[@]}"; do
    rm -rf "$STAGING_DIR/node_modules/$symlink_path" 2>/dev/null || true
done
echo "Removed $STRIPPED_KNOWN_PACKAGES known non-runtime package directories."

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

resolve_buildkit_setting
run_docker build \
    --cache-from openclaw-runtime:latest \
    -t openclaw-runtime:latest \
    "$STAGING_DIR"

echo ""
echo "=== OpenClaw runtime image built: openclaw-runtime:latest ==="
run_docker images openclaw-runtime:latest
