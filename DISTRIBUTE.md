# Distributing Entropic for macOS

This guide covers signing, notarizing, and distributing the Entropic app for macOS.

## Prerequisites

- Apple Developer Program membership ($99/year)
- Developer ID Application certificate installed in Keychain
- App-specific password from [Apple ID](https://appleid.apple.com/account/manage)

## 1. Build the App

```bash
# From the project root on a Mac
cd ~/entropic-build
pnpm tauri build
```

The app will be at: `src-tauri/target/release/bundle/macos/Entropic.app`

## 2. Sign + Notarize (Scripted)

This repo includes a helper script that reads signing settings from a root `.env`.

1. Create your local signing env file:
```bash
cp .env.signing.example .env.signing
```

2. Edit `.env.signing` with your signing details:
```
CERT="Developer ID Application: YOUR NAME (TEAMID)"
APPLE_ID="you@appleid.com"
TEAM_ID="TEAMID"
APP_PASSWORD="app-specific-password"
```

3. Run the signing + notarization script:
```bash
./scripts/sign-notarize-macos.sh
```

The DMG will be created at `~/Entropic.dmg` unless overridden via env vars.

## 3. Sign All Binaries (Manual)

Replace `YOUR NAME` and `TEAMID` with your certificate details. Find yours with:
```bash
security find-identity -v -p codesigning | grep "Developer ID"
```

```bash
cd ~/entropic-build/src-tauri/target/release/bundle/macos

# Set your certificate
CERT="Developer ID Application: YOUR NAME (TEAMID)"

# Sign bundled binaries first (inside-out signing)
codesign --force --options runtime --timestamp --sign "$CERT" \
  Entropic.app/Contents/Resources/resources/bin/docker

codesign --force --options runtime --timestamp --sign "$CERT" \
  Entropic.app/Contents/Resources/resources/bin/colima

codesign --force --options runtime --timestamp --sign "$CERT" \
  Entropic.app/Contents/Resources/resources/bin/limactl

# Sign the main app with entitlements (required for Virtualization.framework)
# The entitlements.plist is in src-tauri/ directory
codesign --force --options runtime --timestamp --sign "$CERT" \
  --entitlements ../../src-tauri/entitlements.plist \
  --deep Entropic.app

# Verify signature
codesign --verify --verbose Entropic.app
```

## 4. Create DMG

```bash
./scripts/create-macos-dmg.sh \
  src-tauri/target/release/bundle/macos/Entropic.app \
  ~/Entropic.dmg \
  "Entropic" \
  src-tauri/icons/dmg-background.png
codesign --force --timestamp --sign "$CERT" ~/Entropic.dmg
```

`create-macos-dmg.sh` creates a Finder-friendly installer layout:
- `Entropic.app`
- `Applications` shortcut
- `Install Entropic.txt`
- fixed icon placement and optional background image

## 5. Notarize

Submit to Apple for notarization:
```bash
xcrun notarytool submit ~/Entropic.dmg \
  --apple-id "your-apple-id@email.com" \
  --team-id "TEAMID" \
  --password "your-app-specific-password" \
  --wait
```

This usually takes 2-10 minutes. On success, staple the ticket:
```bash
xcrun stapler staple ~/Entropic.dmg
```

## 6. Verify

```bash
spctl --assess --type open --context context:primary-signature --verbose ~/Entropic.dmg
```

## Auto Updates (GitHub Releases + Silent Install)

Entropic uses the Tauri updater to deliver silent updates for DMG installs. The DMG is only the installer — updates are applied from signed updater artifacts (`.app.tar.gz` + `.sig`) hosted in a public releases repo.

### 1. Create a Public Releases Repo

Use a separate public releases repo for signed updater assets and installer
artifacts (example: `entropic-releases`). This works whether the source repo is
public or private.

### 2. Generate Updater Signing Keys

On a secure machine:
```bash
pnpm tauri signer generate -- -w ~/.tauri/entropic-updater.key
```

This writes:
- `~/.tauri/entropic-updater.key` (private key — keep secret)
- `~/.tauri/entropic-updater.key.pub` (public key — commit to config)

### 3. Configure Tauri Updater

Edit `src-tauri/tauri.conf.json`:
```json
{
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "REPLACE_WITH_UPDATER_PUBLIC_KEY",
      "endpoints": [
        "https://github.com/ORG/entropic-releases/releases/latest/download/latest.json"
      ]
    }
  }
}
```

### 4. Build With Signing Key

The updater artifacts are signed at build time. Provide the private key in env:
```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/entropic-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" # set if you used one
pnpm tauri build
```

Artifacts will be in:
```
src-tauri/target/release/bundle/macos/
  Entropic.app.tar.gz
  Entropic.app.tar.gz.sig
```

### 5. Publish Release + latest.json

Create a GitHub release in the public repo and upload:
- `Entropic.app.tar.gz`
- `Entropic.app.tar.gz.sig`
- `latest.json`

`latest.json` must point to the tarball URL. Example:
```json
{
  "version": "0.1.1",
  "notes": "Bug fixes and improvements.",
  "pub_date": "2026-02-08T00:00:00Z",
  "platforms": {
    "darwin-x86_64": {
      "url": "https://github.com/ORG/entropic-releases/releases/download/v0.1.1/Entropic.app.tar.gz",
      "signature": "BASE64_SIGNATURE"
    },
    "darwin-aarch64": {
      "url": "https://github.com/ORG/entropic-releases/releases/download/v0.1.1/Entropic.app.tar.gz",
      "signature": "BASE64_SIGNATURE"
    }
  }
}
```

### 6. Silent Auto-Update Behavior

Entropic checks for updates on app start in production, silently downloads + installs, then immediately relaunches. Dev builds skip the updater.

If you want to delay relaunch or add UI prompts, change the update flow in `src/App.tsx`.

## Troubleshooting

### Check notarization status
```bash
xcrun notarytool log <submission-id> \
  --apple-id "your@email.com" \
  --team-id "TEAMID" \
  --password "app-specific-password"
```

### "App is damaged" error
Users downloading unsigned/non-notarized apps can run:
```bash
xattr -cr /path/to/Entropic.app
```

### List signing certificates
```bash
security find-identity -v -p codesigning
```

### Create app-specific password
1. Go to https://appleid.apple.com/account/manage
2. Sign in → Security → App-Specific Passwords → Generate

## Quick Reference

| Step | Command |
|------|---------|
| Find certificate | `security find-identity -v -p codesigning \| grep "Developer ID"` |
| Sign binary | `codesign --force --options runtime --timestamp --sign "$CERT" <file>` |
| Verify signature | `codesign --verify --verbose Entropic.app` |
| Create DMG | `./scripts/create-macos-dmg.sh src-tauri/target/release/bundle/macos/Entropic.app Entropic.dmg` |
| Notarize | `xcrun notarytool submit Entropic.dmg --apple-id ... --team-id ... --password ... --wait` |
| Staple | `xcrun stapler staple Entropic.dmg` |
