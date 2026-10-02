/**
 * 浏览器版渲染层入口（src/renderer/index.web.html 加载）。
 *
 * 初始化顺序：
 * 1）装好 window.env / window.mainApi / window.vwAuth 三个 shim；
 * 2）加载全局样式（登录闸门需要主题变量）；
 * 3）由 loginGate 确认会话后，才动态加载既有渲染层入口 ../main.ts 并建立实时通道。
 *
 * 渲染层不能先于会话校验挂载：未登录时它的数据请求会全部 401。
 */
import '../assets/css/global.scss'
import './env.ts'
import './mainApi.ts'
import './auth.ts'
import './webBridge.ts'
import { bootstrapWebApp } from './loginGate.ts'

void bootstrapWebApp()
