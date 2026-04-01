#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_COMMON="$SCRIPT_DIR/runtime-common.sh"

if [ ! -f "$RUNTIME_COMMON" ]; then
  echo "ERROR: Missing runtime helper: $RUNTIME_COMMON" >&2
  exit 1
fi

export ENTROPIC_RUNTIME_MODE=dev
source "$RUNTIME_COMMON"

export ENTROPIC_COLIMA_HOME="${ENTROPIC_COLIMA_HOME:-$(entropic_default_colima_home)}"

ACTIVE_DOCKER_HOST=""
DOCKER_BIN=""
COLIMA_BIN=""

usage() {
  if entropic_linux_uses_native_docker; then
    cat <<USAGE
Usage: ./scripts/dev-runtime.sh <command>

This helper is dev-only and uses the native Linux Docker daemon:
  ENTROPIC_RUNTIME_MODE=dev

Commands:
  status       Print current dev Docker/container status
  start        Ensure bundled runtime tools and verify Docker is ready
  up           Start runtime, bundle/build missing assets, launch pnpm tauri:dev
  stop         Stop dev runtime containers (keeps Docker images)
  prune        Remove dev containers/networks/volumes and reset cached dev state
  logs [name]  Tail logs for entropic-openclaw (or provided container)
  help         Show this help
USAGE
    return
  fi

  cat <<USAGE
Usage: ./scripts/dev-runtime.sh <command>

This helper is dev-only and uses isolated Colima state:
  ENTROPIC_RUNTIME_MODE=dev
  ENTROPIC_COLIMA_HOME=${ENTROPIC_COLIMA_HOME}

Commands:
  status       Print current dev Docker/Colima/container status
  start        Ensure bundled runtime tools and start dev Colima if needed
  up           Start runtime, bundle/build missing assets, launch pnpm tauri:dev
  stop         Stop dev runtime containers (keeps Colima + images)
  prune        Remove dev containers/networks/volumes and reset dev Colima homes
  logs [name]  Tail logs for entropic-openclaw (or provided container)
  help         Show this help
USAGE
}

refresh_binaries() {
  DOCKER_BIN="$(entropic_find_docker_binary "$PROJECT_ROOT" || true)"
  COLIMA_BIN="$(entropic_find_colima_binary "$PROJECT_ROOT" || true)"
}

bundled_runtime_ready() {
  if entropic_linux_uses_native_docker; then
    [ -x "$PROJECT_ROOT/src-tauri/resources/bin/check-docker.sh" ] || return 1
    return 0
  fi
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

  echo "[dev] Bundled runtime binaries missing. Running bundle-runtime.sh..."
  "$PROJECT_ROOT/scripts/bundle-runtime.sh"
  refresh_binaries
}

run_docker() {
  if [ -z "$DOCKER_BIN" ]; then
    echo "[dev] ERROR: Docker CLI not found." >&2
    return 1
  fi
  if [ -n "${ACTIVE_DOCKER_HOST:-}" ]; then
    DOCKER_HOST="$ACTIVE_DOCKER_HOST" "$DOCKER_BIN" "$@"
  else
    "$DOCKER_BIN" "$@"
  fi
}

vite_dev_server_running() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "http://127.0.0.1:5174" >/dev/null 2>&1
    return $?
  fi
  (exec 3<>/dev/tcp/127.0.0.1/5174) >/dev/null 2>&1
}

resolve_docker_host_without_start() {
  refresh_binaries
  if [ -z "$DOCKER_BIN" ]; then
    return 1
  fi
  if entropic_linux_uses_native_docker && entropic_default_docker_is_ready "$DOCKER_BIN"; then
    ACTIVE_DOCKER_HOST=""
    return 0
  fi
  ACTIVE_DOCKER_HOST="$(entropic_resolve_mode_docker_host "$DOCKER_BIN" || true)"
  [ -n "$ACTIVE_DOCKER_HOST" ]
}

resolve_or_start_docker_host() {
  ensure_bundled_runtime
  refresh_binaries

  if [ -z "$DOCKER_BIN" ]; then
    echo "[dev] ERROR: Docker CLI not found (system or bundled)." >&2
    return 1
  fi

  if entropic_linux_uses_native_docker && entropic_default_docker_is_ready "$DOCKER_BIN"; then
    ACTIVE_DOCKER_HOST=""
    return 0
  fi

  ACTIVE_DOCKER_HOST="$(entropic_resolve_mode_docker_host "$DOCKER_BIN" || true)"
  if [ -n "$ACTIVE_DOCKER_HOST" ]; then
    return 0
  fi

  if entropic_linux_uses_native_docker; then
    echo "[dev] ERROR: Docker daemon is not ready on Linux." >&2
    echo "[dev] Install/start Docker Engine, or fix socket permissions (for example: sudo systemctl start docker)." >&2
    return 1
  fi

  if [ -z "$COLIMA_BIN" ]; then
    echo "[dev] ERROR: Colima binary not found. Cannot start isolated dev runtime." >&2
    return 1
  fi

  echo "[dev] Starting isolated dev Colima runtime..."
  ACTIVE_DOCKER_HOST="$(entropic_start_colima_for_mode "$DOCKER_BIN" "$COLIMA_BIN" "$PROJECT_ROOT" || true)"
  if [ -z "$ACTIVE_DOCKER_HOST" ]; then
    echo "[dev] ERROR: Failed to start dev Colima runtime." >&2
    return 1
  fi
}

