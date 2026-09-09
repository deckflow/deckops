import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeckOpsError } from '../../errors/index.js';
import { VERSION } from '../../version.js';
import { printError } from '../output.js';

export type InstallAgent = 'auto' | 'codex' | 'claude' | 'agents';

export interface RawInstallOptions {
  skills?: boolean;
  agent?: string[];
  global?: boolean;
  dir?: string;
  force?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface SkillInstallRequest {
  cwd: string;
  home: string;
  agents?: InstallAgent[];
  global?: boolean;
  dir?: string;
  force?: boolean;
  dryRun?: boolean;
  skillSource?: string;
}

export interface SkillInstallFile {
  path: string;
  bytes: number;
  sha256: string;
  action: 'created' | 'updated' | 'unchanged';
}

export interface SkillInstallTarget {
  directory: string;
  agents: Exclude<InstallAgent, 'auto'>[];
  files: SkillInstallFile[];
  orphaned: string[];
}

export interface SkillInstallReceipt {
  ok: true;
  op: 'install';
  artifact: 'skills';
  name: 'deckops';
  version: string;
  scope: 'project' | 'global' | 'explicit';
  dryRun: boolean;
  force: boolean;
  targets: SkillInstallTarget[];
}

interface PayloadFile {
  path: string;
  bytes: number;
  sha256: string;
  contents: Buffer;
}

interface ResolvedTarget {
  directory: string;
  agents: Exclude<InstallAgent, 'auto'>[];
}

interface InstalledState {
  schemaVersion: 1;
  name: 'deckops';
  version: string;
  files: Record<string, string>;
}

const SKILL_NAME = 'deckops';
const OWNERSHIP_MARKER = 'deckops-skill-format:';
const STATE_FILE = '.deckops-skill.json';
const AGENT_PATHS: Record<Exclude<InstallAgent, 'auto'>, { project: string; global: string }> = {
  codex: { project: '.agents/skills', global: '.codex/skills' },
  claude: { project: '.claude/skills', global: '.claude/skills' },
  agents: { project: '.agents/skills', global: '.agents/skills' },
};

export async function installSkill(request: SkillInstallRequest): Promise<SkillInstallReceipt> {
  validateRequest(request);
  const source = request.skillSource ?? await resolveSkillSource();
  const payload = await readPayload(source);
  const targets = await resolveTargets(request);
  const inspected: Array<{ target: ResolvedTarget; files: SkillInstallFile[]; orphaned: string[] }> = [];

  // Inspect every destination before writing any of them. A known conflict in
  // one agent directory cannot leave another agent half-upgraded.
  for (const target of targets) {
    inspected.push({ target, ...await inspectTarget(target.directory, payload, Boolean(request.force)) });
  }

  if (!request.dryRun) {
    for (const item of inspected) {
      await materializeTarget(item.target.directory, payload, item.orphaned, Boolean(request.force));
    }
  }

  return {
    ok: true,
    op: 'install',
    artifact: 'skills',
    name: SKILL_NAME,
    version: VERSION,
    scope: request.dir ? 'explicit' : request.global ? 'global' : 'project',
    dryRun: Boolean(request.dryRun),
    force: Boolean(request.force),
    targets: inspected.map(({ target, files, orphaned }) => ({
      directory: target.directory,
      agents: target.agents,
      files,
      orphaned,
    })),
  };
}

export async function runInstallCommand(options: RawInstallOptions): Promise<void> {
  const json = Boolean(options.json);
  try {
    if (!options.skills) {
      throw DeckOpsError.usage('Choose an installable artifact. This release supports `deckops install --skills`.');
    }
    const agents = parseAgents(options.agent ?? []);
    const receipt = await installSkill({
      cwd: process.cwd(),
      home: os.homedir(),
      ...(agents.length ? { agents } : {}),
      ...(options.global ? { global: true } : {}),
      ...(options.dir ? { dir: options.dir } : {}),
      ...(options.force ? { force: true } : {}),
      ...(options.dryRun ? { dryRun: true } : {}),
    });
    if (json) {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
      return;
    }
    for (const target of receipt.targets) {
      const changed = target.files.filter((file) => file.action !== 'unchanged').length;
      const action = receipt.dryRun ? 'would install' : changed === 0 ? 'already current at' : 'installed at';
      process.stdout.write(`${action} ${target.directory}\n`);
      if (target.orphaned.length > 0) {
        process.stdout.write(`  preserved ${target.orphaned.length} local file${target.orphaned.length === 1 ? '' : 's'}\n`);
      }
    }
  } catch (error) {
    const translated = error instanceof DeckOpsError
      ? error
      : DeckOpsError.input(`Could not install the DeckOps skill: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    printError(translated, 'install', { json, quiet: false });
    process.exit(translated.exitCode);
  }
}

function validateRequest(request: SkillInstallRequest): void {
  if (request.dir && request.global) throw DeckOpsError.usage('--dir cannot be combined with --global.');
  if (request.dir && request.agents?.length) {
    throw DeckOpsError.usage('--dir cannot be combined with --agent; it already selects the skills container.');
  }
  const agents = request.agents ?? ['auto'];
  if (agents.includes('auto') && agents.length > 1) {
    throw DeckOpsError.usage('--agent auto cannot be combined with another agent.');
  }
  if (!request.cwd || !path.isAbsolute(request.cwd)) throw DeckOpsError.usage('Install cwd must be an absolute path.');
  if (!request.home || !path.isAbsolute(request.home)) throw DeckOpsError.usage('Install home must be an absolute path.');
}

function parseAgents(values: string[]): InstallAgent[] {
  const allowed = new Set<InstallAgent>(['auto', 'codex', 'claude', 'agents']);
  const parsed: InstallAgent[] = [];
  for (const raw of values) {
    const value = raw.toLowerCase() as InstallAgent;
    if (!allowed.has(value)) {
      throw DeckOpsError.usage(`Unknown agent "${raw}". Choose auto, codex, claude, or agents; use --dir for another host.`);
    }
    if (!parsed.includes(value)) parsed.push(value);
  }
  return parsed;
}

async function resolveTargets(request: SkillInstallRequest): Promise<ResolvedTarget[]> {
  if (request.dir) return [{ directory: path.resolve(request.cwd, request.dir, SKILL_NAME), agents: [] }];
  const global = Boolean(request.global);
  const root = global ? request.home : request.cwd;
  let agents = request.agents ?? ['auto'];
  if (agents.includes('auto')) {
    const supported = Object.keys(AGENT_PATHS) as Array<Exclude<InstallAgent, 'auto'>>;
    const checks = await Promise.all(supported.map(async (agent) => {
      const relative = AGENT_PATHS[agent][global ? 'global' : 'project'];
      return await isDirectory(path.join(root, path.dirname(relative))) ? agent : undefined;
    }));
    agents = checks.filter((agent): agent is Exclude<InstallAgent, 'auto'> => Boolean(agent));
    if (agents.length === 0) agents = ['agents'];
  }

  const grouped = new Map<string, Array<Exclude<InstallAgent, 'auto'>>>();
  for (const agent of agents as Array<Exclude<InstallAgent, 'auto'>>) {
    const relative = AGENT_PATHS[agent][global ? 'global' : 'project'];
    const directory = path.resolve(root, relative, SKILL_NAME);
    const labels = grouped.get(directory) ?? [];
    if (!labels.includes(agent)) labels.push(agent);
    grouped.set(directory, labels);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([directory, labels]) => ({
    directory,
    agents: labels,
  }));
}

async function resolveSkillSource(): Promise<string> {
  // tsup flattens the CLI into dist/cli.js, while tests import this source
  // module directly. Both locations resolve to the same package/repository tree.
  const candidates = [
    fileURLToPath(new URL('../skills/deckops/', import.meta.url)),
    fileURLToPath(new URL('../../../skills/deckops/', import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (await isFile(path.join(candidate, 'SKILL.md'))) return candidate;
  }
  throw DeckOpsError.input('The packaged DeckOps skill resources are missing.', {
    hint: 'Reinstall @deckflow/deckops from a complete package.',
  });
}

async function readPayload(source: string): Promise<PayloadFile[]> {
  if (!await isDirectory(source)) throw DeckOpsError.input(`Skill source is not a directory: ${source}`);
  const relativeFiles: string[] = [];
  await collectFiles(source, '', relativeFiles);
  relativeFiles.sort();
  if (!relativeFiles.includes('SKILL.md')) throw DeckOpsError.input('The packaged DeckOps skill has no SKILL.md.');
  const payload = await Promise.all(relativeFiles.map(async (relative) => {
    const contents = await fs.readFile(path.join(source, relative));
    return { path: relative, contents, bytes: contents.byteLength, sha256: digest(contents) };
  }));
  const manifest = payload.find((file) => file.path === 'SKILL.md')!.contents.toString('utf8');
  if (!manifest.includes(OWNERSHIP_MARKER)) {
    throw DeckOpsError.input(`The packaged DeckOps skill is missing its ${OWNERSHIP_MARKER} ownership marker.`);
  }
  return payload;
}

async function collectFiles(root: string, prefix: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw DeckOpsError.input(`Skill source contains a symbolic link: ${relative}`);
    if (entry.isDirectory()) await collectFiles(root, relative, out);
    else if (entry.isFile()) out.push(relative);
  }
}

async function inspectTarget(directory: string, payload: PayloadFile[], force: boolean): Promise<{ files: SkillInstallFile[]; orphaned: string[] }> {
  const destinationExists = await pathExists(directory);
  if (destinationExists) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw DeckOpsError.input(`${directory} exists but is not a normal directory.`);
    }
    const manifestPath = path.join(directory, 'SKILL.md');
    const manifest = await readText(manifestPath);
    if (!force && (!manifest || !manifest.includes(OWNERSHIP_MARKER))) {
      throw DeckOpsError.input(`${manifestPath} exists and is not owned by DeckOps.`, {
        hint: 'Use another --agent/--dir, or rerun with --force only if replacing it is intended.',
      });
    }
  }

  const previous = destinationExists && !force ? await readInstalledState(path.join(directory, STATE_FILE)) : undefined;
  const expected = new Set(payload.map((file) => file.path));
  const existing = destinationExists ? await existingFiles(directory) : [];
  const orphaned = existing.filter((relative) => relative !== STATE_FILE && !expected.has(relative));
  const files: SkillInstallFile[] = [];

  for (const file of payload) {
    const target = path.join(directory, file.path);
    const current = await readRegularFile(target, force);
    if (!force && current && previous) {
      const recorded = previous.files[file.path];
      const currentHash = digest(current);
      if ((!recorded || recorded !== currentHash) && currentHash !== file.sha256) {
        throw DeckOpsError.input(`${target} was modified after DeckOps installed it.`, {
          hint: 'Preserve the local edits elsewhere, or rerun with --force to replace them.',
        });
      }
    }
    files.push({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      action: !current ? 'created' : current.equals(file.contents) ? 'unchanged' : 'updated',
    });
  }
  return { files, orphaned };
}

async function materializeTarget(directory: string, payload: PayloadFile[], orphaned: string[], force: boolean): Promise<void> {
  const container = path.dirname(directory);
  await fs.mkdir(container, { recursive: true });
  const nonce = randomUUID();
  const stage = path.join(container, `.deckops-install-${nonce}`);
  const backup = path.join(container, `.deckops-backup-${nonce}`);
  await fs.mkdir(stage);
  let movedExisting = false;
  try {
    for (const relative of orphaned) {
      const source = path.join(directory, relative);
      const stat = await fs.lstat(source);
      if (stat.isSymbolicLink()) {
        if (force) continue;
        throw DeckOpsError.input(`${source} is a symbolic link; refusing an unsafe skill upgrade.`);
      }
      if (!stat.isFile()) continue;
      const target = path.join(stage, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
    }
    for (const file of payload) {
      const target = path.join(stage, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.contents);
    }
    const installedState: InstalledState = {
      schemaVersion: 1,
      name: SKILL_NAME,
      version: VERSION,
      files: Object.fromEntries(payload.map((file) => [file.path, file.sha256])),
    };
    await fs.writeFile(path.join(stage, STATE_FILE), `${JSON.stringify(installedState, null, 2)}\n`, 'utf8');

    if (await pathExists(directory)) {
      await fs.rename(directory, backup);
      movedExisting = true;
    }
    await fs.rename(stage, directory);
    if (movedExisting) await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
  } catch (error) {
    if (movedExisting && !await pathExists(directory) && await pathExists(backup)) {
      await fs.rename(backup, directory).catch(() => undefined);
    }
    await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function existingFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (prefix: string): Promise<void> => {
    const entries = await fs.readdir(path.join(directory, prefix), { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(relative);
      else out.push(relative);
    }
  };
  await visit('');
  return out.sort();
}

async function readInstalledState(file: string): Promise<InstalledState | undefined> {
  const text = await readText(file);
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<InstalledState>;
    if (value.schemaVersion !== 1 || value.name !== SKILL_NAME || !value.files || typeof value.files !== 'object') {
      throw new Error('invalid shape');
    }
    return value as InstalledState;
  } catch {
    throw DeckOpsError.input(`${file} is not a valid DeckOps skill installation record.`, {
      hint: 'Preserve the skill directory, then use --force only if replacing its managed files is intended.',
    });
  }
}

async function readRegularFile(file: string, force: boolean): Promise<Buffer | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      if (force) return undefined;
      throw DeckOpsError.input(`${file} exists but is not a normal file.`);
    }
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readText(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function isFile(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function isDirectory(directory: string): Promise<boolean> {
  try { return (await fs.stat(directory)).isDirectory(); } catch { return false; }
}

async function pathExists(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true; } catch { return false; }
}

function digest(contents: Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex');
}
