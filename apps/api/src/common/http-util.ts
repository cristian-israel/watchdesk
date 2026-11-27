import crypto from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Request, Response } from 'express'

export const ROOM_RE = /^[a-zA-Z0-9_-]{1,40}$/
export const NAME_MIN = 2
export const NAME_MAX = 32
export const NAME_RE = new RegExp(`^.{${NAME_MIN},${NAME_MAX}}$`)
/** Login de conta: apelido curto ou e-mail (aceita @ e .). */
export const LOGIN_MIN = 3
export const LOGIN_MAX = 254
export const LOGIN_RE = new RegExp(
  `^[a-zA-Z0-9._+-]{1,64}(?:@[a-zA-Z0-9.-]{1,253}\\.[a-zA-Z]{2,})?$`,
)

export const KEY_MAX = 128
export const KEY_MIN_CREATE = 8
export const KEY_MIN_LOGIN = 4
export const WS_MAX_PAYLOAD = 256 * 1024
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const AUTH_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const DEVICE_TTL_SEC = 365 * 24 * 60 * 60
export const ICE_TTL_SEC = 3600
export const RECENT_LIMIT = 10
export const CHAT_HISTORY = 100
export const CHAT_MAX = 500
export const TTL_MIN_MINUTES = 5
export const TTL_MAX_MINUTES = 24 * 60
export const TTL_DEFAULT_MINUTES = 10
export const SLOTS_USER = 2
export const SLOTS_ADMIN = 10
export const CAPACITY_USER = 10
export const CAPACITY_ADMIN = 20

export function shaHex(s: string) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 32).toString('hex')
  return `scrypt$${salt}$${hash}`
}

export function verifyPassword(password: string, stored: string) {
  const [algo, salt, hash] = String(stored || '').split('$')
  if (algo !== 'scrypt' || !salt || !hash) return false
  const next = crypto.scryptSync(password, salt, 32).toString('hex')
  return hashEqHex(next, hash)
}

export function randomControllerPassword() {
  return crypto.randomBytes(6).toString('base64url').slice(0, 10)
}

export function clampTtlMinutes(value: unknown, fallback = TTL_DEFAULT_MINUTES) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const rounded = Math.round(n)
  if (rounded < TTL_MIN_MINUTES) return TTL_MIN_MINUTES
  if (rounded > TTL_MAX_MINUTES) return TTL_MAX_MINUTES
  return rounded
}

export function capacityForRole(role: string) {
  return role === 'admin' ? CAPACITY_ADMIN : CAPACITY_USER
}

export function slotsForRole(role: string) {
  return role === 'admin' ? SLOTS_ADMIN : SLOTS_USER
}

export function maxViewersForCapacity(capacity: number) {
  return Math.max(1, capacity - 1)
}

export function hashEqHex(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
  } catch {
    return false
  }
}

export function normalizeName(name: unknown): string | null {
  const n = String(name || '').trim()
  if (!NAME_RE.test(n)) return null
  return n
}

export function nameLengthMessage() {
  return `Apelido: ${NAME_MIN} a ${NAME_MAX} caracteres.`
}

export function validateKey(key: unknown, min = KEY_MIN_CREATE) {
  return typeof key === 'string' && key.length >= min && key.length <= KEY_MAX
}

export function isDeviceId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id)
}

export function clientIp(req: IncomingMessage | Request) {
  const xf = String(req.headers['x-forwarded-for'] || '')
  const fromHeader = xf.split(',')[0].trim()
  const remote = 'socket' in req ? req.socket?.remoteAddress : undefined
  return (fromHeader || remote || '').slice(0, 64)
}

export function parseCookies(req: IncomingMessage | Request): Record<string, string> {
  const raw = req.headers.cookie || ''
  const out: Record<string, string> = {}
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (!k) continue
    try {
      out[k] = decodeURIComponent(v)
    } catch {
      out[k] = v
    }
  }
  return out
}

