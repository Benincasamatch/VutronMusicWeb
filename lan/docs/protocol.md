# LAN control protocol, version 1

This is the normative first-milestone interface for the independent `lan/` application. Runtime validators and TypeScript types are exported by `@lan/shared` from `packages/shared/src/index.ts`. Every object is strict: unknown keys are rejected, not silently copied or stripped. Server handlers validate incoming requests and construct/validate public responses. No old desktop or `web/` types, code or assets are part of this contract.

## System boundary

- One server owns one physical mpv process, one current playback and one shared FIFO waiting queue. SQLite, using Node 24's `node:sqlite`, stores application accounts, sessions, controlled track identities and waiting entries.
- Browsers are remote controls only. They never create an audio element, `AudioContext`, media playback engine, stream URL or download request. There is no audio-serving endpoint.
- The first milestone is a bounded catalog of local files under one operator-controlled `MUSIC_ROOT`. It is not a metadata library, NAS browser, upload server, plugin host, NetEase client or favorites system.
- mpv must be a private Linux child with a private Unix JSON IPC socket. Do not attach to an existing user mpv, expose its IPC through HTTP, run as OS root or use a shell to launch it. Start without user configuration, scripts, network extractors, video or interactive input. The actual output device is Linux USB/3.5mm audio, not the remote browser.
- A fake driver is dependency-injected by tests. Runtime simulation requires both `NODE_ENV=development` and explicit `DEV_SIMULATION=true`; otherwise a missing/failed mpv is an explicit error or startup failure, never an automatic fake/ffplay/browser fallback. Every snapshot includes the simulation flag and the UI must show a persistent simulation warning.

## Origins and configuration

| Setting | Development | Production |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` |
| `HOST` | `127.0.0.1` (or explicitly `::1`) | Loopback only |
| `PORT` | `41840` | `41840`, unless deliberately reconfigured |
| Browser origin | `http://localhost:5174` | One exact HTTPS origin |
| `PUBLIC_ORIGIN` | `http://localhost:5174` | Required `https://host[:port]`, without credentials/path/query/fragment |
| `MUSIC_ROOT` | Explicit controlled local directory | Explicit controlled local directory |
| `DATA_DIR` | Independent application state, normally `lan/data` | Private, writable by service user only |
| `MPV_PATH` | `/usr/bin/mpv` for real playback | Absolute path to the selected mpv executable |
| `MPV_AUDIO_DEVICE` | `auto` or one exact mpv audio-device identifier | Select the intended USB/3.5mm output |
| `DEV_SIMULATION` | `false`, opt in explicitly if required | Must be `false` |

Relative `MUSIC_ROOT` and `DATA_DIR` values resolve against `lan/`, not the shell's working directory. The application must not reuse desktop state, credentials or configuration. `.env` is local and ignored. Do not accept wildcard bind addresses, wildcard origins, arbitrary forwarded hosts or production HTTP. The shipped Vite configuration binds only `localhost:5174`, uses a strict port and proxies `/api` (including WebSocket upgrades) to `http://127.0.0.1:41840` without rewriting the original Origin/Host. The shipped proxy assumes the default backend port. Change that target deliberately if changing `PORT`.

Production requires an independently configured HTTPS reverse proxy to the loopback backend. It must preserve the public Host and Origin, forward WebSocket upgrades and not expose private files. Backend `trustProxy` is off by default; do not blindly trust `X-Forwarded-*`. The production backend serves only `apps/web/dist` as static content and requires a regular, non-symlink `index.html`. The `/api` namespace is explicitly reserved: missing routes return JSON errors, even if a matching file was accidentally included in the static build. Neither listener in this milestone is public by default; remote LAN access requires the operator's separate proxy configuration.

Pathnames are canonical literal paths: percent-encoded path characters, backslashes, repeated slashes and `.` / `..` segments are rejected before routing. All defined route names, UUID parameters and current build asset names work without those encodings. Percent-encoding **query values** (for example a Chinese search term or literal `%`) remains supported. This prevents router/static URL normalization from bypassing the raw-path authentication boundary. Production CSP permits only same-origin connections, explicitly including the matching `wss:` origin for browser compatibility, and forbids media playback.

