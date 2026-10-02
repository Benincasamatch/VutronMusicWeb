/**
 * Web 版前端构建/开发配置：以仓库根为 cwd，直接复用 src/renderer 下既有渲染层源码。
 * 与桌面版 vite.config.ts 的差异：不含任何 Electron 插件，dev server 端口与产物目录独立。
 */
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync, renameSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import Vue from '@vitejs/plugin-vue'
import VueJsx from '@vitejs/plugin-vue-jsx'
import { createSvgIconsPlugin } from 'vite-plugin-svg-icons'

const configDir = dirname(fileURLToPath(import.meta.url))
/** 仓库根目录（web/ 的上一级） */
const repoRoot = resolve(configDir, '..')
const rendererDir = resolve(repoRoot, 'src/renderer')
const publicDir = resolve(repoRoot, 'src/public')
const outDir = resolve(configDir, 'dist/client')

/**
 * Vite 按入口文件名产出 HTML（index.web.html），而服务端固定托管 web/dist/client/index.html，
 * 故构建结束后改名（dev 模式由 index.web.html 直接提供页面，不受影响）。
 */
const renameWebIndexHtml: Plugin = {
  name: 'vw-rename-web-index-html',
  apply: 'build',
  enforce: 'post',
  closeBundle() {
    const from = resolve(outDir, 'index.web.html')
    if (!existsSync(from)) return
    renameSync(from, resolve(outDir, 'index.html'))
  }
}

/**
 * dev server 默认把 root/index.html（桌面版入口）当作首页，会把 shim 绕过去，
 * 这里把 / 与 /index.html 重写到 index.web.html，保证 dev 与构建产物入口一致。
 */
const serveWebIndexInDev: Plugin = {
  name: 'vw-serve-web-index-in-dev',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const path = req.url?.split('?')[0]
      if (path === '/' || path === '/index.html') req.url = '/index.web.html'
      next()
    })
  }
}

export default defineConfig({
  root: rendererDir,
  publicDir,
  base: './',
  define: {
    __VUE_I18N_FULL_INSTALL__: true,
    __VUE_I18N_LEGACY_API__: false,
    __INTLIFY_PROD_DEVTOOLS__: false
  },
  resolve: {
    extensions: ['.mjs', '.js', '.ts', '.vue', '.json', '.scss'],
    alias: {
      '@': resolve(repoRoot, 'src')
    }
  },
  plugins: [
    Vue(),
    createSvgIconsPlugin({
      iconDirs: [resolve(rendererDir, 'assets/icons')],
      symbolId: 'icon-[dir]-[name]'
    }),
    VueJsx(),
    renameWebIndexHtml,
    serveWebIndexInDev
  ],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(rendererDir, 'index.web.html')
      }
    }
  },
  server: {
    // 生产由 web/server 托管构建产物；dev 只跑前端，接口代理到 web/server（默认 41831）
    port: 41832,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:41831',
        changeOrigin: true
      },
      '/ws': {
        target: 'http://127.0.0.1:41831',
        ws: true
      }
    }
  }
})
