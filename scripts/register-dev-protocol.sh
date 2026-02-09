#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script only supports Linux."
  exit 0
fi

if [[ -f "/.dockerenv" ]]; then
  echo "Detected a container environment."
  echo "Run this script on the host so xdg-mime registers the protocol handler."
  exit 1
fi

if ! command -v xdg-mime >/dev/null 2>&1; then
  echo "xdg-mime not found. Install xdg-utils and re-run this script."
  exit 1
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP_FILE="$HOME/.local/share/applications/nova-dev.desktop"
BIN="$PROJECT_ROOT/src-tauri/target/debug/nova"
ICON="$PROJECT_ROOT/src-tauri/icons/128x128.png"
SCHEME="nova-dev"

if [[ ! -x "$BIN" ]]; then
  echo "Expected debug binary at $BIN."
  echo "Run 'pnpm tauri dev' once to build it, then re-run this script."
  exit 1
fi

mkdir -p "$(dirname "$DESKTOP_FILE")"

cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Name=Nova (Dev)
Comment=Nova dev deep link handler
Exec=$BIN %u
Icon=$ICON
Type=Application
Terminal=false
Categories=Development;
MimeType=x-scheme-handler/$SCHEME;
NoDisplay=true
EOF

xdg-mime default nova-dev.desktop x-scheme-handler/$SCHEME
update-desktop-database ~/.local/share/applications >/dev/null 2>&1 || true

echo "Registered $SCHEME:// handler for dev."