All state-changing HTTP requests, including login, require an exact `Origin: <PUBLIC_ORIGIN>`. Reject a missing, `null` or mismatched Origin. Validate Host against the configured public host (and explicitly documented loopback health access, if any); this is not a CORS-enabled API. Unsafe authenticated requests additionally require `X-CSRF-Token`. Never place CSRF/session credentials in query strings, local storage, logs or broadcast snapshots. GET responses containing account or state information use `Cache-Control: no-store`.

## Identity, authorization and sessions

Application roles are exactly `admin`, `dj` and `user`. There is no privileged `root` role, default account, default password, anonymous write API or public signup.

| Operation | user | dj | admin |
| --- | --- | --- | --- |
| Inspect tracks/shared state, receive events | Yes | Yes | Yes |
| Enqueue a known track | Yes | Yes | Yes |
| Remove own WAITING entry | Yes | Yes | Yes |
| Remove another user's WAITING entry | No | Yes | Yes |
| Play, pause, next, previous, seek, volume, mute | No | Yes | Yes |
| List/create users, change roles | No | No | Yes |

The server rechecks the live authenticated account/role for every mutation. Shared permission helpers are only presentation conveniences, not an authorization boundary. `requester.id` is assigned from the session, never accepted from enqueue input. Current playback and history are not WAITING entries; no role may remove them through the queue-delete endpoint. DJs/admins use transport controls to skip current playback. This milestone has no reorder or clear-all operation.

Usernames are 3–32 ASCII characters, lowercase, matching `[a-z0-9][a-z0-9._-]*`. Do not silently lowercase or trim login input. New passwords have 12–128 JavaScript string code units and are never trimmed. Login accepts 1–128 units so malformed/incorrect credentials can receive the same generic authentication failure. Passwords are individually salted and hashed with bounded, asynchronous `node:crypto` scrypt; no plaintext, reversible storage or synchronous CPU-heavy request hashing.

A session has an absolute 12-hour expiry, not sliding refresh. The HttpOnly cookie `lan_session` contains an opaque, cryptographically random 32-byte base64url token; store only its digest server-side. Set `Path=/api`, `SameSite=Strict`, no Domain, and `Secure` in production. A separate random 32-byte base64url CSRF token is bound to the session. `POST login` and authenticated `GET me` return the same `SessionResponse` shape. GET me retrieves the existing session's CSRF token, does not rotate it, and is the reload/multi-tab bootstrap. CSRF stays in browser memory. Login creates a fresh session/token pair and revokes any session replaced by the current cookie. Enforce at most ten live sessions per account; reject additional sessions with `RATE_LIMITED` rather than silently bypassing the cap.

Logout invalidates that session in SQLite, clears its cookie, sends its open sockets `session.revoked` with reason `logout` and closes them. Expiry uses `expired`. A real role change revokes **all** target-user sessions with `role_changed`, including the acting admin's session if they changed themselves. A same-role update is a no-op and does not revoke sessions. Check and preserve at least one admin inside the role-update transaction (`LAST_ADMIN` on violation). After revocation, cookies and sockets cannot authorize new requests even if a revocation frame is lost. Clients clear user, CSRF, protected state and pending actions on 401/revocation. To recover a CSRF error, retrieve `/api/auth/me`, but never automatically repeat a failed mutation.

There is no HTTP bootstrap exception. After an approved build, the local administrative entry point is `npm run admin -- bootstrap --username <name>` from `lan/`. It creates the initial admin only when the accounts table is empty. Password input must be hidden, interactive and confirmed; no default, command-line password, environment password or logged password. Run bootstrap with the service stopped and as the same non-root OS account that owns `DATA_DIR`. Later account management uses the authenticated admin endpoints.

## Exact public data shapes

All IDs below are UUID strings, generated by the server except client-generated `requestId`. Numbers must be finite. Revisions and sequence numbers are nonnegative safe integers. Timestamps are UTC ISO-8601 strings. Null fields are **present**, not omitted. Limits are exported as `LIMITS`.

