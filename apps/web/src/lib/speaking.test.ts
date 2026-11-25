import { describe, expect, it } from 'vitest'
import { SPEAK_HOLD_MS, SPEAK_OFF, SPEAK_ON, isSpeaking, rmsFromTimeDomain } from './speaking'

describe('isSpeaking', () => {
  it('liga acima do threshold', () => {
    expect(isSpeaking(SPEAK_ON, false, 0, 1000)).toBe(true)
    expect(isSpeaking(SPEAK_ON - 0.001, false, 0, 1000)).toBe(false)
  })

  it('mantém com hysteresis e hold', () => {
    expect(isSpeaking(SPEAK_OFF, true, 900, 1000)).toBe(true)
    expect(isSpeaking(SPEAK_OFF - 0.001, true, 900, 1000)).toBe(true)
    expect(isSpeaking(0, true, 900, 900 + SPEAK_HOLD_MS)).toBe(false)
  })
})

describe('rmsFromTimeDomain', () => {
  it('silêncio → ~0', () => {
    const data = new Uint8Array(4).fill(128)
    expect(rmsFromTimeDomain(data)).toBe(0)
  })

  it('amplitude alta → > 0', () => {
    const data = new Uint8Array([0, 255, 0, 255])
    expect(rmsFromTimeDomain(data)).toBeGreaterThan(0.5)
  })
})
