import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Release budget: tarball ≤ 1 MiB, clean production install ≤ 12 MiB, `formats --json` cold start P95 ≤ 300 ms. */
const MiB = 1024 * 1024;
const root = path.resolve(import.meta.dirname, '..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'deckops-package-check-'));
let tarball;

try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }));
  const item = packed[0];
  if (!item?.filename) throw new Error('npm pack returned no tarball.');
  if (item.size > MiB) throw new Error(`npm tarball is ${(item.size / MiB).toFixed(2)} MiB; limit is 1 MiB.`);
  tarball = path.join(root, item.filename);
  const installDir = path.join(workspace, 'install'); fs.mkdirSync(installDir);
  fs.writeFileSync(path.join(installDir, 'package.json'), '{"private":true}');
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-online', '--omit=dev', tarball], { cwd: installDir, stdio: 'inherit' });
  const modules = path.join(installDir, 'node_modules');
  const installedBytes = sizeOf(modules);
  if (installedBytes > 12 * MiB) throw new Error(`Production install is ${(installedBytes / MiB).toFixed(2)} MiB; limit is 12 MiB.`);
  const native = filesUnder(modules).filter((file) => file.endsWith('.node'));
  if (native.length) throw new Error(`Production install contains native binaries:\n${native.join('\n')}`);
  const installScripts = filesUnder(modules).filter((file) => file.endsWith('package.json')).flatMap((file) => {
    const scripts = JSON.parse(fs.readFileSync(file, 'utf8')).scripts ?? {};
    const names = ['preinstall', 'install', 'postinstall'].filter((name) => typeof scripts[name] === 'string');
    return names.map((name) => `${path.relative(installDir, file)}: ${name}`);
  });
  if (installScripts.length) throw new Error(`Production install declares install scripts:\n${installScripts.join('\n')}`);
  const cli = path.join(modules, '.bin', 'deckops');
  const skillsContainer = path.join(workspace, 'agent-skills');
  const skillReceipt = JSON.parse(execFileSync(cli, ['install', '--skills', '--dir', skillsContainer, '--json'], { encoding: 'utf8' }));
  const installedSkill = path.join(skillsContainer, 'deckops');
  if (!skillReceipt.ok || skillReceipt.op !== 'install' || !fs.existsSync(path.join(installedSkill, 'SKILL.md'))) {
    throw new Error('The production package could not install its DeckOps agent skill.');
  }
  for (const relative of ['LICENSE', 'NOTICE', 'references/artifact.md', 'references/formats.md', 'references/limits.md', 'references/output.md', 'references/recipes.md']) {
    if (!fs.existsSync(path.join(installedSkill, relative))) throw new Error(`Installed skill is missing ${relative}.`);
  }
  const coldStarts = Array.from({ length: 20 }, () => {
    const started = performance.now(); execFileSync(cli, ['formats', '--json'], { encoding: 'utf8' }); return performance.now() - started;
  }).sort((a, b) => a - b);
  const p95 = coldStarts[Math.ceil(coldStarts.length * 0.95) - 1];
  if (p95 > 300) throw new Error(`formats cold-start P95 is ${p95.toFixed(0)} ms; limit is 300 ms.`);
  process.stdout.write(`tarball ${(item.size / 1024).toFixed(0)} KiB; production install ${(installedBytes / MiB).toFixed(2)} MiB; cold-start P95 ${p95.toFixed(0)} ms\n`);
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
