#!/usr/bin/env node

const [, , manifestUrl, rawExpectedVersion, ...requiredPlatforms] = process.argv;

function fail(message) {
  console.error(`[validate-public-release] ${message}`);
  process.exit(1);
}

if (!manifestUrl || !rawExpectedVersion || requiredPlatforms.length === 0) {
  fail(
    "Usage: node scripts/validate-public-release.mjs <manifest-url> <expected-semver> <platform> [platform...]",
  );
}

const expectedVersion = rawExpectedVersion.replace(/^v/, "");

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "entropic-release-validator",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    fail(`Failed to fetch manifest ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function assertAssetReachable(url) {
  const headResponse = await fetch(url, {
    method: "HEAD",
    headers: {
      "user-agent": "entropic-release-validator",
    },
    redirect: "follow",
  });
  if (headResponse.ok) {
    return;
  }

  const getResponse = await fetch(url, {
    method: "GET",
    headers: {
      "range": "bytes=0-0",
      "user-agent": "entropic-release-validator",
    },
    redirect: "follow",
  });
  if (!getResponse.ok && getResponse.status !== 206) {
    fail(`Release asset is not reachable: ${url} (${getResponse.status} ${getResponse.statusText})`);
  }
}

const manifest = await fetchJson(manifestUrl);

if (manifest.version !== expectedVersion) {
  fail(`Manifest version is ${manifest.version}, expected ${expectedVersion}`);
}

const tag = `v${expectedVersion}`;
const platforms = manifest.platforms ?? {};

for (const platform of requiredPlatforms) {
  const entry = platforms[platform];
  if (!entry) {
    fail(`Manifest is missing required platform ${platform}`);
  }
  if (typeof entry.signature !== "string" || !entry.signature.trim()) {
    fail(`Manifest platform ${platform} has an empty signature`);
  }
  if (typeof entry.url !== "string" || !entry.url.includes(`/releases/download/${tag}/`)) {
    fail(`Manifest platform ${platform} URL does not point at ${tag}: ${entry.url ?? "<missing>"}`);
  }
  await assertAssetReachable(entry.url);
}

console.log(
  `[validate-public-release] Manifest ${manifestUrl} is valid for ${expectedVersion} (${requiredPlatforms.join(", ")})`,
);
