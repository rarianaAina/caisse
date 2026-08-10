import { defineConfig } from 'tsup';

// Double format : ESM pour Vite (desktop), CJS pour NestJS (api).
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
