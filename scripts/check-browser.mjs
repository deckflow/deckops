import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

// Bundle the *public package export*, not an internal source path. No aliases,
// externals, polyfills, Node types, or browser globals may hide a broken build.
const result = await build({
  stdin: {
    contents: 'export * from "@deckflow/deckops/browser";',
    resolveDir: process.cwd(),
    sourcefile: 'consumer.js',
  },
  bundle: true,
  platform: 'browser',
  // The published browser contract is native ESM.
  format: 'esm',
  write: false,
  metafile: true,
  minify: true,
});
for (const output of Object.values(result.metafile.outputs)) {
  assert.deepEqual(output.imports, [], 'Browser consumer must have no external runtime dependencies.');
}

const code = result.outputFiles[0].text;
const bundled = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
assert.equal(typeof bundled.createClient, 'function');
assert.equal(typeof bundled.BrowserParsedDocument, 'function');
assert.equal('resolveCredentials' in bundled, false);
assert.equal('openArtifact' in bundled, false);

const declaration = await fs.readFile(new URL('../dist/browser/index.d.ts', import.meta.url), 'utf8');
assert.doesNotMatch(declaration, /(?:from\s*|import\s*\()['"](?:node:|@deckops\/sdk)/);
assert.doesNotMatch(declaration, /\b(?:Buffer|NodeJS)\b/);
console.log(`Browser export: ESM bundle/import OK, standalone types OK (${gzipSync(code).byteLength} bytes gzip).`);
