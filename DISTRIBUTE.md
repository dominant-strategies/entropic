# Distributing Nova for macOS

This guide covers signing, notarizing, and distributing the Nova app for macOS.

## Prerequisites

- Apple Developer Program membership ($99/year)
- Developer ID Application certificate installed in Keychain
- App-specific password from [Apple ID](https://appleid.apple.com/account/manage)

## 1. Build the App

```bash
# From the project root on a Mac
cd ~/nova-build
pnpm tauri build
```

The app will be at: `src-tauri/target/release/bundle/macos/Nova.app`

## 2. Sign All Binaries

Replace `YOUR NAME` and `TEAMID` with your certificate details. Find yours with:
```bash
security find-identity -v -p codesigning | grep "Developer ID"
```

```bash
cd ~/nova-build/src-tauri/target/release/bundle/macos

# Set your certificate
CERT="Developer ID Application: YOUR NAME (TEAMID)"

# Sign bundled binaries first (inside-out signing)
codesign --force --options runtime --timestamp --sign "$CERT" \
  Nova.app/Contents/Resources/resources/bin/docker

codesign --force --options runtime --timestamp --sign "$CERT" \
  Nova.app/Contents/Resources/resources/bin/colima

codesign --force --options runtime --timestamp --sign "$CERT" \
  Nova.app/Contents/Resources/resources/bin/limactl

# Sign the main app with entitlements (required for Virtualization.framework)
# The entitlements.plist is in src-tauri/ directory
codesign --force --options runtime --timestamp --sign "$CERT" \
  --entitlements ../../src-tauri/entitlements.plist \
  --deep Nova.app

# Verify signature
codesign --verify --verbose Nova.app
```

## 3. Create DMG

```bash
hdiutil create -volname Nova -srcfolder Nova.app -ov -format UDZO ~/Nova.dmg
codesign --force --timestamp --sign "$CERT" ~/Nova.dmg
```

## 4. Notarize

Submit to Apple for notarization:
```bash
xcrun notarytool submit ~/Nova.dmg \
  --apple-id "your-apple-id@email.com" \
  --team-id "TEAMID" \
  --password "your-app-specific-password" \
  --wait
```

This usually takes 2-10 minutes. On success, staple the ticket:
```bash
xcrun stapler staple ~/Nova.dmg
```

## 5. Verify

```bash
spctl --assess --type open --context context:primary-signature --verbose ~/Nova.dmg
```

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
xattr -cr /path/to/Nova.app
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
| Verify signature | `codesign --verify --verbose Nova.app` |
| Create DMG | `hdiutil create -volname Nova -srcfolder Nova.app -ov -format UDZO Nova.dmg` |
| Notarize | `xcrun notarytool submit Nova.dmg --apple-id ... --team-id ... --password ... --wait` |
| Staple | `xcrun stapler staple Nova.dmg` |
