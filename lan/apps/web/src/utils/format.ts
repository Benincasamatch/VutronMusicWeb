import { LIMITS } from '@lan/shared'
import type { Player, Role } from '@lan/shared'

export const roleLabels: Record<Role, string> = {
  admin: '管理员',
  dj: '主持人',
  user: '听众'
}

export function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—:—'
  const value = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const rest = String(value % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

export function estimatedPosition(player: Player, sampledAt: number, now: number, connected: boolean): number {
  const elapsed = connected && player.status === 'playing' ? Math.max(0, now - sampledAt) / 1000 : 0
  return Math.max(0, Math.min(
    player.positionSeconds + elapsed,
    player.durationSeconds ?? LIMITS.maxDurationSeconds,
    LIMITS.maxDurationSeconds
  ))
}
