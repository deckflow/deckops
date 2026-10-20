import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Release budget: tarball ≤ 1 MiB; `--omit=optional` production install ≤ 12 MiB with no native
 * binaries and no install scripts; `formats --json` cold start P95 ≤ 300 ms. The default install
 * adds the optional probe engine (WebAssembly plus one native platform package): its size is
 * recorded and `deckops probe` must work from it.
 */
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
  const install = (name, flags) => {
    const installDir = path.join(workspace, name); fs.mkdirSync(installDir);
    fs.writeFileSync(path.join(installDir, 'package.json'), '{"private":true}');
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-online', ...flags, tarball], { cwd: installDir, stdio: 'inherit' });
    const modules = path.join(installDir, 'node_modules');
    const installScripts = filesUnder(modules).filter((file) => file.endsWith('package.json')).flatMap((file) => {
      const scripts = JSON.parse(fs.readFileSync(file, 'utf8')).scripts ?? {};
      const names = ['preinstall', 'install', 'postinstall'].filter((script) => typeof scripts[script] === 'string');
      return names.map((script) => `${path.relative(installDir, file)}: ${script}`);
    });
    if (installScripts.length) throw new Error(`Production install declares install scripts:\n${installScripts.join('\n')}`);
    return { modules, bytes: sizeOf(modules), cli: path.join(modules, '.bin', 'deckops') };
  };

  const strict = install('strict', ['--omit=dev', '--omit=optional']);
  if (strict.bytes > 12 * MiB) throw new Error(`Production install without optional dependencies is ${(strict.bytes / MiB).toFixed(2)} MiB; limit is 12 MiB.`);
  const native = filesUnder(strict.modules).filter((file) => file.endsWith('.node'));
  if (native.length) throw new Error(`Production install contains native binaries:\n${native.join('\n')}`);
  const missing = spawnSync(strict.cli, ['probe', path.join(root, 'package.json'), '--json'], { encoding: 'utf8' });
  if (missing.status !== 3 || JSON.parse(missing.stdout).error?.code !== 'unsupported') {
    throw new Error(`Without optional dependencies, probe must fail as unsupported:\n${missing.stdout}${missing.stderr}`);
  }

  const full = install('default', ['--omit=dev']);
  const report = JSON.parse(execFileSync(full.cli, ['probe', path.join(root, 'tests/generated/test.pdf'), '--targets', 'page_count', '--json'], { encoding: 'utf8' }));
  if (report.schema_version !== 2 || report.status !== 'ok' || report.results['pdf.page_count']?.value !== 1) {
    throw new Error(`probe failed in the default install:\n${JSON.stringify(report)}`);
  }

  const cli = strict.cli;
  const skillsContainer = path.join(workspace, 'agent-skills');
  const skillReceipt = JSON.parse(execFileSync(cli, ['install', '--skills', '--dir', skillsContainer, '--json'], { encoding: 'utf8' }));
  const installedSkill = path.join(skillsContainer, 'deckops');
  if (!skillReceipt.ok || skillReceipt.op !== 'install' || !fs.existsSync(path.join(installedSkill, 'SKILL.md'))) {
    throw new Error('The production package could not install its DeckOps agent skill.');
  }
  for (const relative of ['LICENSE', 'NOTICE', 'references/formats.md', 'references/limits.md', 'references/output.md', 'references/probe.md', 'references/recipes.md']) {
    if (!fs.existsSync(path.join(installedSkill, relative))) throw new Error(`Installed skill is missing ${relative}.`);
  }
  const coldStarts = Array.from({ length: 20 }, () => {
    const started = performance.now(); execFileSync(cli, ['formats', '--json'], { encoding: 'utf8' }); return performance.now() - started;
  }).sort((a, b) => a - b);
  const p95 = coldStarts[Math.ceil(coldStarts.length * 0.95) - 1];
  if (p95 > 300) throw new Error(`formats cold-start P95 is ${p95.toFixed(0)} ms; limit is 300 ms.`);
  process.stdout.write(`tarball ${(item.size / 1024).toFixed(0)} KiB; production install ${(strict.bytes / MiB).toFixed(2)} MiB (--omit=optional), ` +
    `${(full.bytes / MiB).toFixed(2)} MiB with the probe engine; cold-start P95 ${p95.toFixed(0)} ms\n`);
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