```ts
type Role = 'admin' | 'dj' | 'user'
type PublicUser = { id: string, username: string, role: Role }
type Requester = { id: string, username: string }
type SessionResponse = {
  user: PublicUser
  csrfToken: string // exactly 43 base64url characters
  expiresAt: string
}
type Track = {
  id: string
  title: string
  artist: string | null
  album: string | null
  durationSeconds: number | null
}
type QueueEntry = {
  entryId: string
  track: Track
  requester: Requester
  addedAt: string
}
type QueueState = { revision: number, entries: QueueEntry[] }
type Player = {
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error'
  current: QueueEntry | null
  playbackId: string | null
  positionSeconds: number
  durationSeconds: number | null
  volume: number // integer 0–100
  muted: boolean
  error: {
    code: 'PLAYER_UNAVAILABLE' | 'PLAYBACK_FAILED'
    message: string
  } | null
}
type Snapshot = {
  serverInstanceId: string
  eventSeq: number
  simulation: boolean
  player: Player
  queue: QueueState
}
type MutationResponse = { requestId: string, snapshot: Snapshot }
type UserMutationResponse = { requestId: string, user: PublicUser }
type ErrorResponse = {
  error: {
    code: ErrorCode
    message: string
    requestId?: string
  }
}
```

Titles, non-null artist/album names and safe error messages are 1–256 characters. Durations and positions are 0–604800 seconds (seven days). Unknown duration is null, not zero. Track IDs resolve only through the server's own catalog. Public objects have no local path, URL, original source object, password digest or audio bytes. A filename-derived basename may supply the initial title; parent directories must not leak. Catalog records with unavailable metadata use nulls instead of inventing artists/albums.

`queue.entries` contains only WAITING entries, in FIFO order. Up to 500 waiting entries are allowed. Enqueue also rejects when the requesting account already has 50 waiting entries; internal displacement by previous is governed by the global cap rather than this enqueue allowance. Duplicate tracks are allowed with distinct `entryId`s; duplicate entry IDs and a current entry also present in the waiting list are invalid. `requester` contains identity only, not an authorization role snapshot.

`player.current` and `player.playbackId` are either both null or both set. Loading/playing/paused require a current entry. Idle requires no current entry. Without a current entry, position is zero and duration null. Only status `error` has a non-null safe `error` object; failed playback may retain its current entry and playback ID for an explicit retry. No mpv stderr, OS path, SQL error or stack trace is a public error message.

## Methods and payloads

All request and response bodies are JSON (`Content-Type: application/json`), except successful logout which has no response body. GET requests have no body. Authentication is required unless the table says otherwise. All body shapes below are exact; the URL selects a player operation, so there is no `command` body field.

Define these common request shapes:

```ts
type MutationRequest = {
  requestId: string
  serverInstanceId: string
  expectedRevision: number
}
type PlaybackRequest = MutationRequest & { targetPlaybackId: string | null }
```

| Method and path | Request | Success response | Permission |
| --- | --- | --- | --- |
| `POST /api/auth/login` | `{ username, password }` (`LoginRequestSchema`), exact Origin, no CSRF yet | 200 `SessionResponse`, Set-Cookie | Public, rate limited |
| `POST /api/auth/logout` | `{}` (`LogoutRequestSchema`), Origin + CSRF | 204, cookie cleared | Authenticated |
| `GET /api/auth/me` | No query/body | 200 `SessionResponse`; 401 when unauthenticated | Authenticated |
| `GET /api/tracks` | Query `q`, `offset`, `limit` (`TrackListQuerySchema`) | 200 `{ tracks: Track[], total, offset, limit }` | Authenticated |
| `GET /api/state` | No query/body | 200 `Snapshot` | Authenticated |
| `POST /api/queue` | `MutationRequest & { trackId }` (`EnqueueRequestSchema`) | 200 `MutationResponse` | Any account |
| `DELETE /api/queue/:entryId` | `MutationRequest` (`RemoveQueueEntryRequestSchema`), UUID URL parameter | 200 `MutationResponse` | Owner of WAITING entry or dj/admin |
| `POST /api/player/play` | `PlaybackRequest` (`PlayRequestSchema`) | 200 `MutationResponse` | dj/admin |
| `POST /api/player/pause` | `PlaybackRequest` (`PauseRequestSchema`) | 200 `MutationResponse` | dj/admin |
| `POST /api/player/next` | `PlaybackRequest` (`NextRequestSchema`) | 200 `MutationResponse` | dj/admin |
| `POST /api/player/previous` | `PlaybackRequest` (`PreviousRequestSchema`) | 200 `MutationResponse` | dj/admin |
| `POST /api/player/seek` | `PlaybackRequest & { positionSeconds }` (`SeekRequestSchema`) | 200 `MutationResponse` | dj/admin |
| `POST /api/player/volume` | `PlaybackRequest & { volume }` (`VolumeRequestSchema`) | 200 `MutationResponse` | dj/admin |
| `POST /api/player/mute` | `PlaybackRequest & { muted }` (`MuteRequestSchema`) | 200 `MutationResponse` | dj/admin |
| `GET /api/admin/users` | No query/body | 200 `{ users: PublicUser[] }` | admin |
| `POST /api/admin/users` | `{ requestId, username, password, role }` (`CreateUserRequestSchema`) | 201 `UserMutationResponse` | admin |
| `PATCH /api/admin/users/:userId/role` | `{ requestId, role }` (`UpdateUserRoleRequestSchema`), UUID URL parameter | 200 `UserMutationResponse` | admin |
| `GET /api/events` (upgrade) | Cookie + Origin + WebSocket subprotocols below | 101, then `ServerEvent` frames | Authenticated |