ensure_runtime_images() {
  if ! run_docker image inspect openclaw-runtime:latest >/dev/null 2>&1; then
    echo "[dev] openclaw-runtime:latest missing in dev daemon. Building..."
    ENTROPIC_RUNTIME_MODE=dev \
    ENTROPIC_COLIMA_HOME="$ENTROPIC_COLIMA_HOME" \
    DOCKER_HOST="$ACTIVE_DOCKER_HOST" \
      "$PROJECT_ROOT/scripts/build-openclaw-runtime.sh"
  fi
}

ensure_runtime_tars() {
  local runtime_tar="$PROJECT_ROOT/src-tauri/resources/openclaw-runtime.tar.gz"
  local image_created=""
  local tar_mtime=""

  mkdir -p "$PROJECT_ROOT/src-tauri/resources"

  if run_docker image inspect openclaw-runtime:latest >/dev/null 2>&1; then
    image_created="$(run_docker image inspect openclaw-runtime:latest --format '{{.Created}}' 2>/dev/null || true)"
  fi
  if [ -f "$runtime_tar" ]; then
    if entropic_linux_uses_native_docker; then
      tar_mtime="$(stat -c '%Y' "$runtime_tar" 2>/dev/null || true)"
    else
      tar_mtime="$(stat -f '%m' "$runtime_tar" 2>/dev/null || true)"
    fi
  fi

  if [ ! -f "$runtime_tar" ]; then
    echo "[dev] Bundling runtime tar (openclaw-runtime:latest)..."
    ENTROPIC_RUNTIME_MODE=dev \
    ENTROPIC_COLIMA_HOME="$ENTROPIC_COLIMA_HOME" \
    DOCKER_HOST="$ACTIVE_DOCKER_HOST" \
      "$PROJECT_ROOT/scripts/bundle-runtime-image.sh"
  elif [ -n "$image_created" ] && [ -n "$tar_mtime" ]; then
    local image_epoch
    image_epoch="$(node -e 'const raw=process.argv[1]; const ts=Date.parse(raw); if (Number.isFinite(ts)) process.stdout.write(String(Math.floor(ts/1000)));' "$image_created" 2>/dev/null || true)"
    if [ -n "$image_epoch" ] && [ "$image_epoch" -gt "$tar_mtime" ]; then
      echo "[dev] Runtime image is newer than bundled tar. Re-bundling runtime tar..."
      ENTROPIC_RUNTIME_MODE=dev \
      ENTROPIC_COLIMA_HOME="$ENTROPIC_COLIMA_HOME" \
      DOCKER_HOST="$ACTIVE_DOCKER_HOST" \
        "$PROJECT_ROOT/scripts/bundle-runtime-image.sh"
    fi
  fi
}

status() {
  refresh_binaries
  ACTIVE_DOCKER_HOST="$(entropic_resolve_mode_docker_host "${DOCKER_BIN:-docker}" || true)"
  if [ -z "$ACTIVE_DOCKER_HOST" ] && [ -n "${DOCKER_BIN:-}" ] && entropic_linux_uses_native_docker && entropic_default_docker_is_ready "$DOCKER_BIN"; then
    ACTIVE_DOCKER_HOST="native"
  fi

  echo "[dev] Mode: $(entropic_runtime_mode)"
  echo "[dev] Docker CLI: ${DOCKER_BIN:-missing}"
  if entropic_linux_uses_native_docker; then
    echo "[dev] Docker mode: native Linux daemon"
  else
    echo "[dev] Colima home: $ENTROPIC_COLIMA_HOME"
    echo "[dev] Colima CLI: ${COLIMA_BIN:-missing}"
  fi

  if [ -n "$ACTIVE_DOCKER_HOST" ]; then
    if [ "$ACTIVE_DOCKER_HOST" = "native" ]; then
      ACTIVE_DOCKER_HOST=""
      echo "[dev] Docker host: native"
    else
      echo "[dev] Docker host: $ACTIVE_DOCKER_HOST"
    fi
    if run_docker info >/dev/null 2>&1; then
      echo "[dev] Docker socket: ready"
    else
      echo "[dev] Docker socket: unavailable"
    fi
  else
    echo "[dev] Docker host: unavailable"
  fi

  if [ -n "$COLIMA_BIN" ]; then
    local profile
    for profile in entropic-vz entropic-qemu; do
      if entropic_run_colima "$COLIMA_BIN" "$ENTROPIC_COLIMA_HOME" "$PROJECT_ROOT" --profile "$profile" status 2>/dev/null | grep -qi "running"; then
        echo "[dev] Colima profile: $profile (running)"
      else
        echo "[dev] Colima profile: $profile (stopped)"
      fi
    done
  fi

  if [ -n "$ACTIVE_DOCKER_HOST" ]; then
    echo "[dev] Containers:"
    local container_rows
    container_rows="$(run_docker ps -a --format "{{.Names}}\t{{.Status}}\t{{.Ports}}" || true)"
    if [ -n "$container_rows" ]; then
      echo "NAMES	STATUS	PORTS"
      echo "$container_rows" | awk -F '\t' '$1 ~ /^(entropic|nova)-/ { print }'
    else
      echo "[dev] (no containers)"
    fi
  fi
}

