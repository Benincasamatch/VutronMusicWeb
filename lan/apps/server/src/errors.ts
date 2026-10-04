import { ERROR_HTTP_STATUS, type ErrorCode } from '@lan/shared'

const messages: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Invalid request',
  UNAUTHENTICATED: 'Authentication required or credentials incorrect',
  FORBIDDEN: 'This operation is not permitted',
  ORIGIN_REJECTED: 'Request origin or host is not permitted',
  CSRF_INVALID: 'Session verification failed',
  RATE_LIMITED: 'Too many requests or active sessions',
  NOT_FOUND: 'Requested item not found',
  INSTANCE_CONFLICT: 'The server restarted. Refresh state before a new action',
  REVISION_CONFLICT: 'Shared state changed. Refresh before a new action',
  PLAYBACK_CONFLICT: 'Current playback changed or is unavailable',
  REQUEST_ID_REUSED: 'Request ID was already used for different input',
  QUEUE_FULL: 'The waiting queue or your waiting-entry allowance is full',
  TRACK_UNAVAILABLE: 'The selected local file is no longer available',
  PLAYER_UNAVAILABLE: 'The physical player is unavailable',
  PLAYBACK_FAILED: 'The physical player could not complete playback',
  USERNAME_TAKEN: 'Username is already in use',
  LAST_ADMIN: 'At least one administrator must remain',
  USER_LIMIT: 'The account limit has been reached',
  INTERNAL_ERROR: 'The server could not complete the request'
}

export class AppError extends Error {
  readonly statusCode: number

  constructor(readonly code: ErrorCode) {
    super(messages[code])
    this.statusCode = ERROR_HTTP_STATUS[code]
  }
}

export const fail = (code: ErrorCode): never => {
  throw new AppError(code)
}
