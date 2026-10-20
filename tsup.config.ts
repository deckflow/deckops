import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
  // The optional probe engine (with its WebAssembly) is loaded from node_modules at run time.
  external: ['@deckflow/deckprobe'],
  banner: ({ format }) => (format === 'esm' ? { js: '' } : {}),
});
