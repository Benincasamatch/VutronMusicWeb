import { computed, ref, shallowRef } from 'vue'
import { defineStore } from 'pinia'
import {
  LIMITS,
  ServerEventSchema,
  WS_SESSION_REVOKED_CLOSE_CODE,
  canControlPlayback,
  canManageUsers,
  canRemoveWaitingEntry
} from '@lan/shared'
import type {
  CreateUserRequest,
  LoginRequest,
  MutationRequest,
  MutationResponse,
  PublicUser,
  Role,
  SessionResponse,
  Snapshot,
  Track
} from '@lan/shared'
import { ApiError, createApiClient, createRequestId } from '../api/client'
import type { ApiClient, PlayerIntent } from '../api/client'
import { openEvents } from '../api/events'
import type { EventConnection, OpenEvents } from '../api/events'
import { watchEnvironment } from '../api/lifecycle'
import type { WatchEnvironment } from '../api/lifecycle'
import { errorMessage } from '../utils/errors'

type ConnectionStatus = 'checking' | 'signed-out' | 'connecting' | 'connected' | 'reconnecting' | 'offline'
type Notice = { kind: 'error' | 'info' | 'success', text: string }
export type RoomDependencies = {
  api: ApiClient
  openEvents: OpenEvents
  watchEnvironment: WatchEnvironment
  requestId: () => string
  now: () => number
  monotonicNow: () => number
  random: () => number
}

type MutationContext = {
  meta: MutationRequest
  token: string
  signal: AbortSignal
}

// The server publishes a progress snapshot about once a second while a track plays, so this much
// silence means the socket is dead rather than the room being quiet. An idle room sends nothing at
// all, which is why the watchdog is only armed during playback.
const PLAYBACK_SILENCE_MS = 12000
// A page hidden for less than this is an ordinary tab switch; a device that slept is away far longer.
const RESUME_GRACE_MS = 5000