Pagination defaults to `q=''`, `offset=0`, `limit=50`. Offset is 0–10000; limit is 1–100. Only nonnegative decimal integer strings or already-parsed integers are accepted; no arrays, booleans or fractional/scientific notation query strings. Search is at most 128 characters, case-insensitive, a literal substring of title/artist/album, not SQL wildcard syntax. Stable result order is title then ID. Total is the number of matching records before pagination. The catalog is capped at 10000 tracks. Admin listing is username then ID, capped by the maximum 500 accounts. Unknown query parameters are validation errors where a query schema is used.

### Queue and playback semantics

- Enqueue appends one server-created entry. It does **not** start idle playback, even for an admin. While playback is already running, natural completion advances through waiting entries automatically.
- Remove first resolves `entryId` from the authoritative waiting queue. Missing/current/historical entries produce `NOT_FOUND`. An ordinary user cannot remove another requester's entry; return `FORBIDDEN`. Ownership checks use user IDs, not usernames.
- Play resumes the current paused entry without changing playback ID; it is a no-op if already playing. If idle, consume the first waiting entry and begin it, assigning a fresh playback ID. An empty idle queue returns `NOT_FOUND`. Retrying an error with a current entry requires an explicit play and assigns a fresh playback ID.
- Pause pauses current playback; idle or already paused is a no-op. Do not manufacture a paused current entry when idle.
- Next ends the current entry and starts the first waiting entry with a fresh playback ID. With no waiting entries, stop and become idle. With no current entry but a nonempty waiting list, start the head. Completely idle next is a no-op.
- Previous consumes the most recent successfully started entry from a bounded, server-private history stack (50 entries). Prepend the displaced current entry to the waiting queue, then start the historical entry with a fresh playback ID. Do not push the displaced current back into history in this operation. If displacement would exceed 500 waiting entries, reject atomically with `QUEUE_FULL`. If history is empty but there is a current entry, seek it to zero without changing its playback ID. With neither history nor current, return `NOT_FOUND`.
- Seek is absolute seconds, not a delta. It requires current playback; otherwise `PLAYBACK_CONFLICT`. Reject a target beyond known duration with `VALIDATION_ERROR`. Unknown duration still obeys the seven-day numeric cap. Seek does not change playback ID.
- Volume accepts only integer 0–100. Mute is a separate boolean; setting volume zero does not silently toggle mute. Device settings may change while idle, but still carry `targetPlaybackId: null`.
- A new load, next, previous or retry gets a new playback ID even if the same track or queue entry plays again. Resume, pause and seek retain it. EOF/error/position messages from an older playback must not mutate a newer playback. Serialize natural advancement with HTTP commands so simultaneous next/EOF never double-consumes.
- Missing/out-of-root/replaced catalog files are not playable. Driver failures are explicit, sanitized and reflected in the authoritative snapshot; clients never optimistically remove an entry or show playback success merely because a click occurred.
- Waiting entries persist in SQLite. On restart, start idle without auto-resuming or requeueing the old current entry; keep persisted waiting order, clear volatile history and idempotency caches, reset revision/sequence and create a fresh `serverInstanceId`. Accounts/sessions survive only according to their persisted validity/expiry. There is no promise to resume interrupted audio.

### Concurrency and retries

`queue.revision` is the shared control revision: despite its location, it covers accepted queue **and player** writes, including volume/mute, not just list membership. Serialize writes and transport transitions through one coordinator. For a new request, check the live session/role/CSRF, then instance, revision and (for every player operation) target playback ID before changing state or calling the driver. A null target means “I observed idle,” not “whichever track is now playing.” Never replace a request's expected revision with the current value server-side.