start_stack() {
  resolve_or_start_docker_host
  if [ -n "$ACTIVE_DOCKER_HOST" ]; then
    echo "[dev] Using Docker host: $ACTIVE_DOCKER_HOST"
  else
    echo "[dev] Using Docker host: native Linux daemon"
  fi
  run_docker info >/dev/null
  echo "[dev] Runtime ready."
}

stop_stack() {
  if ! resolve_docker_host_without_start; then
    if entropic_linux_uses_native_docker; then
      echo "[dev] Docker daemon is not reachable on Linux. Nothing to stop."
    else
      echo "[dev] No dev Colima Docker socket found. Nothing to stop."
    fi
    return 0
  fi

  echo "[dev] Stopping runtime containers..."
  run_docker stop \
    entropic-openclaw entropic-skill-scanner \
    nova-openclaw nova-skill-scanner \
    2>/dev/null || true
}

prune_stack() {
  if resolve_docker_host_without_start; then
    echo "[dev] Removing runtime containers/networks/volumes in dev daemon..."
    run_docker rm -f \
      entropic-openclaw entropic-skill-scanner \
      nova-openclaw nova-skill-scanner \
      2>/dev/null || true
    run_docker network rm entropic-net nova-net 2>/dev/null || true
    run_docker volume rm entropic-openclaw-data entropic-skill-scanner-data nova-openclaw-data nova-skill-scanner-data 2>/dev/null || true
  else
    if entropic_linux_uses_native_docker; then
      echo "[dev] Docker daemon is not reachable on Linux. Skipping container prune."
    else
      echo "[dev] No dev Colima Docker socket found. Skipping container prune."
    fi
  fi

  refresh_binaries
  if [ -n "$COLIMA_BIN" ]; then
    echo "[dev] Deleting dev Colima profiles..."
    entropic_delete_colima_profiles "$COLIMA_BIN" "$PROJECT_ROOT" || true
  fi

  echo "[dev] Removing dev Colima homes..."
  local home
  while IFS= read -r home; do
    if entropic_remove_colima_home_if_safe "$home"; then
      echo "[dev] Removed $home"
    else
      echo "[dev] Skipped unsafe path: $home"
    fi
  done < <(entropic_colima_home_candidates)

  echo "[dev] Dev runtime prune complete."
}

up_stack() {
  start_stack
  ensure_runtime_images
  ensure_runtime_tars
  local build_profile="${ENTROPIC_BUILD_PROFILE:-local}"

  for container in entropic-openclaw nova-openclaw; do
    local stopped_ids
    stopped_ids="$(run_docker ps -aq -f "name=$container" -f "status=exited" || true)"
    if [ -n "$stopped_ids" ]; then
      run_docker rm -f "$container" >/dev/null 2>&1 || true
    fi
  done

  if vite_dev_server_running; then
    echo "[dev] Reusing existing Vite dev server on http://127.0.0.1:5174"
    echo "[dev] Launching Rust backend directly (ENTROPIC_BUILD_PROFILE=$build_profile)"
    (
      cd "$PROJECT_ROOT/src-tauri"
      ENTROPIC_RUNTIME_MODE=dev \
      ENTROPIC_BUILD_PROFILE="$build_profile" \
      ENTROPIC_COLIMA_HOME="$ENTROPIC_COLIMA_HOME" \
      DOCKER_HOST="$ACTIVE_DOCKER_HOST" \
        cargo run --no-default-features --color always --
    )
  else
    echo "[dev] Launching pnpm tauri:dev (ENTROPIC_BUILD_PROFILE=$build_profile)"
    ENTROPIC_RUNTIME_MODE=dev \
    ENTROPIC_BUILD_PROFILE="$build_profile" \
    ENTROPIC_COLIMA_HOME="$ENTROPIC_COLIMA_HOME" \
    DOCKER_HOST="$ACTIVE_DOCKER_HOST" \
      pnpm tauri:dev
  fi
}

tail_logs() {
  local target="${1:-entropic-openclaw}"
  if ! resolve_docker_host_without_start; then
    if entropic_linux_uses_native_docker; then
      echo "[dev] ERROR: Docker daemon is not reachable on Linux." >&2
    else
      echo "[dev] ERROR: No dev Colima Docker host available for logs." >&2
    fi
    return 1
  fi
  run_docker logs --tail 200 -f "$target"
}

case "${1:-help}" in
  status)
    status
    ;;
  start)
    start_stack
    ;;
  up)
    up_stack
    ;;
  stop)
    stop_stack
    ;;
  prune)
    prune_stack
    ;;
  logs)
    tail_logs "${2:-}"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "Unknown command: ${1:-}" >&2
    usage
    exit 1
    ;;
esac
