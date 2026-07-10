#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const PACKAGES = [
  { path: 'sdks/typescript/package.json', name: '@deckops/sdk' },
  { path: 'apps/node-cli/package.json', name: 'deckops' },
];

const bumpType = process.argv[2] ?? 'patch';

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function bumpVersion(version, type) {
  const parts = version.split('.').map(Number);
  if (type === 'major') {
    parts[0] += 1;
    parts[1] = 0;
    parts[2] = 0;
  } else if (type === 'minor') {
    parts[1] += 1;
    parts[2] = 0;
  } else if (type === 'patch') {
    parts[2] += 1;
  } else {
    throw new Error(`Invalid bump type "${type}". Use patch, minor, or major.`);
  }
  return parts.join('.');
}

function getPublishedVersion(name) {
  try {
    return execSync(`npm view ${name} version`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function readPackage(relativePath) {
  const fullPath = join(root, relativePath);
  return {
    fullPath,
    data: JSON.parse(readFileSync(fullPath, 'utf8')),
  };
}

function writePackage(fullPath, data) {
  writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`);
}

const localVersions = PACKAGES.map((pkg) => {
  const { data } = readPackage(pkg.path);
  return { ...pkg, localVersion: data.version };
});

const uniqueLocalVersions = new Set(localVersions.map((pkg) => pkg.localVersion));
if (uniqueLocalVersions.size > 1) {
  const details = localVersions.map((pkg) => `${pkg.name}@${pkg.localVersion}`).join(', ');
  throw new Error(`Package versions are out of sync: ${details}`);
}

const localVersion = localVersions[0].localVersion;
const publishedVersions = PACKAGES.map((pkg) => ({
  name: pkg.name,
  publishedVersion: getPublishedVersion(pkg.name),
}));

for (const { name, publishedVersion } of publishedVersions) {
  if (publishedVersion && compareVersions(localVersion, publishedVersion) < 0) {
    throw new Error(
      `Local version ${localVersion} is lower than published ${name}@${publishedVersion}`,
    );
  }
}

const publishedVersion = publishedVersions.find((pkg) => pkg.publishedVersion)?.publishedVersion;
let nextVersion = localVersion;

if (!publishedVersion || compareVersions(localVersion, publishedVersion) === 0) {
  nextVersion = bumpVersion(localVersion, bumpType);
  console.log(
    `Bumping ${localVersion} -> ${nextVersion} (${publishedVersion ? 'already published' : 'first publish'})`,
  );
} else {
  console.log(`Using existing local version ${localVersion} (npm latest: ${publishedVersion})`);
}

if (nextVersion !== localVersion) {
  for (const pkg of PACKAGES) {
    const { fullPath, data } = readPackage(pkg.path);
    data.version = nextVersion;
    writePackage(fullPath, data);
    console.log(`Updated ${data.name} to ${nextVersion}`);
  }
}

console.log(`Release version: ${nextVersion}`);
