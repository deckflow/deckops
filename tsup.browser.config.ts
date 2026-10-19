import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/browser/index.ts' },
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
  sourcemap: true,
  clean: true,
});
