#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`[check-release-version] ${message}`);
  process.exit(1);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readCargoPackageVersion(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const match = raw.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    fail(`Could not find [package].version in ${filePath}`);
  }
  return match[1];
}

const rawExpectedVersion = process.argv[2];
if (!rawExpectedVersion) {
  fail("Usage: node scripts/check-release-version.mjs <expected-semver>");
}
const expectedVersion = rawExpectedVersion.replace(/^v/, "");

const repoRoot = process.cwd();
const packageJsonPath = path.join(repoRoot, "package.json");
const tauriConfigPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");
const cargoTomlPath = path.join(repoRoot, "src-tauri", "Cargo.toml");

const packageVersion = readJson(packageJsonPath).version;
const tauriVersion = readJson(tauriConfigPath).version;
const cargoVersion = readCargoPackageVersion(cargoTomlPath);

const versions = [
  ["package.json", packageVersion],
  ["src-tauri/tauri.conf.json", tauriVersion],
  ["src-tauri/Cargo.toml", cargoVersion],
];

for (const [label, actual] of versions) {
  if (actual !== expectedVersion) {
    fail(`${label} is ${actual}, expected ${expectedVersion}`);
  }
}

console.log(`[check-release-version] All release versions match ${expectedVersion}`);
