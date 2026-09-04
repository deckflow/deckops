import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/browser/index.ts', 'probe-worker': 'src/browser/probe-worker.ts' },
  outDir: 'dist/browser',
  tsconfig: 'tsconfig.browser.json',
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  // Ship the fixed SDK with this entry. Consumers do not need our pnpm patch,
  // Node polyfills, aliases, or a separately published upstream SDK version.
  noExternal: [/.*/],
  bundle: true,
  splitting: false,
  dts: { entry: { index: 'src/browser/index.ts' }, resolve: ['@deckops/sdk', '@deckops/sdk/browser'] },
  // Runs after every watch rebuild too, so dev:browser cannot lose the lazy WASM asset after a clean.
  onSuccess: 'node scripts/copy-deckprobe-wasm.mjs',
  sourcemap: true,
  clean: true,
});
