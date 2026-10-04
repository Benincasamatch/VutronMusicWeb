import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    admin: 'src/admin.ts'
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: true,
  // tsup's removeNodeProtocol default rewrites `node:sqlite` to `sqlite`, which breaks the
  // built dist at runtime (ERR_MODULE_NOT_FOUND) and takes npm start / systemd / npm run admin down with it.
  removeNodeProtocol: false,
  noExternal: ['@lan/shared']
})
