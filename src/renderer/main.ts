import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import i18n from './plugins/i18n'
import 'virtual:svg-icons-register'
import './assets/css/global.scss'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import DOMPurify from 'dompurify'
import vue3lottie from 'vue3-lottie'

// Add API key defined in contextBridge to window object type
declare global {
  // eslint-disable-next-line no-unused-vars
  interface Window {
    mainApi?: {
      send: (channel: string, ...data: any[]) => void
      on: (channel: string, func: (...data: any[]) => void) => void
      once: (channel: string, func: (...data: any[]) => void) => void
      off: (channel: string, func: (...data: any[]) => void) => void
      invoke: (channel: string, ...data: any[]) => Promise<any>
    }
    env?: {
      isElectron: boolean
      isEnableTitlebar: boolean
      isLinux: boolean
      isMac: boolean
      isWindows: boolean
      isDev: boolean
      /** Web 版（浏览器 UI + 服务端播放）为 true；桌面版为 undefined */
      isWeb?: boolean
    }
    vutronmusic?: {
      progress: number
      playing: boolean
      volume: number
      currentTrack: Record<string, any>
      isLiked: boolean
      repeatMode: string
      lyric: { lrc: string; tlyric: string; romalrc: string }
    }
    /** Web 版登录态桥接：仅由 src/renderer/web/auth.ts 安装，桌面版为 undefined */
    vwAuth?: {
      logout: () => Promise<void>
    }
    /** Web 版桥接：仅由 src/renderer/web 安装，桌面版为 undefined */
    vwWeb?: {
      isWeb: true
      localSourceReady: () => Promise<boolean>
      primeSources?: () => Promise<void>
      /** true 表示曲目推进由服务器掌握，浏览器不得自行切歌 */
      serverDrivenPlayback?: boolean
      /** 浏览器自然播完时回调：由服务器决定下一首 */
      onLocalTrackEnded?: () => void
      /** 本地媒体连续失败时请求服务器切歌 */
      requestServerNext?: () => void
    }
    LottieAnimation: (typeof import('vue3-lottie'))['Vue3Lottie']
  }
}

const app = createApp(App)

app.directive('focus', {
  mounted(el) {
    el.focus()
  }
})
app.directive('same-html', (el, binding) => {
  el.innerHTML = DOMPurify.sanitize(binding.value)
})

const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)

app
  // .use(vuetify)
  .use(vue3lottie)
  .use(i18n)
  .use(router)
  .use(pinia)

app.mount('#app')
