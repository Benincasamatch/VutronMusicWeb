/**
 * 插件 Worker（纯 JS，无 TS/无构建依赖）。
 * 与桌面版 src/main/workers/pluginRunner.ts 保持同一消息协议，宿主侧 host.ts 负责网络/存储/DB/歌词等桥接。
 *
 * 宿主 → Worker：LOAD_PLUGIN / CALL_METHOD / HTTP_RESPONSE / STORE_RESPONSE / DB_RESPONSE / LYRIC_RESPONSE
 * Worker → 宿主：LOAD_DONE / ERROR / LOG / CALL_RESULT / STORE_REQUEST / STORE_SET /
 *                HTTP_REQUEST / DB_REQUEST / DB_SET / LYRIC_PARSE / LYRIC_EMBEDDED / LYRIC_PATH / CHECK_FILE_EXIST
 */
import { parentPort } from 'node:worker_threads'
import crypto from 'node:crypto'

process.on('unhandledRejection', (reason) => {
  console.error('[PluginWorker] Unhandled rejection:', reason)
})

process.on('uncaughtException', (err) => {
  console.error('[PluginWorker] Uncaught exception:', err?.message ?? err)
})

/** @type {Record<string, (...args: any[]) => any>} */
let pluginExports = Object.create(null)

const pendingRequests = new Map()

function post(message) {
  parentPort?.postMessage(message)
}

/**
 * 向宿主发起一次「请求/应答」式调用。
 * @param {string} type
 * @param {Record<string, any>} payload
 * @param {number} timeoutMs 0 表示不设超时
 * @param {(msg: any) => any} [pick] 从宿主应答中提取结果
 */
function request(type, payload, timeoutMs, pick) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    let timer = null

    const done = (fn, value) => {
      clearTimeout(timer)
      pendingRequests.delete(requestId)
      fn(value)
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (pendingRequests.has(requestId)) done(reject, new Error('Request timeout'))
      }, timeoutMs)
    }

    pendingRequests.set(requestId, {
      resolve: (msg) => done(resolve, pick ? pick(msg) : msg),
      reject: (err) => done(reject, err)
    })

    post({ type, requestId, ...payload })
  })
}

function makeHttp(method) {
  return (url, a, b, c) => {
    // get(url, params, headers, raw) / post|delete(url, data, headers, raw)
    const isGet = method === 'GET'
    const second = a
    const headers = b
    const raw = c
    return request(
      'HTTP_REQUEST',
      {
        url,
        method,
        ...(isGet ? { params: second } : { data: second }),
        headers,
        raw
      },
      12000
    )
  }
}

const log = (msg) => {
  post({ type: 'LOG', msg: typeof msg === 'string' ? msg : String(msg) })
}
// 兼容插件文档中的 apis.log.info / apis.log.error 写法
log.info = log
log.error = log

const api = {
  http: {
    get: makeHttp('GET'),
    post: makeHttp('POST'),
    delete: makeHttp('DELETE')
  },

  log,

  store: {
    get(key) {
      return request('STORE_REQUEST', { key }, 0)
    },
    set(key, value) {
      post({ type: 'STORE_SET', key, value })
    }
  },

  db: {
    get(table, filter) {
      return request('DB_REQUEST', { key: table, filter }, 5000)
    },
    set(key, value) {
      post({ type: 'DB_SET', key, value })
    }
  },

  utils: {
    parseLyric(msg) {
      return request('LYRIC_PARSE', { msg }, 12000)
    },
    md5(input) {
      return crypto.createHash('md5').update(String(input)).digest('hex')
    },
    generateSalt() {
      return crypto.randomBytes(6).toString('hex')
    },
    generateToken(password, salt) {
      return crypto
        .createHash('md5')
        .update(String(password) + String(salt))
        .digest('hex')
    },
    getEmbeddedLyric(filePath) {
      return request('LYRIC_EMBEDDED', { filePath }, 12000)
    },
    getPathLyric(filePath) {
      return request('LYRIC_PATH', { filePath }, 12000)
    },
    checkFileExist(paths) {
      return request('CHECK_FILE_EXIST', { paths }, 12000)
    }
  }
}

parentPort?.on('message', async (msg) => {
  try {
    switch (msg.type) {
      case 'LOAD_PLUGIN': {
        try {
          const exports = Object.create(null)
          // 插件为 CommonJS 风格脚本：exports.xxx = fn
          const fn = new Function('api', 'exports', `"use strict";\n${msg.code}`)
          fn(api, exports)
          pluginExports = exports
          post({ type: 'LOAD_DONE', meta: exports.meta || {} })
        } catch (e) {
          pluginExports = Object.create(null)
          post({ type: 'ERROR', message: e?.message ?? String(e) })
        }
        break
      }

      case 'HTTP_RESPONSE': {
        const req = pendingRequests.get(msg.requestId)
        if (!req) return
        if (msg.error) {
          req.reject(new Error(msg.error))
        } else if (msg.raw) {
          req.resolve({ data: msg.data, status: msg.status, headers: msg.headers })
        } else {
          req.resolve(msg.data)
        }
        break
      }

      case 'STORE_RESPONSE':
      case 'DB_RESPONSE':
      case 'LYRIC_RESPONSE': {
        const req = pendingRequests.get(msg.requestId)
        if (!req) return
        req.resolve(msg.data)
        break
      }

      case 'CALL_METHOD': {
        try {
          const fn = pluginExports[msg.method]
          if (typeof fn !== 'function') throw new Error(`Method not found: ${msg.method}`)
          const result = await fn(...msg.args)
          post({ type: 'CALL_RESULT', callId: msg.callId, result })
        } catch (e) {
          post({ type: 'CALL_RESULT', callId: msg.callId, error: e?.message ?? String(e) })
        }
        break
      }
    }
  } catch (e) {
    console.error('[PluginWorker] Unhandled error processing message:', e?.message ?? String(e))
  }
})
