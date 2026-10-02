/**
 * HTTP 基座：所有 shim 请求（IPC 映射、登录态、订阅）共用。
 *
 * 约定：
 * - 一律 same-origin（Vite dev 由 server.proxy 转发，生产由服务端直接托管），credentials: 'include' 带上会话 Cookie。
 * - 401 统一转成 UnauthorizedError（message 含 'UNAUTHORIZED'，与桌面版主进程错误文案保持一致的识别方式），
 *   并派发 window 事件 'vw:unauthorized'，保证“未登录”不会被当成有效数据。
 * - 响应体内的桌面版绝对资源地址（桌面 Vite 41830 / 桌面本地接口 40001）统一改写为同源相对地址，
 *   改写集中在此处，渲染层拿到的 picUrl / 封面地址直接可用。
 */

export class UnauthorizedError extends Error {
  readonly status = 401
  readonly code = 'UNAUTHORIZED'

  constructor(message = 'UNAUTHORIZED: 需要登录') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class ApiRequestError extends Error {
  readonly status: number
  readonly code: string

  constructor(message: string, status: number, code: string) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

/** 桌面版会把这些绝对前缀写进插件返回的数据里，浏览器版统一折叠成同源相对地址 */
const REWRITE_PREFIXES = [
  'http://localhost:41830',
  'http://127.0.0.1:41830',
  'http://localhost:40001',
  'http://127.0.0.1:40001'
] as const

/** 不透明字段：插件私有上下文原样透传，绝不改写其内部字符串 */
const OPAQUE_KEYS: Record<string, true> = { sourceContext: true, rawCtx: true }

export function rewriteAssetUrl(value: string): string {
  for (const prefix of REWRITE_PREFIXES) {
    if (value.startsWith(prefix)) return value.slice(prefix.length) || '/'
  }
  return value
}

/** 递归改写响应中的资源地址（数组/对象/字符串），sourceContext 等不透明字段保持原样 */
export function rewriteAssets<T>(value: T): T {
  return rewriteDeep(value) as T
}

function rewriteDeep(value: unknown): unknown {
  if (typeof value === 'string') return rewriteAssetUrl(value)
  if (Array.isArray(value)) return value.map((item) => rewriteDeep(item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = OPAQUE_KEYS[key] ? item : rewriteDeep(item)
    }
    return out
  }
  return value
}

export type QueryValue = string | number | boolean | null | undefined

export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, QueryValue>
  body?: unknown
  signal?: AbortSignal
  /** true 时 401 返回 null 而不是抛错（用于“探测登录态”这类可预期未登录的调用） */
  allowUnauthorized?: boolean
}

export function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    params.append(key, String(value))
  }
  const qs = params.toString()
  if (!qs) return path
  return path.includes('?') ? `${path}&${qs}` : `${path}?${qs}`
}

function notifyUnauthorized(): void {
  try {
    window.dispatchEvent(new CustomEvent('vw:unauthorized'))
  } catch {
    /* 非浏览器环境下忽略 */
  }
}

function parseBody(text: string, contentType: string | null): unknown {
  if (!text) return null
  if (contentType && contentType.includes('application/json')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function errorCodeOf(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>
    if (typeof rec.error === 'string' && rec.error) return rec.error
    if (typeof rec.code === 'string' && rec.code) return rec.code
  }
  return fallback
}

function errorMessageOf(data: unknown, code: string): string {
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>
    if (typeof rec.message === 'string' && rec.message) return `${code}: ${rec.message}`
  }
  if (typeof data === 'string' && data) return `${code}: ${data}`
  return code
}

export async function apiFetch<T = unknown>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const url = buildUrl(path, options.query)
  const headers: Record<string, string> = { Accept: 'application/json' }
  const init: RequestInit = {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  if (options.signal) init.signal = options.signal

  let res: Response
  try {
    res = await fetch(url, init)
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    throw new ApiRequestError(
      `NETWORK_ERROR: ${(err as Error)?.message ?? '请求失败'}`,
      0,
      'NETWORK_ERROR'
    )
  }

  if (res.status === 401) {
    notifyUnauthorized()
    if (options.allowUnauthorized) return null as T
    throw new UnauthorizedError()
  }

  const text = await res.text()
  const data = parseBody(text, res.headers.get('content-type'))

  if (!res.ok) {
    const code = errorCodeOf(data, `HTTP_${res.status}`)
    throw new ApiRequestError(errorMessageOf(data, code), res.status, code)
  }

  return rewriteAssets(data) as T
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof UnauthorizedError || String((error as Error)?.message ?? '').includes('UNAUTHORIZED')
}

/** 非 401 的失败返回兜底值（对齐桌面版主进程“插件失败返回空结果”的行为），401 始终上抛 */
export async function withFallback<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (isUnauthorizedError(err)) throw err
    console.debug('[web] 请求失败，使用兜底值:', (err as Error)?.message ?? err)
    return fallback
  }
}
