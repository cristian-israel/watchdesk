export const MAX_SLOTS = 19

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
  muted: boolean
  forceMuted: boolean
}

export type VoicePeerState = {
  peerId: string
  muted: boolean
  forceMuted: boolean
}

export type SlotInfo = {
  slot: number
  peerId: string
  displayName: string
}

export type RuntimeRoom = {
  slug: string
  roomDbId: number
  maxViewers: number
  active: boolean
  joinMode: JoinMode
  voiceEnabled: boolean
  host: LiveClient | null
  /** slot → publisher peerId */
  slotOwners: Map<number, string>
  /** viewers allowed to publish screen */
  screenAllowed: Set<string>
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
  voice_enabled?: number | boolean
}

export function ensureLive(live: Map<string, RuntimeRoom>, row: RoomRow): RuntimeRoom {
  let r = live.get(row.slug)
  const joinMode: JoinMode = row.join_mode === 'open' ? 'open' : 'ask'
  const voiceEnabled = Boolean(row.voice_enabled)
  if (!r) {
    r = {
      slug: row.slug,
      roomDbId: row.id,
      maxViewers: row.max_viewers,
      active: Boolean(row.active),
      joinMode,
      voiceEnabled,
      host: null,
      slotOwners: new Map(),
      screenAllowed: new Set(),
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
    r.voiceEnabled = voiceEnabled
  }
  return r
}

export function wsSend(ws: LiveWs | null | undefined, msg: unknown) {
  if (ws && ws.readyState === 1 && typeof ws.send === 'function') {
    ws.send(JSON.stringify(msg))
  }
}

export function slotList(room: RuntimeRoom): SlotInfo[] {
  const list: SlotInfo[] = []
  for (const [slot, peerId] of room.slotOwners) {
    const client = findClient(room, peerId)
    list.push({
      slot,
      peerId,
      displayName: client?.displayName || peerId,
    })
  }
  return list.sort((a, b) => a.slot - b.slot)
}

export function canPublishScreen(room: RuntimeRoom, client: LiveClient) {
  if (client.role === 'host') return true
  if (client.role === 'viewer') return room.screenAllowed.has(client.peerId)
  return false
}

export function claimSlot(room: RuntimeRoom, slot: number, client: LiveClient) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) {
    return { ok: false as const, message: 'Slot inválido.' }
  }
  if (!canPublishScreen(room, client)) {
    return { ok: false as const, message: 'Sem permissão para compartilhar tela.' }
  }
  const owner = room.slotOwners.get(slot)
  if (owner && owner !== client.peerId) {
    return { ok: false as const, message: 'Slot ocupado.' }
  }
  room.slotOwners.set(slot, client.peerId)
  return { ok: true as const }
}

export function releaseSlot(room: RuntimeRoom, slot: number, client: LiveClient) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) {
    return { ok: false as const, message: 'Slot inválido.' }
  }
  const owner = room.slotOwners.get(slot)
  if (!owner) return { ok: true as const }
  if (owner !== client.peerId && client.role !== 'host') {
    return { ok: false as const, message: 'Só o dono ou o host pode liberar o slot.' }
  }
  room.slotOwners.delete(slot)
  return { ok: true as const }
}

export function releaseSlotsOf(room: RuntimeRoom, peerId: string) {
  for (const [slot, owner] of [...room.slotOwners]) {
    if (owner === peerId) room.slotOwners.delete(slot)
  }
}

export function setScreenAllow(room: RuntimeRoom, peerId: string, allow: boolean) {
  const target = findClient(room, peerId)
  if (!target || target.role !== 'viewer') {
    return { ok: false as const, message: 'Espectador não encontrado.' }
  }
  if (allow) room.screenAllowed.add(peerId)
  else {
    room.screenAllowed.delete(peerId)
    releaseSlotsOf(room, peerId)
  }
  return { ok: true as const, target }
}

/** Screen: offer only from slot owner to another admitted; answer/ice either way on that pair. */
export function canRelayScreen(
  room: RuntimeRoom,
  from: LiveClient,
  to: LiveClient,
  slot: number,
  msgType: 'offer' | 'answer' | 'ice',
) {
  if (!isAdmittedRole(from.role) || !isAdmittedRole(to.role)) return false
  if (from.peerId === to.peerId) return false
  const owner = room.slotOwners.get(slot)
  if (owner === undefined) return false
  if (msgType === 'offer') return from.peerId === owner
  return from.peerId === owner || to.peerId === owner
}

