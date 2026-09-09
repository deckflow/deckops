import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const skill = path.join(root, 'skills/deckops');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const expected = [
  'LICENSE',
  'NOTICE',
  'SKILL.md',
  'references/artifact.md',
  'references/formats.md',
  'references/limits.md',
  'references/output.md',
  'references/recipes.md',
];

const found = filesUnder(skill);
if (JSON.stringify(found) !== JSON.stringify(expected)) {
  throw new Error(`DeckOps skill resources differ from the expected public surface:\n${found.join('\n')}`);
}

const manifest = fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
if (!manifest.startsWith('---\n') || !manifest.includes('\n---\n')) throw new Error('SKILL.md has invalid frontmatter fences.');
const frontmatter = manifest.slice(4, manifest.indexOf('\n---\n'));
const keys = frontmatter.split('\n')
  .filter((line) => line && !/^\s/.test(line))
  .map((line) => line.split(':', 1)[0]);
const allowed = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
for (const key of keys) if (!allowed.has(key)) throw new Error(`Unsupported SKILL.md frontmatter key: ${key}`);
for (const required of ['name', 'description']) if (!keys.includes(required)) throw new Error(`SKILL.md is missing ${required}.`);
if (!frontmatter.includes('name: deckops')) throw new Error('SKILL.md must declare name: deckops.');
if (!frontmatter.includes('deckops-skill-format: "1"')) throw new Error('SKILL.md lacks its install ownership marker.');
if (!frontmatter.includes(`tested-cli-version: "${pkg.version}"`)) throw new Error('Skill and CLI tested versions have drifted.');

const combined = expected.filter((file) => file.endsWith('.md')).map((file) => fs.readFileSync(path.join(skill, file), 'utf8')).join('\n');
for (const forbidden of ['/Volumes/workspace/', '/Users/fei/', 'TODO', 'PLACEHOLDER']) {
  if (combined.includes(forbidden)) throw new Error(`Skill resources contain a development-only value: ${forbidden}`);
}

if (!combined.includes(`@deckflow/deckops@${pkg.version}`)) throw new Error('Skill npx examples and package version have drifted.');
if (!pkg.files?.includes('skills')) throw new Error('package.json files must include skills.');
const license = fs.readFileSync(path.join(skill, 'LICENSE'), 'utf8');
if (!license.includes('GNU AFFERO GENERAL PUBLIC LICENSE')) throw new Error('Skill LICENSE is not the AGPL-3.0 text.');

process.stdout.write(`DeckOps skill: ${found.length} files, ${Buffer.byteLength(combined)} Markdown bytes\n`);

function filesUnder(directory, prefix = '') {
  const result = [];
  for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const relative = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Skill resources cannot contain symlinks: ${relative}`);
    if (entry.isDirectory()) result.push(...filesUnder(directory, relative));
    else result.push(relative);
  }
  return result.sort();
}
