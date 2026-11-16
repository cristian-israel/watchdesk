export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number; message: string }> {
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
      return { ok: false, status: r.status, message }
    }
    return { ok: true, data: data as T }
  } catch {
    return { ok: false, status: 0, message: 'Falha de rede.' }
  }
}

export type DeviceRoom = {
  slug: string
  active: boolean
  maxViewers: number
  links: string[]
}

export type Me = {
  displayName: string
  room: DeviceRoom | null
}

export type SessionInfo = {
  ok: boolean
  room: string
  role: 'host' | 'viewer'
  displayName: string
  active: boolean
  maxViewers: number
  links: string[]
}
