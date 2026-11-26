import { describe, expect, it } from 'vitest'
import { formatRemaining, roomProgress } from '@/lib/api'

describe('room progress helpers', () => {
  it('calcula restante e percentual', () => {
    const createdAt = new Date(Date.now() - 5 * 60_000).toISOString()
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
    const prog = roomProgress({ createdAt, expiresAt })
    expect(prog.totalMs).toBeGreaterThan(0)
    expect(prog.remainingMs).toBeGreaterThan(0)
    expect(prog.pct).toBeGreaterThan(40)
    expect(prog.pct).toBeLessThan(60)
    expect(formatRemaining(90_000)).toMatch(/1m/)
  })
})
