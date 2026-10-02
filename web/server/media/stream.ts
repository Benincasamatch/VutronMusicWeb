/**
 * 媒体流输出：把已登记的本地文件或上游 URL 以 HTTP 流的形式返回给浏览器。
 *
 * - 本地文件支持 Range（bytes=start-end / start- / -suffix），返回 206 + Content-Range；
 *   无 Range 返回 200 全量；支持 HEAD；文件缺失返回 404；客户端断开时销毁读流。
 * - 远程来源向已登记 URL 发起请求并透传 Range 与 MediaSource.headers，
 *   原样回写上游状态码与 Content-Range/Content-Type/Content-Length；
 *   上游忽略 Range 时自然回退为 200；客户端断开时 abort 上游请求。
 * - Content-Type 优先取上游响应头，其次按扩展名用 mime-types 推断，最后兜底 octet-stream。
 *
 * 注意：成功路径必须「返回流」而不是在 async handler 内直接 reply.send(stream)。
 * Fastify 的 wrapThenable 在响应头尚未发送时会用 handler 的返回值再 send 一次，
 * 若直接 send 且异步留空，会把响应以 Content-Length: 0 提前结束（流被丢弃）。
 * 断开检测使用 reply.raw 的 close：Fastify 下 req.raw 的 close 会在请求体读完时立即触发。
 */
import fs from 'node:fs'
import { Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import mime from 'mime-types'
import type { MediaRecord } from './tokens.ts'

const DEFAULT_TYPE = 'application/octet-stream'

interface ByteRange {
  start: number
  end: number
}

/**
 * 解析 Range 头。
 * - 无 Range → null
 * - `bytes=0-99` / `bytes=1000-` / `bytes=-500` → { start, end }（闭区间）
 * - 语法错误或不可满足（start >= size、end < start、suffix<=0）→ 'invalid'
 */
function parseRange(header: string | undefined, size: number): ByteRange | 'invalid' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return 'invalid'

  if (rawStart === '') {
    // suffix：最后 N 字节
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0 || size === 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= size) return 'invalid'
  const end = rawEnd === '' ? size - 1 : Number(rawEnd)
  if (!Number.isFinite(end) || end < start) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

/** 按扩展名推断 Content-Type；URL 需去除 query */
function guessContentType(target: string): string {
  let pathname = target
  try {
    pathname = target.includes('://') ? new URL(target).pathname : target
  } catch {
    /* 非法 URL 时退回原始字符串 */
  }
  return mime.lookup(pathname) || DEFAULT_TYPE
}

/** 客户端断开时调用 fn；正常完成后自动解绑，避免误伤已结束的流 */
function onClientClose(reply: FastifyReply, fn: () => void): () => void {
  const handler = (): void => {
    if (!reply.raw.writableEnded) fn()
  }
  reply.raw.on('close', handler)
  return () => reply.raw.removeListener('close', handler)
}

/** 返回流的响应体（由 Fastify 负责 pipe 与 HEAD 处理）；失败时自行发送错误响应并返回 undefined */
export async function streamMedia(
  req: FastifyRequest,
  reply: FastifyReply,
  record: MediaRecord
): Promise<NodeJS.ReadableStream | undefined> {
  if (record.source.kind === 'local') return streamLocal(req, reply, record.source.filePath)
  return streamRemote(req, reply, record.source.url, record.source.headers)
}

async function streamLocal(
  req: FastifyRequest,
  reply: FastifyReply,
  filePath: string
): Promise<NodeJS.ReadableStream | undefined> {
  let stat: fs.Stats
  try {
    stat = await fs.promises.stat(filePath)
  } catch {
    await reply.code(404).send({ error: 'NOT_FOUND' })
    return
  }
  if (!stat.isFile()) {
    await reply.code(404).send({ error: 'NOT_FOUND' })
    return
  }

  reply.header('Accept-Ranges', 'bytes')

  const range = parseRange(req.headers.range, stat.size)
  if (range === 'invalid') {
    await reply
      .code(416)
      .header('Content-Range', `bytes */${stat.size}`)
      .send({ error: 'RANGE_NOT_SATISFIABLE' })
    return
  }

  reply.header('Content-Type', guessContentType(filePath))

  if (req.method === 'HEAD') {
    if (range) {
      reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
      reply.header('Content-Length', String(range.end - range.start + 1))
    } else {
      reply.code(200).header('Content-Length', String(stat.size))
    }
    await reply.send()
    return
  }

  const stream = range
    ? fs.createReadStream(filePath, { start: range.start, end: range.end })
    : fs.createReadStream(filePath)
  if (range) {
    reply
      .code(206)
      .header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
      .header('Content-Length', String(range.end - range.start + 1))
  } else {
    reply.code(200).header('Content-Length', String(stat.size))
  }
  stream.on('error', (err) => req.log?.warn?.({ err }, 'media file stream failed'))
  const detach = onClientClose(reply, () => stream.destroy())
  stream.on('close', detach)
  return stream
}

async function streamRemote(
  req: FastifyRequest,
  reply: FastifyReply,
  url: string,
  headers?: Record<string, string>
): Promise<NodeJS.ReadableStream | undefined> {
  const controller = new AbortController()
  const detach = onClientClose(reply, () => controller.abort())

  const upstreamHeaders: Record<string, string> = { ...(headers ?? {}) }
  if (req.headers.range) upstreamHeaders.range = req.headers.range
  if (!upstreamHeaders.accept) upstreamHeaders.accept = '*/*'

  let upstream: Response
  try {
    upstream = await fetch(url, {
      method: req.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders,
      signal: controller.signal,
      redirect: 'follow'
    })
  } catch (err) {
    detach()
    // 客户端主动断开导致的中止不是错误，静默结束
    if (controller.signal.aborted) return
    req.log?.warn?.({ err }, 'media upstream request failed')
    if (!reply.raw.headersSent) await reply.code(502).send({ error: 'UPSTREAM_ERROR' })
    return
  }

  reply.code(upstream.status)
  for (const name of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'last-modified',
    'etag'
  ]) {
    const value = upstream.headers.get(name)
    if (value != null) reply.header(name, value)
  }
  if (!upstream.headers.get('content-type')) reply.header('Content-Type', guessContentType(url))
  if (!upstream.headers.get('accept-ranges')) reply.header('Accept-Ranges', 'bytes')

  if (req.method === 'HEAD' || !upstream.body) {
    detach()
    await reply.send()
    return
  }

  const stream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])
  stream.on('error', (err) => req.log?.warn?.({ err }, 'media upstream stream failed'))
  stream.on('close', detach)
  return stream
}