export function roster(room: RuntimeRoom) {
  const list: { peerId: string; role: string; displayName: string; deviceId?: string }[] = []
  if (room.host) {
    list.push({
      peerId: room.host.peerId,
      role: 'host',
      displayName: room.host.displayName,
      deviceId: room.host.deviceId,
    })
  }
  for (const v of room.viewers.values()) {
    list.push({
      peerId: v.peerId,
      role: 'viewer',
      displayName: v.displayName,
      deviceId: v.deviceId,
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

export function admittedClients(room: RuntimeRoom): LiveClient[] {
  const list: LiveClient[] = []
  if (room.host) list.push(room.host)
  for (const v of room.viewers.values()) list.push(v)
  return list
}

export function voiceState(room: RuntimeRoom): VoicePeerState[] {
  return admittedClients(room).map((c) => ({
    peerId: c.peerId,
    muted: c.muted,
    forceMuted: c.forceMuted,
  }))
}

export function resetVoiceMutes(room: RuntimeRoom) {
  for (const c of admittedClients(room)) {
    c.muted = true
    c.forceMuted = false
  }
}

export function isAdmittedRole(role: ClientRole) {
  return role === 'host' || role === 'viewer'
}

/** Voice mesh: any admitted pair when voice is on. */
export function canRelaySignal(
  room: RuntimeRoom,
  from: LiveClient,
  to: LiveClient,
  channel: 'voice',
) {
  if (!isAdmittedRole(from.role) || !isAdmittedRole(to.role)) return false
  if (channel === 'voice') {
    if (!room.voiceEnabled) return false
    return from.peerId !== to.peerId
  }
  return false
}

export function applySelfMute(client: LiveClient, muted: boolean) {
  if (client.forceMuted) return { ok: false as const, reason: 'force_muted' as const }
  client.muted = muted
  return { ok: true as const }
}

export function applyHostMute(room: RuntimeRoom, targetPeerId: string, muted: boolean) {
  const target = findClient(room, targetPeerId)
  if (!target || !isAdmittedRole(target.role)) {
    return { ok: false as const, message: 'Participante não encontrado.' }
  }
  target.forceMuted = muted
  if (muted) target.muted = true
  return { ok: true as const, target }
}

function clearMediaSlots(room: RuntimeRoom) {
  room.slotOwners.clear()
  broadcastRoom(room, { type: 'slots', slots: [] })
}

export function demoteHostToViewer(room: RuntimeRoom, message: string) {
  const prev = room.host
  if (!prev) return { ok: false as const }
  room.host = null
  clearMediaSlots(room)
  prev.role = 'viewer'
  room.viewers.set(prev.peerId, prev)
  wsSend(prev.ws, {
    type: 'role_changed',
    role: 'viewer',
    message,
  })
  broadcastRoom(room, { type: 'roster', members: roster(room) })
  broadcastRoom(room, { type: 'slots', slots: slotList(room) })
  if (room.voiceEnabled) {
    broadcastRoom(room, { type: 'voice_state', peers: voiceState(room) })
  }
  return { ok: true as const, client: prev }
}

export function promoteViewerToHost(room: RuntimeRoom, deviceId: string, displayName?: string) {
  if (room.host?.deviceId === deviceId) {
    if (displayName) room.host.displayName = displayName
    return { ok: true as const, already: true as const }
  }
  const viewer = [...room.viewers.values()].find((v) => v.deviceId === deviceId)
  if (!viewer) return { ok: false as const, message: 'Participante não está na sala.' }

  if (room.host) {
    demoteHostToViewer(room, 'O dono designou outro controlador.')
  }

  room.viewers.delete(viewer.peerId)
  viewer.role = 'host'
  if (displayName) viewer.displayName = displayName
  room.host = viewer
  clearMediaSlots(room)
  wsSend(viewer.ws, {
    type: 'role_changed',
    role: 'host',
    message: 'Você foi designado como controlador.',
  })
  broadcastRoom(room, { type: 'roster', members: roster(room) })
  broadcastRoom(room, { type: 'slots', slots: slotList(room) })
  if (room.voiceEnabled) {
    broadcastRoom(room, { type: 'voice_state', peers: voiceState(room) })
  }
  return { ok: true as const, already: false as const, client: viewer }
}

export function resolveHostJoin(
  room: RuntimeRoom,
  opts: { sessionRole: string; incomingWs: LiveWs; takeoverMessage?: string },
) {
  if (opts.sessionRole !== 'host') return { kicked: false }
  if (!room.host || room.host.ws === opts.incomingWs) return { kicked: false }

  demoteHostToViewer(
    room,
    opts.takeoverMessage || 'O dono assumiu o controle da sala.',
  )
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
    room.slotOwners.clear()
    room.screenAllowed.clear()
    for (const v of room.viewers.values()) {
      wsSend(v.ws, { type: 'host_left' })
    }
    for (const p of room.pending.values()) {
      wsSend(p.ws, { type: 'host_left' })
    }
    broadcastRoom(room, { type: 'roster', members: roster(room) })
    broadcastRoom(room, { type: 'slots', slots: [] })
    if (room.voiceEnabled) {
      broadcastRoom(room, { type: 'voice_state', peers: voiceState(room) })
    }
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
    room.screenAllowed.delete(client.peerId)
    releaseSlotsOf(room, client.peerId)
    broadcastRoom(room, {
      type: 'viewer_left',
      peerId: client.peerId,
      displayName: client.displayName,
    })
    broadcastRoom(room, { type: 'roster', members: roster(room) })
    broadcastRoom(room, { type: 'slots', slots: slotList(room) })
    if (room.voiceEnabled) {
      broadcastRoom(room, { type: 'voice_state', peers: voiceState(room) })
    }
  }
}

export function kickViewer(room: RuntimeRoom, peerId: string, reason: string) {
  const viewer = room.viewers.get(peerId)
  if (!viewer) return { ok: false as const, message: 'Espectador não encontrado.' }

  room.viewers.delete(peerId)
  if (viewer.deviceId) room.admittedDevices.delete(viewer.deviceId)
  room.screenAllowed.delete(peerId)
  releaseSlotsOf(room, peerId)

  broadcastRoom(room, {
    type: 'viewer_left',
    peerId: viewer.peerId,
    displayName: viewer.displayName,
  })
  broadcastRoom(room, { type: 'roster', members: roster(room) })
  broadcastRoom(room, { type: 'slots', slots: slotList(room) })
  if (room.voiceEnabled) {
    broadcastRoom(room, { type: 'voice_state', peers: voiceState(room) })
  }

  wsSend(viewer.ws, { type: 'auth_changed', message: reason })
  try {
    viewer.ws.watchdeskClient = null
    viewer.ws.close?.()
  } catch {
    /* ok */
  }

  return { ok: true as const, client: viewer }
}

export function kickRole(room: RuntimeRoom, role: string, reason: string) {
  if (role !== 'viewer') return
  const list = [...room.viewers.values()]
  room.viewers.clear()
  room.admittedDevices.clear()
  room.screenAllowed.clear()
  for (const [slot, owner] of [...room.slotOwners]) {
    if (!room.host || owner !== room.host.peerId) room.slotOwners.delete(slot)
  }
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
    wsSend(room.host.ws, { type: 'slots', slots: slotList(room) })
  }
}

export function createTestRoom(slug = 'test'): RuntimeRoom {
  return {
    slug,
    roomDbId: 1,
    maxViewers: 8,
    active: true,
    joinMode: 'ask',
    voiceEnabled: false,
    host: null,
    slotOwners: new Map(),
    screenAllowed: new Set(),
    viewers: new Map(),
    pending: new Map(),
    admittedDevices: new Set(),
  }
}

export function testClient(
  partial: Omit<LiveClient, 'muted' | 'forceMuted'> &
    Partial<Pick<LiveClient, 'muted' | 'forceMuted'>>,
): LiveClient {
  return {
    muted: true,
    forceMuted: false,
    ...partial,
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
