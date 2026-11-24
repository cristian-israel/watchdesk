import { describe, expect, it } from 'vitest'
import { ROOM_RE, parseInviteInput, viewerInviteUrl } from './room'

describe('ROOM_RE', () => {
  it('aceita slug opaco', () => {
    expect(ROOM_RE.test('abc_12-XY')).toBe(true)
    expect(ROOM_RE.test('inválido!')).toBe(false)
  })
})

describe('viewerInviteUrl', () => {
  it('monta só o path da sala', () => {
    expect(viewerInviteUrl('abc', 'https://ex.com')).toBe('https://ex.com/sala/abc')
  })
})

describe('parseInviteInput', () => {
  it('parseia link, path ou id', () => {
    expect(parseInviteInput('https://ex.com/sala/xyz', 'https://ex.com')).toEqual({ slug: 'xyz' })
    expect(parseInviteInput('/sala/xyz', 'https://ex.com')).toEqual({ slug: 'xyz' })
    expect(parseInviteInput('xyz', 'https://ex.com')).toEqual({ slug: 'xyz' })
    expect(parseInviteInput('inválido!', 'https://ex.com')).toBeNull()
  })
})
