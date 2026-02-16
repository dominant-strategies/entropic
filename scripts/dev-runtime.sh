#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_COLIMA_HOME="$HOME/.nova/colima-dev"
COLIMA_HOME="${NOVA_COLIMA_HOME:-$DEFAULT_COLIMA_HOME}"
ACTIVE_DOCKER_HOST=""
SCRIPT_BIN_DIRS="${PROJECT_ROOT}/src-tauri/target/debug/resources/bin:${PROJECT_ROOT}/src-tauri/resources/bin"

usage() {
  local default_colima_home="${NOVA_COLIMA_HOME:-$DEFAULT_COLIMA_HOME}"

  cat <<USAGE
Usage: ./scripts/dev-runtime.sh <command>

By default, this script uses the isolated runtime home:
  ${default_colima_home}
Set NOVA_COLIMA_HOME to override.

Commands:
  status       Print current Docker/Colima and Nova container status
  start        Start Colima (if available), then confirm Docker is ready
  up           Run \`pnpm tauri:dev\` after prep for Colima/Docker
  stop         Stop Nova containers (gateway + scanner)
  prune        Remove Nova containers and nova-net
  logs [name]  Tail logs for nova-openclaw or nova-skill-scanner
  help         Show this help
USAGE
}

find_docker_binary() {
  local candidates=()

  if command -v docker >/dev/null 2>&1; then
    candidates+=("$(command -v docker)")
  fi

  local bundled="${PROJECT_ROOT}/src-tauri/resources/bin/docker"
  if [ -x "$bundled" ]; then
    candidates+=("$bundled")
  fi

  local target_debug="${PROJECT_ROOT}/src-tauri/target/debug/resources/bin/docker"
  if [ -x "$target_debug" ]; then
    candidates+=("$target_debug")
  fi

  for path in "${candidates[@]}"; do
    if "$path" --version >/dev/null 2>&1; then
      echo "$path"
      return 0
    fi
  done

  echo "docker"
}

find_colima_binary() {
  local target_debug="${PROJECT_ROOT}/src-tauri/target/debug/resources/bin/colima"
  if [ -x "$target_debug" ]; then
    echo "$target_debug"
    return 0
  fi

  local bundled="${PROJECT_ROOT}/src-tauri/resources/bin/colima"
  if [ -x "$bundled" ]; then
    echo "$bundled"
    return 0
  fi

  if command -v colima >/dev/null 2>&1; then
    echo "$(command -v colima)"
    return 0
  fi

  return 1
}

DOCKER_BIN="$(find_docker_binary)"
COLIMA_BIN="$(find_colima_binary || true)"

run_colima() {
  if [ -z "${COLIMA_BIN:-}" ]; then
    return 1
  fi

  COLIMA_HOME="$COLIMA_HOME" \
  LIMA_HOME="$COLIMA_HOME/_lima" \
  PATH="${SCRIPT_BIN_DIRS}:$PATH" \
  "$COLIMA_BIN" "$@"
}

colima_profiles=(nova-vz nova-qemu)
colima_vm_types=(vz qemu)

resolve_docker_host() {
  local profile=$1
  local candidate_homes=(
    "$COLIMA_HOME"
    "$DEFAULT_COLIMA_HOME"
    "$HOME/.nova/colima"
  )
  local home
  local sock
  for home in "${candidate_homes[@]}"; do
    sock="$home/$profile/docker.sock"
    if [ -S "$sock" ]; then
      echo "unix://$sock"
      return 0
    fi
  done
  return 1
}

docker_host_is_available() {
  local candidate="$1"
  if [ -z "$candidate" ]; then
    return 1
  fi

  DOCKER_HOST="$candidate" "$DOCKER_BIN" info >/dev/null 2>&1
}

resolve_working_docker_host() {
  if docker_host_is_available "${ACTIVE_DOCKER_HOST:-}"; then
    return 0
  fi

  # Re-scan known Colima homes in case environment changed across sessions.
  local profile home sock candidate
  for profile in "${colima_profiles[@]}"; do
    for home in \
      "$COLIMA_HOME" \
      "$DEFAULT_COLIMA_HOME" \
      "$HOME/.nova/colima" \
      "$HOME/.colima"; do
      [ -d "$home" ] || continue
      sock="$home/$profile/docker.sock"
      candidate="unix://$sock"
      if [ -S "$sock" ] && docker_host_is_available "$candidate"; then
        ACTIVE_DOCKER_HOST="$candidate"
        return 0
      fi
    done
  done

  if [ -n "${DOCKER_HOST:-}" ] && docker_host_is_available "${DOCKER_HOST}"; then
    ACTIVE_DOCKER_HOST="${DOCKER_HOST}"
    return 0
  fi

  ACTIVE_DOCKER_HOST=""
  return 1
}

run_docker() {
  if ! resolve_working_docker_host; then
    echo "[dev] Docker socket unavailable; using default Docker context" >&2
  fi
  local docker_host="${ACTIVE_DOCKER_HOST:-}"
  DOCKER_HOST="$docker_host" "$DOCKER_BIN" "$@"
}

is_docker_running() {
  resolve_working_docker_host >/dev/null 2>&1 && run_docker info >/dev/null 2>&1
}

wait_for_docker() {
  local attempts=20
  local delay=1
  while [ "$attempts" -gt 0 ]; do
    if is_docker_running; then
      return 0
    fi
    attempts=$((attempts - 1))
    if [ "$attempts" -eq 0 ]; then
      break
    fi
    sleep "$delay"
  done
  return 1
}

colima_running_profile() {
  local profile=$1
  local sock
  local home
  local candidate_homes=(
    "$COLIMA_HOME"
    "$DEFAULT_COLIMA_HOME"
    "$HOME/.nova/colima"
  )
  for home in "${candidate_homes[@]}"; do
    sock="$home/$profile/docker.sock"
    if [ -S "$sock" ]; then
      ACTIVE_DOCKER_HOST="unix://$sock"
      return 0
    fi
  done

  if [ -n "${COLIMA_BIN:-}" ] && run_colima status --profile "$profile" 2>/dev/null | grep -qi "running"; then
    return 0
  fi

  return 1
}

resolve_runtime_host() {
  for profile in "${colima_profiles[@]}"; do
    if active="$(resolve_docker_host "$profile")"; then
      ACTIVE_DOCKER_HOST="$active"
      return 0
    fi
  done
  return 1
}

ensure_colima() {
  if [ -z "${COLIMA_BIN:-}" ]; then
    echo "[dev] Colima binary not available. Using existing Docker context."
    return 0
  fi

  for i in "${!colima_profiles[@]}"; do
    local profile="${colima_profiles[$i]}"
    local vm_type="${colima_vm_types[$i]}"
    local socket_wait=20

    if colima_running_profile "$profile"; then
      ACTIVE_DOCKER_HOST="$(resolve_docker_host "$profile")"
      echo "[dev] Colima already running: $profile"
      return 0
    fi

    echo "[dev] Starting Colima profile $profile ($vm_type)..."
    if start_output=$(run_colima --profile "$profile" start --vm-type "$vm_type" 2>&1); then
      while [ "$socket_wait" -gt 0 ]; do
        if active="$(resolve_docker_host "$profile")"; then
          ACTIVE_DOCKER_HOST="$active"
          echo "[dev] Colima started: $profile"
          return 0
        fi
        sleep 1
        socket_wait=$((socket_wait - 1))
      done
      echo "[dev] Colima started profile $profile but docker socket not ready yet."
    else
      echo "[dev] Colima failed to start profile $profile (vm: $vm_type)."
      if [ -n "${start_output:-}" ]; then
        echo "[dev] start output: ${start_output}"
      fi
    fi

    if [ "$vm_type" = "vz" ]; then
      echo "[dev] VZ profile unavailable; trying qemu fallback."
      continue
    fi
  done

  echo "[dev] WARNING: Colima did not auto-start. Continuing with Docker context if available."
  return 0
}

start_stack() {
  ensure_colima

  if [ -z "${ACTIVE_DOCKER_HOST}" ] && [ -n "${COLIMA_BIN:-}" ]; then
    for profile in "${colima_profiles[@]}"; do
      if active="$(resolve_docker_host "$profile")"; then
        ACTIVE_DOCKER_HOST="$active"
        break
      fi
    done
  fi

  if ! wait_for_docker; then
    echo "[dev] ERROR: Docker socket not available yet."
    echo "       Open Docker Desktop or start Colima manually and retry."
    return 1
  fi

  if [ -n "${ACTIVE_DOCKER_HOST}" ]; then
    echo "[dev] Using Docker host: $ACTIVE_DOCKER_HOST"
  else
    echo "[dev] Using default Docker context."
  fi

  echo "[dev] Docker ready: $(run_docker version --format '{{.Client.Version}}')"
  echo "[dev] Collected runtime status:"
  status
}

stop_stack() {
  echo "[dev] Stopping Nova gateway containers..."
  run_docker stop nova-openclaw nova-skill-scanner 2>/dev/null || true
  echo "[dev] Nova gateway containers stopped."
}

prune_stack() {
  echo "[dev] Removing Nova gateway containers and network artifacts..."
  run_docker rm -f nova-openclaw nova-skill-scanner 2>/dev/null || true
  run_docker network rm nova-net 2>/dev/null || true
  echo "[dev] Cleanup complete."
}

status() {
  if [ -z "${ACTIVE_DOCKER_HOST:-}" ]; then
    resolve_runtime_host || true
  fi

  if [ -n "${ACTIVE_DOCKER_HOST:-}" ]; then
    echo "[dev] Using Docker host: $ACTIVE_DOCKER_HOST"
  else
    echo "[dev] Using default Docker context."
  fi

  echo "[dev] Host OS: $(uname -s)"
  echo "[dev] Docker: $(run_docker --version | head -n 1)"
  if is_docker_running; then
    echo "[dev] Docker socket: ready"
  else
    echo "[dev] Docker socket: unavailable"
  fi

  if [ -n "${COLIMA_BIN:-}" ]; then
    for profile in "${colima_profiles[@]}"; do
      if colima_running_profile "$profile"; then
        echo "[dev] Colima profile: $profile (running)"
      else
        echo "[dev] Colima profile: $profile (stopped)"
      fi
    done
  else
    echo "[dev] Colima: not configured"
  fi

  echo "[dev] Containers:"
  run_docker ps -a --filter "name=nova-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" || true

  echo "[dev] Network:"
  if run_docker network inspect nova-net >/dev/null 2>&1; then
    echo "[dev] nova-net exists"
  else
    echo "[dev] nova-net missing"
  fi
}

up_stack() {
  start_stack
  echo "[dev] Starting Nova app with runtime prepared..."
  if [ -n "${ACTIVE_DOCKER_HOST}" ]; then
    echo "[dev] Launching with NOVA_COLIMA_HOME=$COLIMA_HOME and DOCKER_HOST=$ACTIVE_DOCKER_HOST"
    NOVA_COLIMA_HOME="$COLIMA_HOME" DOCKER_HOST="$ACTIVE_DOCKER_HOST" pnpm tauri:dev
  else
    echo "[dev] Launching with NOVA_COLIMA_HOME=$COLIMA_HOME"
    NOVA_COLIMA_HOME="$COLIMA_HOME" pnpm tauri:dev
  fi
}

tail_logs() {
  local target="${1:-nova-openclaw}"
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
    tail_logs "${2:-nova-openclaw}"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "Unknown command: ${1:-}"
    usage
    exit 1
    ;;
esac
