import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  minify: false,
  shims: true,
  splitting: false,
  bundle: true,
  outDir: 'dist',
  target: 'node18',
  platform: 'node',
  sourcemap: true,
  treeshake: true,
});
