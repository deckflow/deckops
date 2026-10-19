import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The SDK moves bytes and never interprets documents. These gates keep document parsing,
 * local engines and Node-only code out of the layers that must stay portable.
 */
const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const sdkPackages = /@(?:deckops|decktools)\/sdk|@deckflow\/(?:cloud-client|decktools-sdk)/;
const parsingPackages = /deckprobe|pdf-lite-parse|pdfjs|^parse5$|^saxes$|^canvas$|@napi-rs\/canvas/;

assert.equal(manifest.name, '@deckflow/deckops');
assert.deepEqual(manifest.bin, { deckops: 'dist/cli.js' }, 'Only the product CLI may be exported');
for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
    assert.ok(!['decktools', 'deckops'].includes(name), 'The product must not depend on either tools CLI');
    assert.doesNotMatch(`${name} ${spec}`, sdkPackages, `Forbidden SDK dependency in ${section}: ${name}`);
    assert.doesNotMatch(name, parsingPackages, `Document parsing dependency in ${section}: ${name}`);
    if (section !== 'devDependencies') assert.notEqual(name, 'fflate', `fflate is a runtime dependency in ${section}`);
    assert.doesNotMatch(spec, /^(?:file:|link:|workspace:)|deckflow\/(?:decktools|deckops)(?:\W|$)/,
      'Product builds must not depend on a sibling checkout or tool repository');
  }
}
assert.doesNotMatch(fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8'), sdkPackages);

for (const directory of ['local', 'engine', 'quality', 'ir', 'views']) {
  assert.ok(!fs.existsSync(path.join(root, 'src', directory)), `src/${directory}/ must not exist: the client does not interpret documents`);
}

const importOf = (specifier) => new RegExp(`(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*|import\\s+)['"]${specifier}`);
const sourceFiles = (directory) => fs.readdirSync(path.join(root, directory), { recursive: true })
  .filter((relative) => /\.(?:ts|js|mjs)$/.test(relative))
  .map((relative) => ({ name: `${directory}/${relative}`, content: fs.readFileSync(path.join(root, directory, relative), 'utf8') }));

for (const { name, content } of sourceFiles('src')) {
  assert.doesNotMatch(content, importOf('(?:node:)?worker_threads'), `${name} imports worker_threads`);
  if (/^src\/(?:client|cloud|shared|errors)\//.test(name)) assert.doesNotMatch(content, importOf('node:'), `${name} imports a node: module`);
}
for (const { name, content } of [...sourceFiles('src'), ...sourceFiles('dist')]) {
  assert.doesNotMatch(content, importOf('(?:@(?:deckops|decktools)\\/sdk|@deckflow\\/(?:cloud-client|decktools-sdk))'), `Forbidden SDK import in ${name}`);
}
const wasm = fs.readdirSync(path.join(root, 'dist'), { recursive: true }).filter((relative) => relative.endsWith('.wasm'));
assert.deepEqual(wasm, [], 'dist/ must not ship WebAssembly');

console.log('Boundaries: dependencies, source layers, worker/node imports and dist passed.');