// Dependencies are injected for authored unit tests. There is no simulated browser player.
export function createRoomStore(dependencies: RoomDependencies) {
  return defineStore('room', () => {
    const session = shallowRef<SessionResponse | null>(null)
    const snapshot = shallowRef<Snapshot | null>(null)
    const sampledAt = ref(0)
    const connection = ref<ConnectionStatus>('checking')
    const busy = ref<string | null>(null)
    const authBusy = ref(false)
    const notice = shallowRef<Notice | null>(null)
    const tracks = shallowRef<Track[]>([])
    const search = ref('')
    const totalTracks = ref(0)
    const catalogOffset = ref(0)
    const catalogLoading = ref(false)
    const catalogError = ref<string | null>(null)
    const users = shallowRef<PublicUser[]>([])
    const usersLoading = ref(false)
    const usersError = ref<string | null>(null)

    const connected = computed(() => connection.value === 'connected')
    const canWrite = computed(() => connected.value && !!session.value && !!snapshot.value && !busy.value && !authBusy.value)
    const controlsAllowed = computed(() => !!session.value && canControlPlayback(session.value.user.role))
    const admin = computed(() => !!session.value && canManageUsers(session.value.user.role))

    let running = false
    let generation = 0
    let lifetime = new AbortController()
    let socket: EventConnection | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined
    let expiryTimer: ReturnType<typeof setTimeout> | undefined
    let reconnectAttempt = 0
    let livenessTimer: ReturnType<typeof setTimeout> | undefined
    let hiddenSince: number | null = null
    let unwatchEnvironment: (() => void) | undefined
    let catalogRequest = 0
    let userRequest = 0

    const current = (value: number) => running && value === generation

    function retire() {
      generation += 1
      lifetime.abort()
      lifetime = new AbortController()
      clearTimeout(reconnectTimer)
      clearTimeout(snapshotTimer)
      clearTimeout(livenessTimer)
      reconnectTimer = undefined
      snapshotTimer = undefined
      livenessTimer = undefined
      const oldSocket = socket
      socket = null
      oldSocket?.close()
      busy.value = null
      authBusy.value = false
      catalogRequest += 1
      userRequest += 1
      catalogLoading.value = false
      usersLoading.value = false
      return generation
    }

    function clearProtected() {
      clearTimeout(expiryTimer)
      expiryTimer = undefined
      session.value = null
      snapshot.value = null
      sampledAt.value = 0
      tracks.value = []
      totalTracks.value = 0
      catalogOffset.value = 0
      search.value = ''
      catalogError.value = null
      users.value = []
      usersError.value = null
      busy.value = null
    }

    function showNotice(kind: Notice['kind'], text: string) {
      notice.value = { kind, text }
    }

    function invalidateSession(text: string) {
      clearProtected()
      showNotice('info', text)
      // Recheck the cookie: another tab may have established a newer session.
      void synchronize()
    }

    function armExpiry(value: SessionResponse) {
      clearTimeout(expiryTimer)
      expiryTimer = setTimeout(() => {
        invalidateSession('登录已到期，正在重新确认身份。')
      }, Math.max(0, Date.parse(value.expiresAt) - dependencies.now()))
    }

    function retryConnection() {
      retire()
      if (!running) return
      connection.value = session.value ? 'reconnecting' : 'offline'
      const base = Math.min(1000 * 2 ** Math.min(reconnectAttempt, 5), 30000)
      reconnectAttempt += 1
      const delay = Math.round(base * (0.75 + dependencies.random() * 0.5))
      reconnectTimer = setTimeout(() => void synchronize(), delay)
    }

    // Silence only proves the socket is dead when the server would otherwise be talking.
    function armLiveness(sourceGeneration: number) {
      clearTimeout(livenessTimer)
      livenessTimer = undefined
      if (connection.value !== 'connected' || snapshot.value?.player.status !== 'playing') return
      livenessTimer = setTimeout(() => {
        livenessTimer = undefined
        if (current(sourceGeneration) && connection.value === 'connected') retryConnection()
      }, PLAYBACK_SILENCE_MS)
    }

    function handleVisibility(state: 'visible' | 'hidden') {
      if (!running) return
      if (state === 'hidden') {
        hiddenSince = dependencies.now()
        return
      }
      const away = hiddenSince === null ? 0 : dependencies.now() - hiddenSince
      hiddenSince = null
      if (away < RESUME_GRACE_MS) return
      // The device may have outlived the socket. Reconfirm identity and state instead of trusting it.
      reconnectAttempt = 0
      void synchronize()
    }

    function handleOffline() {
      if (!running || connection.value === 'signed-out') return
      // Stop presenting state that can no longer be confirmed; retrying is the only honest option.
      retryConnection()
    }

    function handleOnline() {
      if (!running) return
      reconnectAttempt = 0
      void synchronize()
    }

    function setSnapshot(value: Snapshot) {
      snapshot.value = value
      sampledAt.value = dependencies.monotonicNow()
    }

    function applySnapshot(value: Snapshot, sourceGeneration: number): boolean {
      if (!current(sourceGeneration)) return false
      const previous = snapshot.value
      if (previous && value.serverInstanceId !== previous.serverInstanceId) {
        showNotice('info', '服务器已重新启动，正在重新确认会话和播放状态。未完成的操作不会重发。')
        clearProtected()
        void synchronize()
        return false
      }
      if (!previous || value.eventSeq > previous.eventSeq) setSnapshot(value)
      return true
    }

    function attachEvents(sourceGeneration: number, csrfToken: string) {
      let firstSnapshot = true
      snapshotTimer = setTimeout(() => {
        if (current(sourceGeneration)) retryConnection()
      }, 12000)
      socket = dependencies.openEvents(csrfToken, {
        message: (raw) => {
          if (!current(sourceGeneration)) return
          let event
          try {
            if (typeof raw !== 'string') throw new ApiError('PROTOCOL_ERROR')
            event = ServerEventSchema.parse(JSON.parse(raw) as unknown)
          } catch {
            showNotice('error', '实时消息无法验证，正在重新连接。')
            retryConnection()
            return
          }
          // Private revocations can share/precede a sampled sequence. Never sequence-filter them.
          if (event.type === 'session.revoked') {
            const reasons = {
              logout: '此会话已退出，正在重新确认身份。',
              expired: '登录已到期，请重新登录。',
              role_changed: '你的角色已变更，请重新登录以使用新权限。'
            }
            invalidateSession(reasons[event.reason])
            return
          }
          // The server rebuilt a dead player. Say so instead of silently resuming.
          if (event.type === 'player.recovered') {
            showNotice('info', '实体播放器已重新连接，正在恢复播放。')
            return
          }
          if (!applySnapshot(event.snapshot, sourceGeneration)) return
          if (firstSnapshot) {
            firstSnapshot = false
            clearTimeout(snapshotTimer)
            snapshotTimer = undefined
            reconnectAttempt = 0
            connection.value = 'connected'
            void loadCatalog(search.value, catalogOffset.value)
          }
          // Each accepted message is also a liveness proof.
          armLiveness(sourceGeneration)
        },
        closed: (code) => {
          if (!current(sourceGeneration)) return
          if (code === WS_SESSION_REVOKED_CLOSE_CODE) {
            invalidateSession('会话连接已失效，正在重新确认身份。')
          } else {
            retryConnection()
          }
        },
        failed: () => {
          if (current(sourceGeneration)) retryConnection()
        }
      })
    }

    async function synchronize(knownSession?: SessionResponse) {
      const sourceGeneration = retire()
      if (!running) return
      connection.value = session.value ? 'reconnecting' : 'checking'
      try {
        const verified = knownSession ?? await dependencies.api.me(lifetime.signal)
        if (!current(sourceGeneration)) return
        if (Date.parse(verified.expiresAt) <= dependencies.now()) {
          clearProtected()
          connection.value = 'signed-out'
          showNotice('error', '会话已过期，请重新登录。')
          return
        }
        if (session.value && (session.value.csrfToken !== verified.csrfToken || session.value.user.role !== verified.user.role)) {
          clearProtected()
        }
        session.value = verified
        armExpiry(verified)
        connection.value = 'connecting'
        const state = await dependencies.api.state(lifetime.signal)
        if (!current(sourceGeneration)) return
        // Only a freshly authenticated bootstrap may establish a new instance epoch.
        if (!snapshot.value || snapshot.value.serverInstanceId !== state.serverInstanceId || state.eventSeq > snapshot.value.eventSeq) {
          setSnapshot(state)
        }
        attachEvents(sourceGeneration, verified.csrfToken)
      } catch (error) {
        if (!current(sourceGeneration)) return
        if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') {
          retire()
          clearProtected()
          connection.value = 'signed-out'
        } else {
          showNotice('error', errorMessage(error))
          retryConnection()
        }
      }
    }

    function handleRequestError(error: unknown, sourceGeneration: number, isMutation = false) {
      if (!current(sourceGeneration)) return
      showNotice('error', errorMessage(error))
      if (!(error instanceof ApiError)) return
      if (['UNAUTHENTICATED', 'CSRF_INVALID', 'FORBIDDEN'].includes(error.code)) {
        invalidateSession(errorMessage(error))
      } else if (['INSTANCE_CONFLICT', 'REVISION_CONFLICT', 'PLAYBACK_CONFLICT', 'PLAYER_UNAVAILABLE', 'PLAYBACK_FAILED'].includes(error.code)) {
        void synchronize()
      } else if (isMutation && ['NETWORK_ERROR', 'PROTOCOL_ERROR', 'INTERNAL_ERROR'].includes(error.code)) {
        // A write may have reached the server. Read fresh state; never repeat the write.
        void synchronize()
      }
    }

    function start() {
      if (running) return
      running = true
      unwatchEnvironment = dependencies.watchEnvironment({
        visibility: handleVisibility,
        online: handleOnline,
        offline: handleOffline
      })
      void synchronize()
    }

    function stop() {
      running = false
      unwatchEnvironment?.()
      unwatchEnvironment = undefined
      hiddenSince = null
      retire()
      clearProtected()
      connection.value = 'signed-out'
    }

    async function login(input: LoginRequest): Promise<boolean> {
      if (authBusy.value || session.value || !running) return false
      const sourceGeneration = retire()
      authBusy.value = true
      notice.value = null
      try {
        const value = await dependencies.api.login(input, lifetime.signal)
        if (!current(sourceGeneration)) return false
        await synchronize(value)
        return true
      } catch (error) {
        if (!current(sourceGeneration)) return false
        showNotice('error', error instanceof ApiError && error.code === 'UNAUTHENTICATED'
          ? '账号或密码不正确。'
          : errorMessage(error))
        if (error instanceof ApiError && ['NETWORK_ERROR', 'PROTOCOL_ERROR'].includes(error.code)) {
          // The server may have set a cookie despite a lost login response.
          void synchronize()
        } else {
          connection.value = 'signed-out'
        }
        return false
      } finally {
        if (current(sourceGeneration)) authBusy.value = false
      }
    }

    async function logout() {
      if (!session.value || authBusy.value) return
      const token = session.value.csrfToken
      const sourceGeneration = retire()
      authBusy.value = true
      connection.value = 'reconnecting'
      try {
        await dependencies.api.logout(token, lifetime.signal)
        if (!current(sourceGeneration)) return
        clearProtected()
        connection.value = 'signed-out'
        showNotice('info', '已退出此账号。实体播放器不会因此停止。')
      } catch (error) {
        if (!current(sourceGeneration)) return
        showNotice('error', error instanceof ApiError && error.code === 'NETWORK_ERROR'
          ? '退出结果尚未确认，正在重新检查会话。'
          : errorMessage(error))
        clearProtected()
        void synchronize()
      } finally {
        if (current(sourceGeneration)) authBusy.value = false
      }
    }

    async function loadCatalog(query = search.value, offset = 0) {
      if (!connected.value || !session.value) return
      const sourceGeneration = generation
      const request = ++catalogRequest
      search.value = query
      catalogLoading.value = true
      catalogError.value = null
      try {
        const result = await dependencies.api.tracks({ q: query, offset, limit: LIMITS.trackPageSize }, lifetime.signal)
        if (!current(sourceGeneration) || request !== catalogRequest) return
        tracks.value = result.tracks
        totalTracks.value = result.total
        catalogOffset.value = result.offset
      } catch (error) {
        if (!current(sourceGeneration)) return
        // A stale search can still report an invalid session, but cannot replace search results.
        handleRequestError(error, sourceGeneration)
        if (current(sourceGeneration) && request === catalogRequest) catalogError.value = errorMessage(error)
      } finally {
        if (current(sourceGeneration) && request === catalogRequest) catalogLoading.value = false
      }
    }

    async function loadUsers() {
      if (!connected.value || !admin.value) return
      const sourceGeneration = generation
      const request = ++userRequest
      usersLoading.value = true
      usersError.value = null
      try {
        const result = await dependencies.api.users(lifetime.signal)
        if (current(sourceGeneration) && request === userRequest) users.value = result.users
      } catch (error) {
        if (!current(sourceGeneration)) return
        handleRequestError(error, sourceGeneration)
        if (current(sourceGeneration) && request === userRequest) usersError.value = errorMessage(error)
      } finally {
        if (current(sourceGeneration) && request === userRequest) usersLoading.value = false
      }
    }

    async function mutate(label: string, action: (context: MutationContext) => Promise<MutationResponse>): Promise<boolean> {
      if (!canWrite.value || !snapshot.value || !session.value) return false
      const sourceGeneration = generation
      const observed = snapshot.value
      const token = session.value.csrfToken
      busy.value = label
      notice.value = null
      try {
        const result = await action({
          meta: {
            requestId: dependencies.requestId(),
            serverInstanceId: observed.serverInstanceId,
            expectedRevision: observed.queue.revision
          },
          token,
          signal: lifetime.signal
        })
        if (!applySnapshot(result.snapshot, sourceGeneration)) return false
        showNotice('success', '操作已由服务器确认。')
        return true
      } catch (error) {
        handleRequestError(error, sourceGeneration, true)
        return false
      } finally {
        if (current(sourceGeneration)) busy.value = null
      }
    }

    function enqueue(trackId: string) {
      return mutate(`enqueue:${trackId}`, ({ meta, token, signal }) => dependencies.api.enqueue({ ...meta, trackId }, token, signal))
    }

    function remove(entryId: string) {
      const entry = snapshot.value?.queue.entries.find((item) => item.entryId === entryId)
      if (!entry || !session.value || !canRemoveWaitingEntry(session.value.user, entry)) return Promise.resolve(false)
      return mutate(`remove:${entryId}`, ({ meta, token, signal }) => dependencies.api.remove(entryId, meta, token, signal))
    }

    function command(intent: PlayerIntent, targetPlaybackId: string | null) {
      if (!canWrite.value || !controlsAllowed.value || !snapshot.value) return Promise.resolve(false)
      if (targetPlaybackId !== snapshot.value.player.playbackId) {
        showNotice('info', '歌曲已切换，请重新确认当前歌曲后操作。')
        return Promise.resolve(false)
      }
      return mutate(intent.command, ({ meta, token, signal }) => dependencies.api.command(
        intent, { ...meta, targetPlaybackId }, token, signal
      ))
    }

    async function manageUser(
      label: string,
      action: (requestId: string, token: string, signal: AbortSignal) => ReturnType<ApiClient['createUser']>
    ): Promise<boolean> {
      if (!canWrite.value || !admin.value || !session.value) return false
      const sourceGeneration = generation
      const actingUser = session.value.user
      const token = session.value.csrfToken
      busy.value = label
      notice.value = null
      try {
        const result = await action(dependencies.requestId(), token, lifetime.signal)
        if (!current(sourceGeneration)) return false
        if (result.user.id === actingUser.id && result.user.role !== actingUser.role) {
          invalidateSession('你的角色已变更，请重新登录。')
          return true
        }
        showNotice('success', '账号更新已由服务器确认。')
        await loadUsers()
        return true
      } catch (error) {
        handleRequestError(error, sourceGeneration, true)
        return false
      } finally {
        if (current(sourceGeneration)) busy.value = null
      }
    }

    function createUser(input: Omit<CreateUserRequest, 'requestId'>) {
      return manageUser('create-user', (requestId, token, signal) => dependencies.api.createUser({ ...input, requestId }, token, signal))
    }

    function updateRole(userId: string, role: Role) {
      return manageUser(`role:${userId}`, (requestId, token, signal) => dependencies.api.updateRole(userId, { requestId, role }, token, signal))
    }

    return {
      session,
      snapshot,
      sampledAt,
      connection,
      connected,
      canWrite,
      controlsAllowed,
      admin,
      busy,
      authBusy,
      notice,
      tracks,
      search,
      totalTracks,
      catalogOffset,
      catalogLoading,
      catalogError,
      users,
      usersLoading,
      usersError,
      start,
      stop,
      reconnect: () => synchronize(),
      dismissNotice: () => { notice.value = null },
      login,
      logout,
      loadCatalog,
      loadUsers,
      enqueue,
      remove,
      command,
      createUser,
      updateRole
    }
  })
}

export const useRoomStore = createRoomStore({
  api: createApiClient(),
  openEvents,
  watchEnvironment,
  requestId: createRequestId,
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  random: () => Math.random()
})
