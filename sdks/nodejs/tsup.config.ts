import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  minify: false,
  splitting: false,
  bundle: true,
  outDir: 'dist',
  target: 'es2022',
  platform: 'neutral',
  sourcemap: true,
  treeshake: true,
});
