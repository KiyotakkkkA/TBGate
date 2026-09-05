import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  splitting: false,
  // Workspace sources are bundled; native/heavy runtime deps stay external.
  noExternal: ['@tg-gateway/shared'],
  external: ['@libsql/client', '@node-rs/argon2'],
});