Each accepted queue/player mutation increments revision once, including accepted no-ops. Independent natural transport changes increment it too. Position/duration sampling does not increment revision. Repeated driver property acknowledgements of a just-applied command are not separate logical mutations. `eventSeq` increases for each published snapshot or private revocation event; a GET returns the current snapshot without incrementing it. Thus multiple samples may share one revision, and a client can observe sequence gaps. Values never wrap; start a new instance instead of exceeding safe integers.

Idempotency is session-scoped and keyed by client UUID `requestId`, including user-management writes. Retain the last 100 completed successful requests for up to 60 seconds during the process lifetime. Deduplicate in-flight identical requests as well. After authentication/authorization/CSRF succeeds, an exact retry (same method, URL and normalized body) returns its original response/status, without checking its now-old revision again or repeating a side effect. Reusing a cached request ID with different input is `REQUEST_ID_REUSED`. Do not retain plaintext passwords in a retry cache or log; use a process-keyed digest of sensitive request input. No replay guarantee survives eviction, restart, logout or revocation. The implementation also bounds serialized cached responses globally to 64 MiB, so memory pressure may evict successful results before their per-session age/count limit. Authentication/role checks always precede replay.

`INSTANCE_CONFLICT`, `REVISION_CONFLICT` and `PLAYBACK_CONFLICT` are 409 responses. They have no implied success and no optimistic client patch. Fetch a fresh snapshot and ask the user to issue a **new** intent with a new request ID; never automatically replay a conflict against the next track. On an uncertain network failure, an exact retry may reuse the original request ID while the session/instance still matches. Clients must not resend writes merely on socket reconnect. Even a successful cached response may be older than a snapshot already received; apply it only by the ordering rules below.

### Error responses

`ErrorResponseSchema` is the only JSON error envelope. Include `error.requestId` only if a valid UUID request ID was parsed; never reflect arbitrary input or credentials. Keep messages safe and short. HTTP `Retry-After` accompanies rate limits. Normalize framework/auth/JSON parse/not-found errors into this envelope. WebSocket failures before upgrade use HTTP status/envelope when supported; no HTML error page is a protocol response.

| Status | Codes |
| --- | --- |
| 400 | `VALIDATION_ERROR` |
| 401 | `UNAUTHENTICATED` (including generic bad login) |
| 403 | `FORBIDDEN`, `ORIGIN_REJECTED`, `CSRF_INVALID` |
| 404 | `NOT_FOUND` |
| 409 | `INSTANCE_CONFLICT`, `REVISION_CONFLICT`, `PLAYBACK_CONFLICT`, `REQUEST_ID_REUSED`, `QUEUE_FULL`, `TRACK_UNAVAILABLE`, `USERNAME_TAKEN`, `LAST_ADMIN`, `USER_LIMIT` |
| 429 | `RATE_LIMITED` |
| 502 | `PLAYBACK_FAILED` |
| 503 | `PLAYER_UNAVAILABLE` |
| 500 | `INTERNAL_ERROR` |

## WebSocket snapshots and session revocation

Connect only to same-origin `/api/events` using `ws:` in loopback development or `wss:` in production. Browsers send cookie authentication automatically. Offer exactly these subprotocols:

```ts
['lan.v1', `csrf.${csrfToken}`]
```

The server validates exact Origin, live cookie session and the CSRF offer **before** completing the upgrade. It selects/echoes only `lan.v1`, never the token-bearing protocol. Do not put a token in the URL and do not log `Cookie`, `Set-Cookie`, `X-CSRF-Token`, `Sec-WebSocket-Protocol` or auth request bodies. If a Vite/reverse proxy logs upgrade headers, redact them there as well.

Server-to-client messages are UTF-8 JSON parsed by `ServerEventSchema`:

```ts
type ServerEvent =
  | { type: 'snapshot', snapshot: Snapshot }
  | {
      type: 'session.revoked'
      serverInstanceId: string
      eventSeq: number
      reason: 'logout' | 'expired' | 'role_changed'
    }
  | {
      type: 'player.recovered'
      serverInstanceId: string
      eventSeq: number
      reason: 'driver_rebuilt'
    }
```

