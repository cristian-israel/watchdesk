export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string; code?: string; data?: unknown }> {
  try {
    const r = await fetch(path, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    })
    const text = await r.text()
    let data: unknown = null
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = text
      }
    }
    if (!r.ok) {
      const message =
        typeof data === 'string'
          ? data
          : data && typeof data === 'object' && 'message' in data
            ? String((data as { message: unknown }).message)
            : text || `Erro ${r.status}`
      const code =
        data && typeof data === 'object' && 'code' in data
          ? String((data as { code: unknown }).code)
          : undefined
      return { ok: false, status: r.status, message, code, data }
    }
    return { ok: true, data: data as T }
  } catch {
    return { ok: false, status: 0, message: 'Falha de rede.' }
  }
}

export async function apiOrThrow<T = unknown>(path: string, init: RequestInit = {}) {
  const res = await api<T>(path, init)
  if (!res.ok) {
    const err = new Error(res.message) as Error & { status?: number; code?: string; data?: unknown }
    err.status = res.status
    err.code = res.code
    err.data = res.data
    throw err
  }
  return res.data
}

export type JoinMode = 'open' | 'ask'
export type RoomStatus = 'active' | 'expired' | 'ended'
export type UserRole = 'admin' | 'user'

export type AuthUser = {
  id: number
  login: string
  displayName: string
  role: UserRole
  active: boolean
}

export type DeviceRoom = {
  slug: string
  active: boolean
  status: RoomStatus
  maxViewers: number
  capacity: number
  joinMode: JoinMode
  voiceEnabled: boolean
  links: string[]
  createdAt: string
  expiresAt: string | null
  designatedDeviceId: string | null
  designatedDisplayName: string | null
  hasControllerPassword: boolean
  controllerPassword?: string
}

export type Me = {
  deviceId: string
  displayName: string
  user: AuthUser | null
  rooms: DeviceRoom[]
  slots: { used: number; max: number }
}

export type SessionInfo = {
  ok: boolean
  room: string
  role: 'host' | 'viewer'
  displayName: string
  active: boolean
  maxViewers: number
  joinMode: JoinMode
  voiceEnabled: boolean
  links: string[]
  expiresAt?: string | null
  createdAt?: string | null
  status?: 'pending' | 'admitted'
  asOwner?: boolean
  roomSummary?: DeviceRoom
}

export function roomProgress(room: Pick<DeviceRoom, 'createdAt' | 'expiresAt'>) {
  if (!room.expiresAt) return { pct: 0, remainingMs: 0, totalMs: 0 }
  const start = new Date(room.createdAt).getTime()
  const end = new Date(room.expiresAt).getTime()
  const now = Date.now()
  const totalMs = Math.max(1, end - start)
  const remainingMs = Math.max(0, end - now)
  const pct = Math.min(100, Math.max(0, (remainingMs / totalMs) * 100))
  return { pct, remainingMs, totalMs }
}

export function formatRemaining(ms: number) {
  const sec = Math.ceil(ms / 1000)
  if (sec <= 0) return '0m'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}