function isSecureReq(req: IncomingMessage | Request) {
  const xf = String(req.headers['x-forwarded-proto'] || '')
  return xf.split(',')[0].trim() === 'https'
}

export function cookieHeader(
  name: string,
  value: string,
  maxAge: number,
  req: IncomingMessage | Request,
) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (isSecureReq(req)) parts.push('Secure')
  return parts.join('; ')
}

export function appendSetCookie(res: Response, cookie: string) {
  const prev = res.getHeader('Set-Cookie')
  if (!prev) res.setHeader('Set-Cookie', cookie)
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, cookie])
  else res.setHeader('Set-Cookie', [String(prev), cookie])
}

export function setSessionCookie(res: Response, token: string, req: Request) {
  appendSetCookie(res, cookieHeader('wd_session', token, Math.floor(SESSION_TTL_MS / 1000), req))
}

export function clearSessionCookie(res: Response, req: Request) {
  appendSetCookie(res, cookieHeader('wd_session', '', 0, req))
}

export function setDeviceCookie(res: Response, id: string, req: Request) {
  appendSetCookie(res, cookieHeader('wd_device', id, DEVICE_TTL_SEC, req))
}

export function setAuthCookie(res: Response, token: string, req: Request) {
  appendSetCookie(res, cookieHeader('wd_auth', token, Math.floor(AUTH_TTL_MS / 1000), req))
}

export function clearAuthCookie(res: Response, req: Request) {
  appendSetCookie(res, cookieHeader('wd_auth', '', 0, req))
}

export function createRateLimiter({ windowMs = 60_000, max = 8 } = {}) {
  const failures = new Map<string, number[]>()
  function blocked(ip: string) {
    const now = Date.now()
    const list = (failures.get(ip) || []).filter((t) => now - t < windowMs)
    failures.set(ip, list)
    return list.length >= max
  }
  function noteFailure(ip: string) {
    const list = failures.get(ip) || []
    list.push(Date.now())
    failures.set(ip, list)
  }
  return { blocked, noteFailure }
}

export type IceServer = {
  urls: string | string[]
  username?: string
  credential?: string
}

export function iceServers(
  opts: { turnSecret: string; turnHost: string; publicHost: string; turnPort: number },
  userId = 'anon',
  ttlSec = ICE_TTL_SEC,
): IceServer[] {
  const servers: IceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]
  const host = opts.turnHost || opts.publicHost
  if (opts.turnSecret && host) {
    const expiry = Math.floor(Date.now() / 1000) + ttlSec
    const username = `${expiry}:${userId}`
    const credential = crypto.createHmac('sha1', opts.turnSecret).update(username).digest('base64')
    const base = `${host}:${opts.turnPort}`
    servers.push({
      urls: [`turn:${base}?transport=udp`, `turn:${base}?transport=tcp`],
      username,
      credential,
    })
  }
  return servers
}

function forwardedHost(req: IncomingMessage | Request) {
  const raw = String(req.headers['x-forwarded-host'] || '')
    .split(',')[0]
    .trim()
  return raw.split(':')[0]
}

export function originAllowed(req: IncomingMessage | Request, publicHost = '') {
  const origin = String(req.headers.origin || '')
  if (!origin || origin === 'null') return true
  let hostname: string
  try {
    hostname = new URL(origin).hostname
  } catch {
    return false
  }
  if (!hostname) return true
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true
  const host = String(req.headers.host || '').split(':')[0]
  if (hostname === host) return true
  const xfHost = forwardedHost(req)
  if (xfHost && hostname === xfHost) return true
  if (publicHost && hostname === publicHost) return true
  return false
}

export function randomSlug() {
  return crypto.randomBytes(9).toString('base64url').slice(0, 12)
}

export function viewerLinks(slug: string) {
  return [`/sala/${slug}`]
}

export function normalizeJoinMode(value: unknown): 'open' | 'ask' {
  return value === 'open' ? 'open' : 'ask'
}

export function plainError(message: string, status = 400) {
  return { statusCode: status, message }
}
