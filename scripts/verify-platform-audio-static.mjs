import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const infoPlist = read("src-tauri/Info.plist");
assert.match(infoPlist, /<key>NSMicrophoneUsageDescription<\/key>/);
assert.match(
  infoPlist,
  /<string>Entropic uses your microphone only when you record audio in chat or voice controls\.<\/string>/,
);
assert.match(infoPlist, /<key>NSSpeechRecognitionUsageDescription<\/key>/);
assert.match(
  infoPlist,
  /<string>Entropic uses speech recognition to turn your voice into text when you request it\.<\/string>/,
);

const entitlements = read("src-tauri/entitlements.plist");
assert.match(entitlements, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/);

const cargoToml = read("src-tauri/Cargo.toml");
assert.match(cargoToml, /\[target\.'cfg\(target_os = "linux"\)'\.dependencies\]/);
assert.match(cargoToml, /webkit2gtk\s*=\s*\{\s*version\s*=\s*"2\.0\.2",\s*features\s*=\s*\["v2_40"\]\s*\}/);

const libRs = read("src-tauri/src/lib.rs");
assert.match(libRs, /#\[cfg\(target_os = "linux"\)\]\s*fn install_linux_webview_media_permissions/);
assert.match(libRs, /UserMediaPermissionRequest/);
assert.match(libRs, /user_media\.is_for_audio_device\(\)\s*&&\s*!user_media\.is_for_video_device\(\)/);
assert.match(libRs, /request\.allow\(\);/);
assert.match(libRs, /install_linux_webview_media_permissions\(app\);/);

console.log("platform audio static checks passed");
