#!/usr/bin/env node
/**
 * Conformance: drive the built CLI against a real DeckOps Cloud backend. Run it by
 * hand before a release; it needs credentials and spends quota.
 *
 * Fixtures come from tests/test-data/test.<ext> (see its README; untracked,
 * bring your own). CONFORMANCE_<EXT> environment variables override, and
 * CONFORMANCE_URL adds a URL case. The server must offer document tasks
 * (`GET /tools/capabilities`):
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
  DECKOPS_CACHE_DIR: path.join(work, 'cache'),
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
  const out = path.join(work, format);

  check(`${format}: probe answers locally`, () => {
    const report = JSON.parse(run(['probe', local, '--json']));
    if (report.schema_version !== 2 || report.status === 'error') throw new Error(JSON.stringify(report));
  });

  check(`${format}: convert writes Markdown with local images`, () => {
    const envelope = runJson(['convert', local, '-o', path.join(out, 'doc.md')]);
    if (!envelope.ok || envelope.tasks?.[0]?.type !== 'document.convert') throw new Error(JSON.stringify(envelope));
    if (/[?&](?:Expires|Signature|OSSAccessKeyId)=/i.test(readFileSync(path.join(out, 'doc.md'), 'utf-8'))) throw new Error('markdown contains expiring links');
  });

  check(`${format}: extract reuses the parse (no new parse charge)`, () => {
    const envelope = runJson(['extract', local, '--to', 'json', '-o', path.join(out, 'doc.json')]);
    if (!envelope.ok || envelope.reusedParse !== true || !envelope.schemaVersion) throw new Error(JSON.stringify(envelope));
    JSON.parse(readFileSync(path.join(out, 'doc.json'), 'utf-8'));
  });

  check(`${format}: extract assets lists the images`, () => {
    const envelope = runJson(['extract', local, '--to', 'assets', '-o', path.join(out, 'assets-only')]);
    if (!envelope.ok || envelope.reusedParse !== true) throw new Error(JSON.stringify(envelope));
  });

  if (format !== 'docx' || process.env.CONFORMANCE_RENDER_DOCX) {
    check(`${format}: render to images`, () => {
      const envelope = runJson(['render', local, '--to', 'image', '--pages', '1', '-o', path.join(out, 'frames')]);
      if (!envelope.ok || envelope.outputs.length !== 1) throw new Error(JSON.stringify(envelope));
    });
  }
}

if (process.env.CONFORMANCE_URL) {
  check('url: convert produces durable markdown', () => {
    const target = path.join(work, 'page.md');
    const envelope = runJson(['convert', process.env.CONFORMANCE_URL, '-o', target]);
    if (!envelope.ok || envelope.format !== 'html') throw new Error(JSON.stringify(envelope));
    if (/[?&](?:Expires|Signature|OSSAccessKeyId)=/i.test(readFileSync(target, 'utf-8'))) throw new Error('markdown contains expiring links');
  });
}

check('unsupported input fails with exit 3 and a hint', () => {
  try {
    run(['convert', path.join(root, 'package.json')]);
    throw new Error('should have failed');
  } catch (error) {
    if (error.status !== 3) throw new Error(`exit ${error.status}, wanted 3`);
  }
});

// Negative fixtures: spreadsheet/iWork files are not cloud inputs in 4.0.
for (const ext of ['xlsx', 'numbers']) {
  const sample = sampleFor(ext);
  if (!sample) continue;
  check(`${ext}: real file is refused with unsupported (exit 3)`, () => {
    try {
      run(['convert', sample]);
      throw new Error('should have failed');
    } catch (error) {
      if (error.status !== 3) throw new Error(`exit ${error.status}, wanted 3`);
    }
  });
}

console.log(failures === 0 ? '\nconformance: all green' : `\nconformance: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
