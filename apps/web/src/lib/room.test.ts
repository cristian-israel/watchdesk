import { describe, expect, it } from 'vitest'
import { KEY_MIN, ROOM_RE, inviteKeyFromHash, parseInviteInput, viewerInviteUrl } from './room'

describe('room', () => {
  it('valida slug', () => {
    expect(ROOM_RE.test('casa')).toBe(true)
    expect(ROOM_RE.test('a7K2m9xq_1-2')).toBe(true)
    expect(ROOM_RE.test('bad slug')).toBe(false)
  })

  it('KEY_MIN é 8', () => {
    expect(KEY_MIN).toBe(8)
  })

  it('lê k do hash', () => {
    expect(inviteKeyFromHash('#k=segredo')).toBe('segredo')
    expect(inviteKeyFromHash('#k=a%2Fb')).toBe('a/b')
    expect(inviteKeyFromHash('')).toBe('')
  })

  it('monta url de convite', () => {
    expect(viewerInviteUrl('abc', 'chave', 'https://ex.com')).toBe('https://ex.com/sala/abc#k=chave')
    expect(viewerInviteUrl('abc', '', 'https://ex.com')).toBe('https://ex.com/sala/abc')
  })

  it('parseia link ou id', () => {
    expect(parseInviteInput('https://ex.com/sala/xyz#k=tok', 'https://ex.com')).toEqual({
      slug: 'xyz',
      key: 'tok',
    })
    expect(parseInviteInput('/sala/xyz#k=tok', 'https://ex.com')).toEqual({
      slug: 'xyz',
      key: 'tok',
    })
    expect(parseInviteInput('xyz', 'https://ex.com')).toEqual({ slug: 'xyz', key: '' })
    expect(parseInviteInput('inválido!', 'https://ex.com')).toBeNull()
  })
})
