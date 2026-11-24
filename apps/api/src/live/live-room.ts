export const MAX_SLOTS = 8

export type JoinMode = 'open' | 'ask'
export type ClientRole = 'host' | 'viewer' | 'pending'

export type LiveWs = {
  readyState?: number
  send?: (data: string) => void
  close?: () => void
  watchdeskClient?: LiveClient | null
}

export type LiveClient = {
  ws: LiveWs
  peerId: string
  role: ClientRole
  roomSlug: string
  displayName: string
  sessionId?: string
  deviceId?: string
}

export type RuntimeRoom = {
  slug: string
  roomDbId: number
  maxViewers: number
  active: boolean
  joinMode: JoinMode
  host: LiveClient | null
  slots: Set<number>
  viewers: Map<string, LiveClient>
  pending: Map<string, LiveClient>
  admittedDevices: Set<string>
}

export type RoomRow = {
  id: number
  slug: string
  max_viewers: number
  active: number | boolean
  join_mode?: string
}

export function ensureLive(live: Map<string, RuntimeRoom>, row: RoomRow): RuntimeRoom {
  let r = live.get(row.slug)
  const joinMode: JoinMode = row.join_mode === 'open' ? 'open' : 'ask'
  if (!r) {
    r = {
      slug: row.slug,
      roomDbId: row.id,
      maxViewers: row.max_viewers,
      active: Boolean(row.active),
      joinMode,
      host: null,
      slots: new Set(),
      viewers: new Map(),
      pending: new Map(),
      admittedDevices: new Set(),
    }
    live.set(row.slug, r)
  } else {
    r.roomDbId = row.id
    r.maxViewers = row.max_viewers
    r.active = Boolean(row.active)
    r.joinMode = joinMode
  }
  return r
}

export function wsSend(ws: LiveWs | null | undefined, msg: unknown) {
  if (ws && ws.readyState === 1 && typeof ws.send === 'function') {
    ws.send(JSON.stringify(msg))
  }
}

export function slotList(room: RuntimeRoom) {
  return [...room.slots].sort((a, b) => a - b)
}

export function roster(room: RuntimeRoom) {
  const list: { peerId: string; role: string; displayName: string }[] = []
  if (room.host) {
    list.push({
      peerId: room.host.peerId,
      role: 'host',
      displayName: room.host.displayName,
    })
  }
  for (const v of room.viewers.values()) {
    list.push({
      peerId: v.peerId,
      role: 'viewer',
      displayName: v.displayName,
    })
  }
  return list
}

export function pendingList(room: RuntimeRoom) {
  return [...room.pending.values()].map((p) => ({
    peerId: p.peerId,
    displayName: p.displayName,
  }))
}

export function broadcastRoom(room: RuntimeRoom, msg: unknown, exceptPeerId: string | null = null) {
  if (room.host && room.host.peerId !== exceptPeerId) wsSend(room.host.ws, msg)
  for (const v of room.viewers.values()) {
    if (v.peerId !== exceptPeerId) wsSend(v.ws, msg)
  }
}

export function findClient(room: RuntimeRoom, peerId: string) {
  if (room.host && room.host.peerId === peerId) return room.host
  return room.viewers.get(peerId) || room.pending.get(peerId) || null
}

function clearMediaSlots(room: RuntimeRoom) {
  room.slots.clear()
  for (const v of room.viewers.values()) {
    wsSend(v.ws, { type: 'slots', slots: [] })
  }
}

export function resolveHostJoin(
  room: RuntimeRoom,
  opts: { sessionRole: string; incomingWs: LiveWs },
) {
  if (opts.sessionRole !== 'host') return { kicked: false }
  if (!room.host || room.host.ws === opts.incomingWs) return { kicked: false }

  const prev = room.host
  try {
    wsSend(prev.ws, { type: 'error', message: 'Outro host entrou nesta sala.' })
    prev.ws.close?.()
  } catch {
    /* ok */
  }
  room.host = null
  clearMediaSlots(room)
  return { kicked: true }
}

