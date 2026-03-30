#!/usr/bin/env bash
set -euo pipefail

ROOT="${HOME}/.local/share/ai.openclaw.entropic.dev/rnn-runtime"
STATE_DIR="${ROOT}/state"
BRIDGE_DIR="${ROOT}/bridge"
MODELS_DIR="${ROOT}/models"
LOG_FILE="${ROOT}/runtime.log"
PID_FILE="${ROOT}/runtime.pid"
SOCKET_PATH="${BRIDGE_DIR}/runtime.sock"
PYTHON_BIN="${ROOT}/venv/bin/python"
SERVER_SCRIPT="/home/alan/agent/entropic/src-tauri/resources/share/rnn-runtime/server.py"

mkdir -p "${BRIDGE_DIR}" "${STATE_DIR}" "${MODELS_DIR}"

pkill -f "share/rnn-runtime/server.py" >/dev/null 2>&1 || true
sleep 1
rm -f "${SOCKET_PATH}"

nohup env \
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
  >> "${LOG_FILE}" 2>&1 < /dev/null &

echo "$!" > "${PID_FILE}"
sleep 2
cat "${PID_FILE}"
