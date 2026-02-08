#!/usr/bin/env bash
set -euo pipefail

# This script registers the nova:// protocol handler for development on macOS

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only supports macOS."
  exit 0
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$PROJECT_ROOT/src-tauri/target/debug/nova"

# Check if debug binary exists
if [[ ! -x "$BIN" ]]; then
  echo "Expected debug binary at $BIN."
  echo "Run 'pnpm tauri dev' once to build it, then re-run this script."
  exit 1
fi

echo "Registering nova:// protocol handler for development..."

# Create a temporary plist for LSSetDefaultHandlerForURLScheme
/usr/bin/python3 << EOF
import subprocess
import os

# Get the debug binary path
binary_path = "$BIN"

# Use Cocoa/AppKit to register the handler (requires Python with Objective-C bridge)
try:
    from Foundation import NSBundle, NSURL
    from AppKit import NSWorkspace
    from LaunchServices import LSSetDefaultHandlerForURLScheme

    # Register nova:// scheme to open with the debug binary
    # Note: For development, we need to use the actual app bundle if it exists
    # Otherwise, we'll create a simple script wrapper

    # Try to register using LaunchServices
    bundle_id = "ai.openclaw.nova"
    result = LSSetDefaultHandlerForURLScheme("nova", bundle_id)

    if result == 0:
        print("✅ Successfully registered nova:// handler using bundle ID")
    else:
        print("⚠️  Could not register using bundle ID, trying alternative method...")
        raise Exception("Bundle registration failed")

except Exception as e:
    # Fallback: Create a simple launcher script
    launcher_path = os.path.expanduser("~/Library/Application Support/Nova/nova-dev-launcher.sh")
    os.makedirs(os.path.dirname(launcher_path), exist_ok=True)

    with open(launcher_path, 'w') as f:
        f.write(f'''#!/bin/bash
# Nova development launcher for deep links
exec "{binary_path}" "$@"
''')

    os.chmod(launcher_path, 0o755)

    # Register using defaults command (less reliable but worth trying)
    subprocess.run([
        'defaults', 'write',
        'com.apple.LaunchServices/com.apple.launchservices.secure',
        'LSHandlers', '-array-add',
        f'{{"LSHandlerURLScheme"="nova";"LSHandlerRoleAll"="ai.openclaw.nova";}}'
    ])

    print("⚠️  Fallback registration attempted.")
    print("    You may need to:")
    print("    1. Build the app bundle first: pnpm tauri build --debug")
    print("    2. Open the debug app once to register it with macOS")
    print("    3. Or manually associate nova:// URLs with Nova.app")
EOF

# Alternative method using SwiftDefaultApps if installed
if command -v swda >/dev/null 2>&1; then
  echo "Found SwiftDefaultApps, attempting registration..."
  swda setHandler --URL nova --app "$PROJECT_ROOT/src-tauri/target/debug/bundle/macos/Nova.app" 2>/dev/null || true
fi

echo ""
echo "📝 Notes for macOS development:"
echo "   - The nova:// protocol may not work perfectly in dev mode"
echo "   - For best results, build a debug bundle: pnpm tauri build --debug"
echo "   - Then open Nova.app once to register it with macOS"
echo "   - OAuth redirects should then work properly"
echo ""
echo "🔧 Quick fix if redirects don't work:"
echo "   1. After OAuth in browser, copy the redirect URL"
echo "   2. In Nova's console, run: handleAuthCallback('nova://auth/callback#...')"