export function promotePending(room: RuntimeRoom, peerId: string) {
  const client = room.pending.get(peerId)
  if (!client) return { ok: false as const, message: 'Pedido não encontrado.' }
  if (room.viewers.size >= room.maxViewers) {
    return { ok: false as const, message: 'Sala cheia.' }
  }

  room.pending.delete(peerId)
  client.role = 'viewer'
  room.viewers.set(peerId, client)
  if (client.deviceId) room.admittedDevices.add(client.deviceId)

  wsSend(client.ws, {
    type: 'admit_result',
    accepted: true,
    slots: slotList(room),
  })
  broadcastRoom(room, { type: 'viewer_joined', peerId, displayName: client.displayName }, peerId)
  broadcastRoom(room, { type: 'roster', members: roster(room) })
  if (room.host) {
    wsSend(room.host.ws, { type: 'pending', pending: pendingList(room) })
  }
  return { ok: true as const, client }
}

export function denyPending(room: RuntimeRoom, peerId: string) {
  const client = room.pending.get(peerId)
  if (!client) return { ok: false as const, message: 'Pedido não encontrado.' }

  room.pending.delete(peerId)
  wsSend(client.ws, {
    type: 'admit_result',
    accepted: false,
    message: 'O host recusou sua entrada.',
  })
  try {
    client.ws.watchdeskClient = null
    client.ws.close?.()
  } catch {
    /* ok */
  }
  if (room.host) {
    wsSend(room.host.ws, { type: 'pending', pending: pendingList(room) })
  }
  return { ok: true as const, client }
}

export function detachClient(live: Map<string, RuntimeRoom>, client: LiveClient) {
  const room = live.get(client.roomSlug)
  if (!room) return

  if (client.role === 'host' && room.host && room.host.peerId === client.peerId) {
    room.host = null
    room.slots.clear()
    for (const v of room.viewers.values()) {
      wsSend(v.ws, { type: 'host_left' })
    }
    for (const p of room.pending.values()) {
      wsSend(p.ws, { type: 'host_left' })
    }
    broadcastRoom(room, { type: 'roster', members: roster(room) })
    return
  }

  if (client.role === 'pending' && room.pending.has(client.peerId)) {
    room.pending.delete(client.peerId)
    if (room.host) {
      wsSend(room.host.ws, { type: 'pending', pending: pendingList(room) })
    }
    return
  }

  if (client.role === 'viewer' && room.viewers.has(client.peerId)) {
    room.viewers.delete(client.peerId)
    broadcastRoom(room, {
      type: 'viewer_left',
      peerId: client.peerId,
      displayName: client.displayName,
    })
    broadcastRoom(room, { type: 'roster', members: roster(room) })
  }
}

export function kickRole(room: RuntimeRoom, role: string, reason: string) {
  if (role !== 'viewer') return
  const list = [...room.viewers.values()]
  room.viewers.clear()
  room.admittedDevices.clear()
  for (const v of list) {
    broadcastRoom(room, {
      type: 'viewer_left',
      peerId: v.peerId,
      displayName: v.displayName,
    })
    wsSend(v.ws, { type: 'auth_changed', message: reason })
    try {
      v.ws.watchdeskClient = null
      v.ws.close?.()
    } catch {
      /* ok */
    }
  }
  for (const p of [...room.pending.values()]) {
    room.pending.delete(p.peerId)
    wsSend(p.ws, { type: 'auth_changed', message: reason })
    try {
      p.ws.watchdeskClient = null
      p.ws.close?.()
    } catch {
      /* ok */
    }
  }
  if (room.host) {
    wsSend(room.host.ws, { type: 'roster', members: roster(room) })
    wsSend(room.host.ws, { type: 'pending', pending: [] })
  }
}

export function createTestRoom(slug = 'test'): RuntimeRoom {
  return {
    slug,
    roomDbId: 1,
    maxViewers: 8,
    active: true,
    joinMode: 'ask',
    host: null,
    slots: new Set(),
    viewers: new Map(),
    pending: new Map(),
    admittedDevices: new Set(),
  }
}

export function mockWs() {
  const msgs: unknown[] = []
  return {
    readyState: 1,
    msgs,
    send(raw: string) {
      msgs.push(JSON.parse(String(raw)))
    },
    close() {
      this.readyState = 3
    },
  }
}
