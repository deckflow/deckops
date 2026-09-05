import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/browser/index.ts', 'probe-worker': 'src/browser/probe-worker.ts' },
  outDir: 'dist/browser',
  tsconfig: 'tsconfig.browser.json',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  // Self-contained browser entry: no Node polyfills or external runtime imports.
  noExternal: [/.*/],
  bundle: true,
  splitting: false,
  dts: { entry: { index: 'src/browser/index.ts' } },
  // Runs after every watch rebuild too, so dev:browser cannot lose the lazy WASM asset after a clean.
  onSuccess: 'node scripts/copy-deckprobe-wasm.mjs',
  sourcemap: true,
  clean: true,
});
