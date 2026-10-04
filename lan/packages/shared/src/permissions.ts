import type { PublicUser, QueueEntry, Role } from './schemas.js'

export const canControlPlayback = (role: Role) => role === 'admin' || role === 'dj'
export const canManageUsers = (role: Role) => role === 'admin'

// The server must first look up the entry in the authoritative WAITING queue.
// This presentation helper cannot authorize removing a current or historical entry.
export const canRemoveWaitingEntry = (user: PublicUser, entry: QueueEntry) => {
  return canControlPlayback(user.role) || entry.requester.id === user.id
}
