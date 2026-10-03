import { describe, expect, it } from 'vitest'
import { estimatedPosition, formatTime } from '../src/utils/format'
import { playing } from './fixtures'

describe('display-only progress', () => {
  it('interpolates only while connected and playing', () => {
    const player = playing().player
    expect(estimatedPosition(player, 1000, 3500, true)).toBe(17.5)
    expect(estimatedPosition(player, 1000, 3500, false)).toBe(15)
    expect(estimatedPosition({ ...player, status: 'paused' }, 1000, 3500, true)).toBe(15)
    expect(estimatedPosition({ ...player, status: 'loading' }, 1000, 3500, true)).toBe(15)
  })

  it('clamps to duration, never subtracts time and corrects to the next server sample', () => {
    const player = playing().player
    expect(estimatedPosition(player, 1000, 999999, true)).toBe(180)
    expect(estimatedPosition(player, 2000, 1000, true)).toBe(15)
    expect(estimatedPosition({ ...player, positionSeconds: 4 }, 4000, 4500, true)).toBe(4.5)
    expect(estimatedPosition({ ...player, durationSeconds: null }, 0, 1e12, true)).toBe(604800)
  })

  it('distinguishes unknown duration from zero and formats hours', () => {
    expect(formatTime(null)).toBe('—:—')
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(64.7)).toBe('1:04')
    expect(formatTime(3601)).toBe('1:00:01')
  })
})