Send a full current snapshot immediately after subscribing; take the snapshot/subscription under the same coordinator so a change cannot be lost between them. Broadcast full snapshots after state changes and at most once per second for position sampling. No client event/command messages are accepted; commands use CSRF-protected HTTP. Close clients sending application messages with 1008. Use server WebSocket ping/pong every 30 seconds and terminate unresponsive connections after 60 seconds. The maximum incoming client payload is 1024 bytes; at most three sockets may attach to a session. If buffered output exceeds 4 MiB, close with 1013 and require a fresh snapshot on reconnect rather than accumulating history indefinitely. The buffer budget accommodates one maximum-size 500-entry snapshot including JSON escaping.

`session.revoked` is private to affected sessions, never broadcast to other accounts. It uses the global instance/sequence counter (unaffected clients may therefore see gaps). Send it if possible and then close with code 4001. Authorization cannot rely on delivery: expired/revoked sockets are removed immediately, and all HTTP requests check session validity independently.

`player.recovered` is broadcast to every subscriber. After an unrecoverable player failure, a subsequent authorized `play` command may rebuild the driver once; when the rebuild succeeds the server announces this event and the next snapshot no longer carries the error. A failed rebuild keeps the explicit error state. Clients must show it as a notice and never resume silently. It uses the global instance/sequence counter like `session.revoked`.

Client ordering rules:

1. Bootstrap the session with GET me, then get state/connect events. Keep account data separate from the shared snapshot.
2. For the same `serverInstanceId`, replace a snapshot only when its `eventSeq` is greater than the applied sequence; equal is a duplicate. Do this for both HTTP mutation responses and WebSocket frames.
3. A new instance establishes a new sequence epoch. Retire the old connection/generation and discard its late frames/HTTP responses; do not let an old response switch back to the retired instance. Clear pending actions and fetch current session/state before re-enabling controls. Use request/connection generation tokens, not only numeric comparisons.
4. Sequence gaps are allowed because every event is a full snapshot; there is no replay cursor or patch log. Reconnect with bounded exponential backoff and jitter, recover via GET me/state, and never replay pending mutations automatically.
5. A revocation from the active connection clears authentication immediately regardless of the last snapshot sequence. A 4001 close also forces GET me/authentication recovery. Stale old-connection messages cannot revoke a newly authenticated session.
6. On disconnection, mark controls unavailable. The server remains authoritative; a browser may animate a display estimate but cannot treat it as acknowledged seek/playback state or emit audio.

## Resource and file boundaries

Default HTTP body limit is 16 KiB. Normalize malformed/oversized/unsupported JSON input as `VALIDATION_ERROR` (400) without reflecting parser internals. Global HTTP throttling is 120 requests/minute per authenticated session, falling back to remote IP before authentication. Additionally limit login attempts to 10/minute per remote IP and mutations to 30/minute per session. Enforce these server-side, not just in the UI. With an untrusted proxy configuration, use the actual loopback peer rather than attacker-controlled forwarded addresses; this may aggregate clients until the operator deliberately configures a trusted proxy.

Scan only regular files within the real, configured music root, with a fixed audio allowlist (`.flac`, `.mp3`, `.m4a`, `.aac`, `.ogg`, `.opus`, `.wav`, `.aif`, `.aiff`, case-insensitive). Do not traverse symlinks, playlist files, arbitrary device nodes, URLs or paths supplied by clients. Recheck containment and file identity when loading, not merely when scanning. The operator must not make the directory writable by untrusted users. Cap catalog size at 10000 and reject/skip unsupported over-limit input predictably without leaking paths. Scanning is startup work, not a public arbitrary-path HTTP endpoint. The current implementation scans at startup only, visits at most 50000 directory entries and descends at most 12 levels below the root. Total file/entry limit overflow fails startup; deeper directories are skipped. Stop the service before catalog maintenance, and restart to rescan. Metadata is filename-only in this milestone; artist/album/catalog duration remain null. Replaced files receive new track IDs, so old queued references cannot silently play replacement audio.

SQLite and the mpv socket are private to the service account. Put the Unix socket in an owner-only short temporary directory, not a predictable world-writable socket path; use bounded IPC messages, request timeouts, event correlation and owned-child teardown. Only the service's own child is terminated on shutdown. No API accepts raw mpv JSON, shell arguments, executable paths or a device address. Reject OS-root execution for real deployment and bootstrap. No package installation, tests, compilation, server startup or physical-audio check has been performed while authoring this contract.
