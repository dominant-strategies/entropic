#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Load env from $ENV_FILE, then fallback to .env.signing, then .env in project root.
ENV_FILE="${ENV_FILE:-}"
if [ -z "$ENV_FILE" ]; then
  if [ -f "$PROJECT_ROOT/.env.signing" ]; then
    ENV_FILE="$PROJECT_ROOT/.env.signing"
  else
    ENV_FILE="$PROJECT_ROOT/.env"
  fi
fi
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

APP_PATH="${APP_PATH:-$PROJECT_ROOT/src-tauri/target/release/bundle/macos/Nova.app}"
DMG_PATH="${DMG_PATH:-$HOME/Nova.dmg}"
ENTITLEMENTS_PATH="${ENTITLEMENTS_PATH:-$PROJECT_ROOT/src-tauri/entitlements.plist}"

# Prefer GitHub Actions secret names, keep legacy names as fallback.
APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-${CERT:-}}"
APPLE_ID="${APPLE_ID:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-${TEAM_ID:-}}"
APPLE_APP_PASSWORD="${APPLE_APP_PASSWORD:-${APP_PASSWORD:-}}"

if [ -z "$APPLE_SIGNING_IDENTITY" ] || [ -z "$APPLE_ID" ] || [ -z "$APPLE_TEAM_ID" ] || [ -z "$APPLE_APP_PASSWORD" ]; then
  echo "Missing required env vars. Set in $ENV_FILE or export them:"
  echo "  APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD"
  echo "Legacy aliases also supported: CERT, TEAM_ID, APP_PASSWORD"
  exit 1
fi

if [ ! -d "$APP_PATH" ]; then
  echo "Nova.app not found at: $APP_PATH"
  exit 1
fi

echo "Using:"
echo "  APP_PATH=$APP_PATH"
echo "  DMG_PATH=$DMG_PATH"
echo "  ENTITLEMENTS_PATH=$ENTITLEMENTS_PATH"
echo "  APPLE_SIGNING_IDENTITY=$APPLE_SIGNING_IDENTITY"
echo "  APPLE_ID=$APPLE_ID"
echo "  APPLE_TEAM_ID=$APPLE_TEAM_ID"

APP_DIR="$(dirname "$APP_PATH")"
cd "$APP_DIR"

echo "Signing bundled binaries..."
codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" \
  "$APP_PATH/Contents/Resources/resources/bin/docker"
codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" \
  "$APP_PATH/Contents/Resources/resources/bin/colima"
codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" \
  "$APP_PATH/Contents/Resources/resources/bin/limactl"

echo "Signing Nova.app..."
codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" \
  --entitlements "$ENTITLEMENTS_PATH" \
  --deep "$APP_PATH"

echo "Creating DMG..."
hdiutil create -volname Nova -srcfolder "$APP_PATH" -ov -format UDZO "$DMG_PATH"

echo "Signing DMG..."
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG_PATH"

echo "Submitting for notarization..."
xcrun notarytool submit "$DMG_PATH" \
  --apple-id "$APPLE_ID" \
  --team-id "$APPLE_TEAM_ID" \
  --password "$APPLE_APP_PASSWORD" \
  --wait

echo "Stapling notarization ticket..."
xcrun stapler staple "$DMG_PATH"

echo "Done:"
echo "  $DMG_PATH"
