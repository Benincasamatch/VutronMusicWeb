/**
 * Web 版启动模块：渲染层挂载后由 loginGate 与 webBridge 懒加载。
 *
 * 之所以集中在一个模块里再转发，是因为 webBridge 只能懒加载一个入口（避免 web/tsconfig
 * 通过静态 import 把渲染层 store 拉进类型检查），而这里需要有镜像与音源预置两组能力。
 */
import { startServerMirror, onLocalTrackEnded, requestServerNext } from './serverMirror.ts'
import { primeSources } from './localSource.ts'

export { onLocalTrackEnded, requestServerNext, primeSources }

/** 渲染层挂载后调用：启动服务器状态镜像 */
export function bootWeb(): void {
  startServerMirror()
}
