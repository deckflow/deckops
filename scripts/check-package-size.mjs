import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MiB = 1024 * 1024;
const root = path.resolve(import.meta.dirname, '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deckparse-package-check-'));
let tarball;

try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
  const item = packed[0];
  if (!item?.filename) throw new Error('npm pack returned no tarball.');
  if (item.size > 8 * MiB) throw new Error(`npm tarball is ${(item.size / MiB).toFixed(2)} MiB; limit is 8 MiB.`);
  tarball = path.join(root, item.filename);
  const strictDir = path.join(workspace, 'strict'); fs.mkdirSync(strictDir);
  fs.writeFileSync(path.join(strictDir, 'package.json'), '{"private":true}');
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--omit=dev', '--omit=optional', tarball], { cwd: strictDir, stdio: 'inherit' });
  const installedBytes = sizeOf(path.join(strictDir, 'node_modules'));
  if (installedBytes > 55 * MiB) throw new Error(`Strict production install is ${(installedBytes / MiB).toFixed(2)} MiB; limit is 55 MiB.`);
  const native = filesUnder(path.join(strictDir, 'node_modules')).filter((file) => file.endsWith('.node'));
  if (native.length) throw new Error(`Strict production install contains native binaries:\n${native.join('\n')}`);
  const installScripts = filesUnder(path.join(strictDir, 'node_modules')).filter((file) => file.endsWith('package.json')).flatMap((file) => {
    const scripts = JSON.parse(fs.readFileSync(file, 'utf8')).scripts ?? {};
    const names = ['preinstall', 'install', 'postinstall'].filter((name) => typeof scripts[name] === 'string');
    return names.map((name) => `${path.relative(strictDir, file)}: ${name}`);
  });
  if (installScripts.length) throw new Error(`Strict production install declares install scripts:\n${installScripts.join('\n')}`);
  const cli = path.join(strictDir, 'node_modules', '.bin', 'deckparse');
  const coldStarts = Array.from({ length: 20 }, () => {
    const started = performance.now(); execFileSync(cli, ['formats', '--json'], { encoding: 'utf8' }); return performance.now() - started;
  }).sort((a, b) => a - b);
  const p95 = coldStarts[Math.ceil(coldStarts.length * 0.95) - 1];
  if (p95 > 500) throw new Error(`formats cold-start P95 is ${p95.toFixed(0)} ms; limit is 500 ms.`);
  const smokeArtifact = path.join(workspace, 'pdf-smoke');
  const measured = await runMeasured(cli, ['parse', path.join(root, 'tests/test-data/test.pdf'), '--engine', 'local', '--preflight', 'off', '--output', smokeArtifact, '--json']);
  const smoke = JSON.parse(measured.stdout);
  if (!smoke.ok || smoke.format !== 'pdf' || smoke.engine !== 'local') throw new Error('Strict production install failed the local PDF smoke test.');
  if (measured.maxRssBytes > 256 * MiB) throw new Error(`Local PDF smoke reached ${(measured.maxRssBytes / MiB).toFixed(2)} MiB RSS; limit is 256 MiB.`);
  const large = filesUnder(path.join(strictDir, 'node_modules')).filter((file) => fs.statSync(file).size > MiB);
  const defaultDir = path.join(workspace, 'default'); fs.mkdirSync(defaultDir);
  fs.writeFileSync(path.join(defaultDir, 'package.json'), '{"private":true}');
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--omit=dev', tarball], { cwd: defaultDir, stdio: 'inherit' });
  const defaultBytes = sizeOf(path.join(defaultDir, 'node_modules'));
  const defaultNative = filesUnder(path.join(defaultDir, 'node_modules')).filter((file) => file.endsWith('.node')).length;
  process.stdout.write(`tarball ${(item.size / MiB).toFixed(2)} MiB; strict install ${(installedBytes / MiB).toFixed(2)} MiB; default install ${(defaultBytes / MiB).toFixed(2)} MiB (${defaultNative} native binaries); cold-start P95 ${p95.toFixed(0)} ms; PDF RSS ${(measured.maxRssBytes / MiB).toFixed(2)} MiB; files >1 MiB ${large.length}\n`);
} finally {
  if (tarball) fs.rmSync(tarball, { force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}

function sizeOf(target) { return filesUnder(target).reduce((sum, file) => sum + fs.statSync(file).size, 0); }
function filesUnder(target) {
  if (!fs.existsSync(target)) return [];
  const result = []; const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(file); else result.push(file);
    }
  }; visit(target); return result;
}

async function runMeasured(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let maxRssBytes = 0;
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
  const sample = () => {
    try {
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
      const descendants = new Set([child.pid]); let changed = true;
      while (changed) { changed = false; for (const [pid, ppid] of rows) if (descendants.has(ppid) && !descendants.has(pid)) { descendants.add(pid); changed = true; } }
      maxRssBytes = Math.max(maxRssBytes, rows.filter(([pid]) => descendants.has(pid)).reduce((sum, row) => sum + (row[2] ?? 0) * 1024, 0));
    } catch { /* RSS sampling is best effort on platforms without POSIX ps. */ }
  };
  const timer = setInterval(sample, 20); sample();
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  clearInterval(timer); sample();
  if (code !== 0) throw new Error(`Local PDF smoke failed (${code}): ${stderr}`);
  return { stdout, maxRssBytes };
}
