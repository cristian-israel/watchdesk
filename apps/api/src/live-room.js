'use strict';

/**
 * Runtime da sala ao vivo: um host (mídia) + viewers.
 */

const MAX_SLOTS = 8;

/**
 * @typedef {{
 *   slug: string,
 *   roomDbId: number,
 *   maxViewers: number,
 *   active: boolean,
 *   host: Client | null,
 *   slots: Set<number>,
 *   viewers: Map<string, Client>,
 * }} RuntimeRoom
 *
 * @typedef {{
 *   ws: { readyState?: number, send?: Function, close?: Function, watchdeskClient?: unknown },
 *   peerId: string,
 *   role: 'host' | 'viewer',
 *   roomSlug: string,
 *   displayName: string,
 *   sessionId?: string,
 *   deviceId?: string,
 * }} Client
 */

/** @param {Map<string, RuntimeRoom>} live */
function ensureLive(live, row) {
  let r = live.get(row.slug);
  if (!r) {
    r = {
      slug: row.slug,
      roomDbId: row.id,
      maxViewers: row.max_viewers,
      active: Boolean(row.active),
      host: null,
      slots: new Set(),
      viewers: new Map(),
    };
    live.set(row.slug, r);
  } else {
    r.roomDbId = row.id;
    r.maxViewers = row.max_viewers;
    r.active = Boolean(row.active);
  }
  return r;
}

function wsSend(ws, msg) {
  if (ws && ws.readyState === 1 && typeof ws.send === 'function') {
    ws.send(JSON.stringify(msg));
  }
}

function slotList(room) {
  return [...room.slots].sort((a, b) => a - b);
}

function roster(room) {
  const list = [];
  if (room.host) {
    list.push({
      peerId: room.host.peerId,
      role: 'host',
      displayName: room.host.displayName,
    });
  }
  for (const v of room.viewers.values()) {
    list.push({
      peerId: v.peerId,
      role: 'viewer',
      displayName: v.displayName,
    });
  }
  return list;
}

function broadcastRoom(room, msg, exceptPeerId = null) {
  if (room.host && room.host.peerId !== exceptPeerId) wsSend(room.host.ws, msg);
  for (const v of room.viewers.values()) {
    if (v.peerId !== exceptPeerId) wsSend(v.ws, msg);
  }
}

function findClient(room, peerId) {
  if (room.host && room.host.peerId === peerId) return room.host;
  return room.viewers.get(peerId) || null;
}

function clearMediaSlots(room) {
  room.slots.clear();
  for (const v of room.viewers.values()) {
    wsSend(v.ws, { type: 'slots', slots: [] });
  }
}

/**
 * Novo host substitui o anterior (kick).
 * @returns {{ kicked: boolean }}
 */
function resolveHostJoin(room, { sessionRole, incomingWs }) {
  if (sessionRole !== 'host') return { kicked: false };
  if (!room.host || room.host.ws === incomingWs) return { kicked: false };

  const prev = room.host;
  try {
    wsSend(prev.ws, { type: 'error', message: 'Outro host entrou nesta sala.' });
    prev.ws.close?.();
  } catch {
    /* ok */
  }
  room.host = null;
  clearMediaSlots(room);
  return { kicked: true };
}

function detachClient(live, client) {
  const room = live.get(client.roomSlug);
  if (!room) return;

  if (client.role === 'host' && room.host && room.host.peerId === client.peerId) {
    room.host = null;
    room.slots.clear();
    for (const v of room.viewers.values()) {
      wsSend(v.ws, { type: 'host_left' });
    }
    broadcastRoom(room, { type: 'roster', members: roster(room) });
    return;
  }

  if (client.role === 'viewer' && room.viewers.has(client.peerId)) {
    room.viewers.delete(client.peerId);
    broadcastRoom(room, {
      type: 'viewer_left',
      peerId: client.peerId,
      displayName: client.displayName,
    });
    broadcastRoom(room, { type: 'roster', members: roster(room) });
  }
}

function kickRole(room, role, reason) {
  if (role !== 'viewer') return;
  const list = [...room.viewers.values()];
  room.viewers.clear();
  for (const v of list) {
    broadcastRoom(room, {
      type: 'viewer_left',
      peerId: v.peerId,
      displayName: v.displayName,
    });
    wsSend(v.ws, { type: 'auth_changed', message: reason });
    try {
      v.ws.watchdeskClient = null;
      v.ws.close?.();
    } catch {
      /* ok */
    }
  }
  if (room.host) {
    wsSend(room.host.ws, { type: 'roster', members: roster(room) });
  }
}

function createTestRoom(slug = 'test') {
  return {
    slug,
    roomDbId: 1,
    maxViewers: 8,
    active: true,
    host: null,
    slots: new Set(),
    viewers: new Map(),
  };
}

function mockWs() {
  const msgs = [];
  return {
    readyState: 1,
    msgs,
    send(raw) {
      msgs.push(JSON.parse(String(raw)));
    },
    close() {
      this.readyState = 3;
    },
  };
}

module.exports = {
  MAX_SLOTS,
  ensureLive,
  wsSend,
  slotList,
  roster,
  broadcastRoom,
  findClient,
  clearMediaSlots,
  resolveHostJoin,
  detachClient,
  kickRole,
  createTestRoom,
  mockWs,
};
