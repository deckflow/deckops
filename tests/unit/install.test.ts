import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installSkill } from '../../src/cli/commands/install.js';

const temporary: string[] = [];
const skillSource = path.resolve(import.meta.dirname, '../../skills/deckops');

function tmp(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'deckops-skill-install-'));
  temporary.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('agent skill installation', () => {
  it('dry-runs to the vendor-neutral project path without writing', async () => {
    const cwd = tmp();
    const receipt = await installSkill({ cwd, home: tmp(), skillSource, dryRun: true });

    expect(receipt).toMatchObject({ ok: true, op: 'install', scope: 'project', dryRun: true });
    expect(receipt.targets).toHaveLength(1);
    expect(receipt.targets[0]?.directory).toBe(path.join(cwd, '.agents/skills/deckops'));
    expect(receipt.targets[0]?.agents).toEqual(['agents']);
    expect(receipt.targets[0]?.files.some((file) => file.path === 'SKILL.md' && file.action === 'created')).toBe(true);
    expect(fs.existsSync(path.join(cwd, '.agents'))).toBe(false);
  });

  it('installs all resources, records hashes, and reports an unchanged reinstall', async () => {
    const cwd = tmp();
    const first = await installSkill({ cwd, home: tmp(), skillSource, dir: 'agent-skills' });
    const destination = path.join(cwd, 'agent-skills/deckops');

    expect(first.scope).toBe('explicit');
    expect(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8')).toContain('deckops-skill-format: "1"');
    expect(fs.existsSync(path.join(destination, 'references/artifact.md'))).toBe(true);
    const state = JSON.parse(fs.readFileSync(path.join(destination, '.deckops-skill.json'), 'utf8'));
    expect(state).toMatchObject({ schemaVersion: 1, name: 'deckops' });
    expect(state.files['SKILL.md']).toMatch(/^[a-f0-9]{64}$/);

    const second = await installSkill({ cwd, home: tmp(), skillSource, dir: 'agent-skills' });
    expect(second.targets[0]?.files.every((file) => file.action === 'unchanged')).toBe(true);
  });

  it('protects modified managed files and preserves local additions on forced replacement', async () => {
    const cwd = tmp();
    const request = { cwd, home: tmp(), skillSource, dir: 'agent-skills' } as const;
    await installSkill(request);
    const destination = path.join(cwd, 'agent-skills/deckops');
    fs.appendFileSync(path.join(destination, 'SKILL.md'), '\nlocal edit\n');
    fs.writeFileSync(path.join(destination, 'notes.md'), 'keep me');
    fs.writeFileSync(path.join(destination, '.local-note'), 'keep hidden too');

    await expect(installSkill(request)).rejects.toMatchObject({ code: 'input_error' });
    await installSkill({ ...request, force: true });
    expect(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8')).not.toContain('local edit');
    expect(fs.readFileSync(path.join(destination, 'notes.md'), 'utf8')).toBe('keep me');
    expect(fs.readFileSync(path.join(destination, '.local-note'), 'utf8')).toBe('keep hidden too');
  });

  it('refuses a foreign same-name skill unless force is explicit', async () => {
    const cwd = tmp();
    const destination = path.join(cwd, 'agent-skills/deckops');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'SKILL.md'), '---\nname: deckops\n---\nlocal skill\n');

    const request = { cwd, home: tmp(), skillSource, dir: 'agent-skills' } as const;
    await expect(installSkill(request)).rejects.toMatchObject({ code: 'input_error' });
    await installSkill({ ...request, force: true });
    expect(fs.readFileSync(path.join(destination, 'SKILL.md'), 'utf8')).toContain('deckops-skill-format: "1"');
  });

  it('detects present agent markers and deduplicates their shared destination', async () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, '.agents'));
    fs.mkdirSync(path.join(cwd, '.claude'));
    const receipt = await installSkill({ cwd, home: tmp(), skillSource, dryRun: true });

    expect(receipt.targets.map((target) => path.relative(cwd, target.directory))).toEqual([
      '.agents/skills/deckops',
      '.claude/skills/deckops',
    ]);
    expect(receipt.targets[0]?.agents).toEqual(['codex', 'agents']);
    expect(receipt.targets[1]?.agents).toEqual(['claude']);
  });

  it('rejects ambiguous destination selectors', async () => {
    const cwd = tmp();
    await expect(installSkill({ cwd, home: tmp(), skillSource, dir: 'x', agents: ['codex'] }))
      .rejects.toMatchObject({ code: 'usage_error' });
    await expect(installSkill({ cwd, home: tmp(), skillSource, agents: ['auto', 'claude'] }))
      .rejects.toMatchObject({ code: 'usage_error' });
  });
});
