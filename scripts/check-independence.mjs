import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const forbidden = /@(?:deckops|decktools)\/sdk|@deckflow\/cloud-client/;
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.name, '@deckflow/deckops');
assert.deepEqual(manifest.bin, { deckops: 'dist/cli.js' }, 'Only the new product CLI may be exported');
for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
    assert.ok(!['decktools', 'deckops'].includes(name), 'The product must not depend on either tools CLI');
    assert.doesNotMatch(`${name} ${spec}`, forbidden, `Forbidden product dependency in ${section}`);
    assert.doesNotMatch(spec, /^(?:file:|link:|workspace:)|deckflow\/(?:decktools|deckops)(?:\W|$)/,
      'Product builds must not depend on a sibling checkout or tool repository');
  }
}
assert.doesNotMatch(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'), forbidden);
for (const directory of ['src', 'dist']) {
  for (const relative of fs.readdirSync(path.join(root, directory), { recursive: true })) {
    if (!/\.(?:ts|js|mjs)$/.test(relative)) continue;
    const file = path.join(root, directory, relative);
    const content = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(content, /(?:from\s*|import\s*\(|require\s*\()['"](?:@(?:deckops|decktools)\/sdk|@deckflow\/cloud-client)/,
      `Forbidden runtime or type import in ${directory}/${relative}`);
  }
}
console.log('Product independence: manifest, lockfile, source and built imports passed.');
