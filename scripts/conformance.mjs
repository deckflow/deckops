#!/usr/bin/env node
/**
 * Conformance: drive the built CLI against a real DeckOps Cloud backend. Run it by
 * hand before a release; it needs credentials and spends quota.
 *
 * Fixtures come from tests/test-data/test.<ext> (see its README; untracked,
 * bring your own). CONFORMANCE_<EXT> environment variables override, and
 * CONFORMANCE_URL adds a link one-shot case:
 *
 *   DECKOPS_API_BASE=…  DECKOPS_TOKEN=…  node scripts/conformance.mjs
 *
 * Uses an isolated DECKFLOW_CONFIG_DIR so only the credentials in the environment
 * are used, never ones inherited from other DeckFlow tools.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist/cli.js');
if (!existsSync(cli)) {
  console.error('Build first: pnpm build');
  process.exit(1);
}
if (!process.env.DECKOPS_TOKEN && !process.env.DECKOPS_API_KEY) {
  console.error('Set DECKOPS_TOKEN or DECKOPS_API_KEY (and DECKOPS_API_BASE for a non-production backend).');
  process.exit(1);
}

const work = mkdtempSync(path.join(tmpdir(), 'deckops-conformance-'));
const configDir = path.join(work, 'config');
mkdirSync(configDir);
const env = {
  ...process.env,
  DECKFLOW_CONFIG_DIR: configDir,
  DECKOPS_CONFIG_DIR: configDir,
};

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`✗ ${label}\n  ${error.message}`);
  }
};

const run = (args, options = {}) => {
  const stdout = execFileSync('node', [cli, ...args], { env, cwd: work, encoding: 'utf-8', ...options });
  return stdout;
};
const runJson = (args) => JSON.parse(run([...args, '--json']));

const dataDir = path.join(root, 'tests/test-data');
const sampleFor = (ext) => {
  const override = process.env[`CONFORMANCE_${ext.toUpperCase()}`];
  if (override) return override;
  const fixture = path.join(dataDir, `test.${ext}`);
  return existsSync(fixture) ? fixture : undefined;
};

for (const format of ['pdf', 'pptx', 'docx', 'key']) {
  const sample = sampleFor(format);
  if (!sample) {
    console.log(`- ${format}: no sample (set CONFORMANCE_${format.toUpperCase()}), skipped`);
    continue;
  }
  const local = path.join(work, `sample.${format}`);
  cpSync(sample, local);
  const artifact = path.join(work, `artifact-${format}`);

  check(`${format}: parse stores the server IR with manifest v3`, () => {
    const envelope = runJson(['parse', local, '-o', artifact]);
    if (!envelope.ok || envelope.reusedParse || !envelope.taskId || !envelope.irKey || !envelope.irSchemaVersion || !envelope.expiresAt) {
      throw new Error(JSON.stringify(envelope));
    }
    const manifest = JSON.parse(readFileSync(path.join(artifact, 'manifest.json'), 'utf8'));
    if (manifest.manifestVersion !== 3 || manifest.parse.irKey !== envelope.irKey) throw new Error('not a manifest v3');
    const ir = JSON.parse(readFileSync(path.join(artifact, 'ir.json'), 'utf8'));
    if (ir.irKey !== envelope.irKey) throw new Error('ir.json is not the server response');
  });

  check(`${format}: second parse reuses the artifact (zero cloud calls)`, () => {
    const envelope = runJson(['parse', local, '-o', artifact]);
    if (!envelope.reusedParse) throw new Error(JSON.stringify(envelope));
  });

  check(`${format}: convert derives the view without re-parsing`, () => {
    const envelope = runJson(['convert', artifact]);
    if (!envelope.ok || !envelope.reusedParse || !envelope.taskId) throw new Error(JSON.stringify(envelope));
    const view = readFileSync(path.join(artifact, 'views/markdown/index.md'), 'utf-8');
    if (/Expires=/i.test(view)) throw new Error('view still contains expiring links');
  });

  check(`${format}: second convert hits the cached view`, () => {
    const envelope = runJson(['convert', artifact]);
    if (envelope.taskId !== null) throw new Error(JSON.stringify(envelope));
  });
}

if (process.env.CONFORMANCE_URL) {
  check('url: one-shot convert produces durable markdown', () => {
    const target = path.join(work, 'page.md');
    const envelope = runJson(['convert', process.env.CONFORMANCE_URL, '-o', target]);
    if (!envelope.ok || !envelope.taskId || !envelope.parseTaskId) throw new Error(JSON.stringify(envelope));
    if (/Expires=/i.test(readFileSync(target, 'utf-8'))) throw new Error('markdown contains expiring links');
  });
}

check('unsupported input fails with exit 3 and a hint', () => {
  try {
    run(['parse', path.join(root, 'package.json')]);
    throw new Error('should have failed');
  } catch (error) {
    if (error.status !== 3) throw new Error(`exit ${error.status}, wanted 3`);
  }
});

// Negative fixtures: real spreadsheet/iWork files must be refused, not mangled.
for (const ext of ['xlsx', 'numbers']) {
  const sample = sampleFor(ext);
  if (!sample) continue;
  check(`${ext}: real file is refused with unsupported (exit 3)`, () => {
    try {
      run(['parse', sample]);
      throw new Error('should have failed');
    } catch (error) {
      if (error.status !== 3) throw new Error(`exit ${error.status}, wanted 3`);
    }
  });
}

console.log(failures === 0 ? '\nconformance: all green' : `\nconformance: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
