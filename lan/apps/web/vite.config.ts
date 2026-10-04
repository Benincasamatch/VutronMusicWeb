import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: 'localhost',
    port: 5174,
    strictPort: true,
    allowedHosts: ['localhost'],
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:41840',
        changeOrigin: false,
        ws: true
      }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false
  }
})
