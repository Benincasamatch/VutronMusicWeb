import { API_PATHS, WS_CSRF_PROTOCOL_PREFIX, WS_PROTOCOL } from '@lan/shared'
import { ApiError } from './client'

export type EventHandlers = {
  message: (data: unknown) => void
  closed: (code: number) => void
  failed: () => void
}
export type EventConnection = { close: () => void }
export type OpenEvents = (csrfToken: string, handlers: EventHandlers) => EventConnection

export function eventSocketUrl(origin: string): string {
  const url = new URL(API_PATHS.events, origin)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ApiError('PROTOCOL_ERROR')
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

export const openEvents: OpenEvents = (csrfToken, handlers) => {
  const socket = new WebSocket(eventSocketUrl(window.location.origin), [
    WS_PROTOCOL,
    `${WS_CSRF_PROTOCOL_PREFIX}${csrfToken}`
  ])
  socket.onopen = () => {
    if (socket.protocol !== WS_PROTOCOL) {
      handlers.failed()
      socket.close(1002)
    }
  }
  socket.onmessage = (event) => handlers.message(event.data as unknown)
  socket.onclose = (event) => handlers.closed(event.code)
  socket.onerror = () => handlers.failed()
  return {
    close: () => {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      socket.close()
    }
  }
}
