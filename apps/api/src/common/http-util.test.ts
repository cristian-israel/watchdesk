import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROOM_RE,
  cookieHeader,
  createRateLimiter,
  hashEqHex,
  iceServers,
  normalizeName,
  originAllowed,
  parseCookies,
  shaHex,
  validateKey,
} from './http-util'

describe('http-util', () => {
  it('ROOM_RE aceita slug válido', () => {
    assert.equal(ROOM_RE.test('abc_12-XY'), true)
    assert.equal(ROOM_RE.test('inválido!'), false)
  })

  it('hashEqHex compara hashes de mesmo tamanho', () => {
    const a = shaHex('x')
    assert.equal(hashEqHex(a, a), true)
    assert.equal(hashEqHex(a, shaHex('y')), false)
  })

  it('normalizeName trim e limite', () => {
    assert.equal(normalizeName('  Cris  '), 'Cris')
    assert.equal(normalizeName(''), null)
  })

  it('validateKey: criação mín. 8, login mín. 4', () => {
    assert.equal(validateKey('12345678'), true)
    assert.equal(validateKey('1234', 4), true)
    assert.equal(validateKey('123'), false)
  })

  it('parseCookies decodifica e ignora valor quebrado', () => {
    const req = { headers: { cookie: 'a=1; b=%E0%A4%A; c=ok' } } as never
    const out = parseCookies(req)
    assert.equal(out.a, '1')
    assert.equal(out.c, 'ok')
  })

  it('cookieHeader inclui Secure só em https', () => {
    const httpReq = { headers: {} } as never
    const httpsReq = { headers: { 'x-forwarded-proto': 'https' } } as never
    assert.equal(cookieHeader('x', '1', 10, httpReq).includes('Secure'), false)
    assert.equal(cookieHeader('x', '1', 10, httpsReq).includes('Secure'), true)
  })

  it('rate limiter bloqueia após 8 falhas', () => {
    const { blocked, noteFailure } = createRateLimiter({ max: 8 })
    for (let i = 0; i < 8; i++) noteFailure('1.1.1.1')
    assert.equal(blocked('1.1.1.1'), true)
    assert.equal(blocked('2.2.2.2'), false)
  })

  it('iceServers só STUN sem secret', () => {
    const servers = iceServers({
      turnSecret: '',
      turnHost: '',
      publicHost: '',
      turnPort: 3478,
    })
    assert.equal(servers.length, 1)
  })

  it('iceServers inclui TURN com secret e host', () => {
    const servers = iceServers({
      turnSecret: 'secret',
      turnHost: 'turn.example',
      publicHost: '',
      turnPort: 3478,
    })
    assert.equal(servers.length, 2)
  })

  it('originAllowed: localhost, mesmo host, sem origin', () => {
    assert.equal(originAllowed({ headers: {} } as never), true)
    assert.equal(
      originAllowed({ headers: { origin: 'http://localhost:7130', host: 'localhost:7030' } } as never),
      true,
    )
  })

  it('originAllowed: X-Forwarded-Host quando Host é FRONTIER_ALIAS', () => {
    assert.equal(
      originAllowed({
        headers: {
          origin: 'https://watchdesk.example',
          host: 'watchdesk',
          'x-forwarded-host': 'watchdesk.example',
        },
      } as never),
      true,
    )
  })
})
