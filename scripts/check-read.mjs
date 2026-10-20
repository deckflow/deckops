import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeCloud, FIXTURE_DOCUMENT, FIXTURE_MARKDOWN, FIXTURE_PNG } from '../tests/browser/fake-cloud.mjs';

/** The built CLI's content contract over real HTTP against the wire-protocol fixture. */
const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deckops-read-cli-'));
const config = path.join(temp, 'config'); fs.mkdirSync(config);
const cloud = await createFakeCloud();
const baseEnv = { ...process.env, DECKOPS_CACHE_DIR: path.join(temp, 'cache with spaces'), DECKOPS_CONFIG_DIR: config, DECKFLOW_CONFIG_DIR: config };
for (const name of ['DECKOPS_API_KEY', 'DECKFLOW_API_KEY', 'DECKOPS_TOKEN', 'DECKFLOW_TOKEN', 'DECKOPS_SPACE_ID', 'DECKFLOW_SPACE_ID', 'DECKOPS_API_BASE', 'DECKFLOW_API_BASE']) {
  delete baseEnv[name];
}
const cloudEnv = (name) => ({ ...baseEnv, DECKOPS_API_BASE: cloud.apiBase(name), DECKOPS_TOKEN: 'test-token' });
// Async: the fixture answers from this process, so a synchronous spawn would deadlock.
const run = (args, { env = cloudEnv('cli'), success = true } = {}) => new Promise((resolve) => {
  execFile(process.execPath, [path.join(root, 'dist/cli.js'), ...args], { cwd: temp, env, encoding: 'utf8', timeout: 15000 }, (error, stdout, stderr) => {
    const status = error ? error.code : 0;
    if (success) assert.equal(status, 0, stderr || stdout); else assert.notEqual(status, 0, stdout);
    resolve({ status, stdout, stderr });
  });
});
const json = async (args, options) => JSON.parse((await run(args, options)).stdout);
/** A reader that stops early (`deckops doc.pdf | head -c 10`): the pipe is closed before DeckOps writes. */
const closed = (stream, args, env = cloudEnv('cli')) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(root, 'dist/cli.js'), ...args], { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
  child[stream].destroy();
  const other = stream === 'stdout' ? 'stderr' : 'stdout';
  const output = { [other]: '' };
  child[other].on('data', (chunk) => { output[other] += chunk; });
  child.on('error', reject);
  child.on('close', (status) => resolve({ status, ...output }));
});
const tasks = (name) => cloud.state(name).tasks;
try {
  const pdf = path.join(root, 'tests/generated/test.pdf');
  const signed = (name) => `${cloud.apiBase(name)}/results/image.png?sig=fixture`;

  // Bare source: Markdown on stdout, image links signed.
  assert.equal((await run([pdf])).stdout, FIXTURE_MARKDOWN.replace('assets/image.png', signed('cli')));
  const envelope = await json([pdf, '--json']);
  assert.equal(envelope.op, 'convert'); assert.equal(envelope.to, 'markdown'); assert.equal(envelope.format, 'pdf');
  assert.deepEqual(envelope.tasks.map((task) => task.type), ['document.convert']);
  assert.equal(typeof envelope.content, 'string'); assert.deepEqual(envelope.outputs, []);
  assert.equal(cloud.state('cli').uploads.length, 1, 'the same bytes are uploaded once across runs');

  // convert -o: Markdown with relative links and its images beside it.
  const out = path.join(temp, 'work dir', 'report.md');
  const written = await json(['convert', pdf, '-o', out, '--json']);
  assert.equal(fs.readFileSync(out, 'utf8'), FIXTURE_MARKDOWN.replace('assets/image.png', 'report.assets/image.png'));
  assert.deepEqual(fs.readFileSync(path.join(temp, 'work dir', 'report.assets', 'image.png')), FIXTURE_PNG);
  assert.deepEqual(written.outputs.map((output) => path.basename(output.file)), ['report.md', 'image.png']);
  assert.equal((await run(['convert', pdf, '-o', out, '--quiet'])).stdout, '');

  // extract: JSON to stdout or to a file with assets; assets alone into a directory.
  assert.deepEqual((await json(['extract', pdf, '--to', 'json', '-o', '-', '--json'])).content, FIXTURE_DOCUMENT);
  assert.deepEqual(JSON.parse((await run(['extract', pdf, '--to', 'json', '-o', '-'])).stdout), FIXTURE_DOCUMENT);
  const assets = await json(['extract', pdf, '--to', 'assets', '-o', path.join(temp, 'images'), '--json']);
  assert.ok(fs.existsSync(path.join(temp, 'images', 'assets', 'image.png')));
  assert.equal(assets.outputs.length, 1);

  // render: frames by page into a directory.
  const frames = await json(['render', pdf, '--to', 'image', '--pages', '1,3', '-o', path.join(temp, 'frames'), '--json']);
  assert.deepEqual(frames.outputs.map((output) => path.basename(output.file)), ['001.png', '003.png']);
  assert.deepEqual(frames.tasks.map((task) => task.type), ['convertor.pdf2image']);
  assert.ok(tasks('cli').every((task) => task.type === 'document.convert' || task.type === 'document.extract' || task.type === 'convertor.pdf2image'));

  // probe: local and free — no credentials, an unreachable API root, and not one request.
  const probeEnv = { ...baseEnv, DECKOPS_API_BASE: cloud.apiBase('probe') };
  const report = await json(['probe', pdf, '--targets', 'page_count', '--json'], { env: probeEnv });
  assert.equal(report.schema_version, 2); assert.equal(report.status, 'ok');
  assert.equal(cloud.state('probe').requests.length, 0, 'probe sent a request');
  await json(['probe', pdf, '--json'], { env: { ...baseEnv, DECKOPS_API_BASE: 'http://127.0.0.1:9/v1' } });

  // Removed 3.x surface fails as a usage error; the error envelope keeps its shape.
  for (const args of [['parse', pdf], [pdf, '--format', 'ir'], [pdf, '--mode', 'source'], [pdf, '--engine', 'cloud'],
    [pdf, '--preflight', 'off'], [pdf, '--allow-upload'], [pdf, '--report', 'r.json'], ['config', 'migrate'], ['render', pdf]]) {
    assert.equal((await run(args, { success: false })).status, 2, args.join(' '));
  }
  assert.equal((await run(['--timeout', '0', pdf], { success: false })).status, 2);
  const collision = await json(['convert', pdf, '--output', pdf, '--json'], { success: false });
  assert.deepEqual(Object.keys(collision), ['ok', 'op', 'error']); assert.equal(collision.error.code, 'usage_error');
  const unsupported = await json(['render', pdf, '--to', 'video', '--json'], { success: false });
  assert.equal(unsupported.error.code, 'unsupported'); assert.match(unsupported.error.hint, /\.pdf can render to image/);

  // A closed stdout ends any verb quietly with exit 0, not with an EPIPE stack.
  for (const args of [[pdf], ['convert', pdf, '-o', '-'], ['extract', pdf, '--to', 'json', '-o', '-'],
    ['render', pdf, '--to', 'image', '-o', path.join(temp, 'piped-frames')], ['probe', pdf], ['formats']]) {
    assert.deepEqual(await closed('stdout', args, args[0] === 'probe' ? baseEnv : undefined), { status: 0, stderr: '' }, args.join(' '));
  }
  // A closed stderr loses only the warnings: the content still arrives and a failure keeps its exit code.
  const warned = await closed('stderr', [pdf], cloudEnv('soft-render-error'));
  assert.deepEqual(warned, { status: 0, stdout: FIXTURE_MARKDOWN.replace('assets/image.png', signed('soft-render-error')) });
  assert.deepEqual(await closed('stderr', ['render', pdf]), { status: 2, stdout: '' });

  const formats = await json(['formats', '--json']);
  assert.deepEqual(formats.map((row) => `${row.verb}:${row.to}`), ['probe:report', 'render:image', 'render:video', 'convert:markdown', 'extract:json', 'extract:assets']);
  console.log('Built CLI content contract passed: default entry, convert/extract/render outputs, upload reuse, offline probe, removed 3.x surface, closed pipes, formats.');
} finally {
  await cloud.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
