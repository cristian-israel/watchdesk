import { describe, expect, it } from 'vitest'
import { KEY_MIN, ROOM_RE } from './room'

describe('room helpers', () => {
  it('valida slug', () => {
    expect(ROOM_RE.test('casa')).toBe(true)
    expect(ROOM_RE.test('bad slug')).toBe(false)
  })

  it('exige 8 caracteres na criação', () => {
    expect(KEY_MIN).toBe(8)
  })
})
