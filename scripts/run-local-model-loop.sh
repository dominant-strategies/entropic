#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT="${HOME}/.local/share/ai.openclaw.entropic.dev/rnn-runtime"
STATE_DIR="${ROOT}/state"
BRIDGE_DIR="${ROOT}/bridge"
MODELS_DIR="${ROOT}/models"
SOCKET_PATH="${BRIDGE_DIR}/runtime.sock"
PYTHON_BIN="${ROOT}/venv/bin/python"
SERVER_SCRIPT="${PROJECT_ROOT}/src-tauri/resources/share/rnn-runtime/server.py"
LOG_PATH="/tmp/entropic-local-model-loop-runtime.log"

mkdir -p "${STATE_DIR}" "${BRIDGE_DIR}" "${MODELS_DIR}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

pkill -f "share/rnn-runtime/server.py" >/dev/null 2>&1 || true
rm -f "${SOCKET_PATH}"
: > "${LOG_PATH}"

env \
  PYTHONUNBUFFERED=1 \
  TORCH_EXTENSIONS_DIR="${STATE_DIR}/torch_extensions" \
  HF_HOME="${STATE_DIR}/huggingface" \
  TRANSFORMERS_CACHE="${STATE_DIR}/huggingface" \
  "${PYTHON_BIN}" "${SERVER_SCRIPT}" \
  --host 127.0.0.1 \
  --port 11445 \
  --unix-socket "${SOCKET_PATH}" \
  --models-dir "${MODELS_DIR}" \
  --state-dir "${STATE_DIR}" \
  >"${LOG_PATH}" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
  if [[ -S "${SOCKET_PATH}" ]]; then
    break
  fi
  if ! kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    cat "${LOG_PATH}" >&2 || true
    echo "managed runtime exited before the socket became ready" >&2
    exit 1
  fi
  sleep 0.25
done

if [[ ! -S "${SOCKET_PATH}" ]]; then
  cat "${LOG_PATH}" >&2 || true
  echo "managed runtime did not create ${SOCKET_PATH}" >&2
  exit 1
fi

node "${PROJECT_ROOT}/scripts/local-model-harness.mjs" --runtime-log "${LOG_PATH}" "$@"
