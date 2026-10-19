import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeCloud, FIXTURE_PNG } from '../tests/browser/fake-cloud.mjs';

/** The built CLI's content contract over real HTTP against the wire-protocol fixture. */
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deckops-read-cli-'));
const config = path.join(temp, 'config'); fs.mkdirSync(config);
const cloud = await createFakeCloud();
const env = {
  ...process.env, DECKOPS_CACHE_DIR: path.join(temp, 'cache with spaces'), DECKOPS_CONFIG_DIR: config, DECKFLOW_CONFIG_DIR: config,
  DECKOPS_API_BASE: cloud.apiBase('read'), DECKOPS_TOKEN: 'test-token',
};
for (const name of ['DECKOPS_API_KEY', 'DECKFLOW_API_KEY', 'DECKFLOW_TOKEN', 'DECKOPS_SPACE_ID', 'DECKFLOW_SPACE_ID', 'DECKFLOW_API_BASE']) delete env[name];
// Async: the fixture answers from this process, so a synchronous spawn would deadlock.
const run = (args, success = true) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(root, 'dist/cli.js'), ...args], { cwd: root, env, encoding: 'utf8', timeout: 15000 }, (error, stdout, stderr) => {
    const status = error ? error.code : 0;
    if (success) assert.equal(status, 0, stderr || stdout); else assert.notEqual(status, 0, stdout);
    resolve({ status, stdout, stderr });
  });
});
const json = async (args, success = true) => JSON.parse((await run(args, success)).stdout);
try {
  const file = path.join(root, 'tests/generated/test.pdf');
  const page = (prefix) => `# Page one\n\n![](${prefix}image.png)\n\n---\n\n# Page two`;

  const first = await json([file, '--json']);
  assert.equal(first.schemaVersion, 'deckops.read.v2'); assert.equal(first.report.schemaVersion, 'deckops.run.v2');
  const cached = path.join(first.report.artifactBase, 'assets').replaceAll(' ', '%20') + '/';
  assert.equal(first.content, page(cached)); assert.ok(first.content.includes('%20'));
  assert.equal(cloud.state('read').requests.filter((req) => req.path === '/user').length, 1, 'one client per command');
  for (const asset of first.assets) { assert.equal(asset.lifecycle, 'cache'); assert.deepEqual(fs.readFileSync(asset.path), FIXTURE_PNG); }
  assert.equal((await run([file])).stdout, page(cached));
  assert.equal((await run([file, '--quiet'])).stdout, page(cached));
  assert.equal(JSON.parse((await run([file, '--format', 'ir'])).stdout).irKey, 'fixture/task-1/ir.json');
  assert.equal(cloud.state('read').tasks.length, 2, 'repeat reads reuse the cached parse and view');

  const exported = path.join(temp, 'portable.md'), report = path.join(temp, 'run.json');
  assert.equal((await run([file, '-o', exported, '--report', report])).stdout, '');
  assert.match(fs.readFileSync(exported, 'utf8'), /!\[\]\(portable\.assets-[0-9a-f]{8}\/image\.png\)/);
  assert.equal(JSON.parse(fs.readFileSync(report, 'utf8')).schemaVersion, 'deckops.run.v2');
  const written = await json([file, '-o', exported, '--json']);
  for (const asset of written.assets) { assert.equal(asset.lifecycle, 'output'); assert.ok(fs.existsSync(asset.path)); }

  assert.ok((await run(['convert', file, '-o', '-'])).stdout.startsWith('# Page one\n\n![]('));
  assert.ok((await json(['convert', file, '-o', '-', '--json'])).content.startsWith('# Page one'));
  const artifact = path.join(temp, 'artifact');
  const parsed = await json(['parse', file, '-o', artifact, '--json']);
  assert.equal(parsed.op, 'parse'); assert.equal(parsed.reusedParse, false); assert.equal(parsed.format, 'pdf');
  assert.equal((await json(['parse', file, '-o', artifact, '--json'])).reusedParse, true);
  const view = await json(['convert', artifact, '--json']);
  assert.equal(view.parseTaskId, parsed.taskId); assert.match(fs.readFileSync(path.join(artifact, 'views/markdown/index.md'), 'utf8'), /\.\.\/\.\.\/assets\/image\.png/);
  assert.equal((await json(['convert', artifact, '--json'])).taskId, null);

  // Removed 2.x surface fails as a usage error; the error envelope keeps its shape.
  for (const args of [[file, '--engine', 'cloud'], [file, '--preflight', 'off'], [file, '--allow-upload'], ['parse', file, '--tracked-changes', 'all'], ['config', 'migrate']]) {
    assert.equal((await run(args, false)).status, 2, args.join(' '));
  }
  assert.equal((await run(['--timeout', '0', file], false)).status, 2);
  const collision = await json([file, '--output', file, '--json'], false);
  assert.equal(collision.schemaVersion, 'deckops.read.v2'); assert.equal(collision.error.code, 'usage_error');
  assert.equal((await json(['formats', '--json'])).length, 6);
  console.log('Built CLI content contract passed: stdout/JSON, IR, cached and exported images, reports, parse/convert artifacts and removed options.');
} finally {
  await cloud.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
