import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The SDK moves bytes and never interprets documents. These gates keep document parsing,
 * local engines and Node-only code out of the layers that must stay portable.
 */
const root = path.resolve(import.meta.dirname, '..');
if (!fs.existsSync(path.join(root, 'dist'))) {
  console.error('check-boundaries: dist/ is missing; run pnpm build first.');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const sdkPackages = /@(?:deckops|decktools)\/sdk|@deckflow\/(?:cloud-client|decktools-sdk)/;
const parsingPackages = /deckprobe|pdf-lite-parse|pdfjs|^parse5$|^saxes$|^canvas$|@napi-rs\/canvas/;
/** The local probe engine: optional, and loaded only by src/ops/probe.ts. */
const PROBE_ENGINE = '@deckflow/deckprobe';

assert.equal(manifest.name, '@deckflow/deckops');
assert.deepEqual(manifest.bin, { deckops: 'dist/cli.js' }, 'Only the product CLI may be exported');
for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const [name, spec] of Object.entries(manifest[section] ?? {})) {
    assert.ok(!['decktools', 'deckops'].includes(name), 'The product must not depend on either tools CLI');
    assert.doesNotMatch(`${name} ${spec}`, sdkPackages, `Forbidden SDK dependency in ${section}: ${name}`);
    if (name === PROBE_ENGINE) assert.equal(section, 'optionalDependencies', `${PROBE_ENGINE} must stay an optional dependency`);
    else assert.doesNotMatch(name, parsingPackages, `Document parsing dependency in ${section}: ${name}`);
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
  if (/^src\/(?:client|cloud|shared|errors|ops)\//.test(name)) assert.doesNotMatch(content, importOf('node:'), `${name} imports a node: module`);
  if (name !== 'src/ops/probe.ts') assert.doesNotMatch(content, importOf(PROBE_ENGINE), `${name} imports ${PROBE_ENGINE}; only src/ops/probe.ts may`);
}

// Probe is local and free: its module cannot reach the cloud, credentials or configuration.
const probe = fs.readFileSync(path.join(root, 'src/ops/probe.ts'), 'utf8');
for (const layer of ['cloud', 'auth', 'config', 'client', 'node']) {
  assert.doesNotMatch(probe, importOf(`\\.\\.?/(?:\\.\\./)*${layer}/`), `src/ops/probe.ts imports ${layer}/`);
}

// The route table is data: rows of plain objects naming mapping functions, nothing that runs.
const routes = fs.readFileSync(path.join(root, 'src/ops/routes.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const routeImports = [...routes.matchAll(/^import\s+(type\s+)?.*?from\s+['"]([^'"]+)['"]/gm)];
for (const [, type, source] of routeImports) {
  assert.ok(source === './params.js' || (type && source === './types.js'), `src/ops/routes.ts may import only ./params.js and types: ${source}`);
}
for (const [label, pattern] of [
  ['functions', /=>|\bfunction\b/], ['classes', /\bclass\b/], ['control flow', /\b(?:if|for|while|switch|try)\s*[({]/],
  ['awaits', /\bawait\b/], ['constructors', /\bnew\s/], ['network or filesystem', /\b(?:fetch|require|process|globalThis)\b/],
]) assert.doesNotMatch(routes, pattern, `src/ops/routes.ts must be declarative; found ${label}`);
for (const { name, content } of [...sourceFiles('src'), ...sourceFiles('dist')]) {
  assert.doesNotMatch(content, importOf('(?:@(?:deckops|decktools)\\/sdk|@deckflow\\/(?:cloud-client|decktools-sdk))'), `Forbidden SDK import in ${name}`);
}
const wasm = fs.readdirSync(path.join(root, 'dist'), { recursive: true }).filter((relative) => relative.endsWith('.wasm'));
assert.deepEqual(wasm, [], 'dist/ must not ship WebAssembly');
assert.doesNotMatch(fs.readFileSync(path.join(root, 'dist/browser/index.js'), 'utf8'), /deckprobe/, 'The browser entry must not carry the probe engine');

console.log('Boundaries: dependencies, source layers, worker/node imports, probe isolation, declarative routes and dist passed.');
