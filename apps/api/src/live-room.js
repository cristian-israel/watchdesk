'use strict';

/**
 * Runtime da sala ao vivo: transmitter (host), controllers (panels), viewers.
 * HTTP sessions continuam role=host|viewer; aqui o wire ganha seat + compat.
 */

const MAX_SLOTS = 8;

/**
 * @typedef {{
 *   slug: string,
 *   roomDbId: number,
 *   maxViewers: number,
 *   active: boolean,
 *   host: Client | null,
 *   panels: Map<string, Client>,
 *   slots: Set<number>,
 *   viewers: Map<string, Client>,
 *   pilotPeerId: string | null,
 *   transmitMode: 'web' | 'companion',
 * }} RuntimeRoom
 *
 * @typedef {{
 *   ws: { readyState?: number, send?: Function, close?: Function, watchdeskClient?: unknown },
 *   peerId: string,
 *   role: 'host' | 'viewer' | 'panel',
 *   roomSlug: string,
 *   displayName: string,
 *   sessionId?: string,
 *   deviceId?: string,
 *   controlMode: 'view' | 'interact',
 *   clientKind: 'web' | 'companion',
 *   companionVersion?: string,
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
      panels: new Map(),
      slots: new Set(),
      viewers: new Map(),
      pilotPeerId: null,
      transmitMode: 'web',
    };
    live.set(row.slug, r);
  } else {
    r.roomDbId = row.id;
    r.maxViewers = row.max_viewers;
    r.active = Boolean(row.active);
    if (!('pilotPeerId' in r)) r.pilotPeerId = null;
    if (!('transmitMode' in r)) r.transmitMode = 'web';
    if (!r.panels) r.panels = new Map();
  }
  return r;
}

function canControlRoom(client) {
  return Boolean(client && (client.role === 'host' || client.role === 'panel'));
}

function controlModeOf(client) {
  return client.controlMode === 'interact' ? 'interact' : 'view';
}

/** seat no wire: transmitter | controller | viewer (compat: role host|panel|viewer). */
function seatOf(client) {
  if (!client) return 'viewer';
  if (client.role === 'host') return 'transmitter';
  if (client.role === 'panel') return 'controller';
  return 'viewer';
}

function wsSend(ws, msg) {
  if (ws && ws.readyState === 1 && typeof ws.send === 'function') {
    ws.send(JSON.stringify(msg));
  }
}

function slotList(room) {
  return [...room.slots].sort((a, b) => a - b);
}

function rosterMember(client, extra = {}) {
  return {
    peerId: client.peerId,
    role: client.role === 'panel' ? 'panel' : client.role === 'host' ? 'host' : 'viewer',
    seat: seatOf(client),
    displayName: client.displayName,
    clientKind: client.clientKind || 'web',
    ...extra,
  };
}

function roster(room) {
  const list = [];
  if (room.host) {
    list.push(rosterMember(room.host));
  }
  for (const p of room.panels?.values() || []) {
    list.push(rosterMember(p));
  }
  for (const v of room.viewers.values()) {
    list.push(
      rosterMember(v, {
        role: 'viewer',
        controlMode: controlModeOf(v),
      }),
    );
  }
  return list;
}

function broadcastRoom(room, msg, exceptPeerId = null) {
  if (room.host && room.host.peerId !== exceptPeerId) wsSend(room.host.ws, msg);
  for (const p of room.panels?.values() || []) {
    if (p.peerId !== exceptPeerId) wsSend(p.ws, msg);
  }
  for (const v of room.viewers.values()) {
    if (v.peerId !== exceptPeerId) wsSend(v.ws, msg);
  }
}

function findClient(room, peerId) {
  if (room.host && room.host.peerId === peerId) return room.host;
  if (room.panels?.has(peerId)) return room.panels.get(peerId);
  return room.viewers.get(peerId) || null;
}

function clearMediaSlots(room) {
  room.slots.clear();
  for (const v of room.viewers.values()) {
    wsSend(v.ws, { type: 'slots', slots: [] });
  }
}

/**
 * Resolve entrada de host/companion: demote web→panel, kick, ou joinAsPanel.
 * @returns {{ joinAsPanel: boolean, demoted?: Client }}
 */
function resolveHostJoin(room, { sessionRole, helloKind, incomingWs }) {
  if (sessionRole !== 'host') {
    return { joinAsPanel: false };
  }

  const joinAsPanel =
    helloKind === 'web' && room.host && room.host.clientKind === 'companion';

  if (joinAsPanel) {
    return { joinAsPanel: true };
  }

  if (room.host && room.host.ws !== incomingWs) {
    const prev = room.host;
    if (helloKind === 'companion' && prev.clientKind !== 'companion') {
      prev.role = 'panel';
      room.panels.set(prev.peerId, prev);
      room.host = null;
      clearMediaSlots(room);
      wsSend(prev.ws, {
        type: 'host_role',
        role: 'panel',
        seat: 'controller',
        transmitMode: 'companion',
        message: 'Companion transmitindo. Este navegador continua como painel (promover / config).',
      });
      return { joinAsPanel: false, demoted: prev };
    }

    try {
      wsSend(prev.ws, { type: 'error', message: 'Outro host entrou nesta sala.' });
      prev.ws.close?.();
    } catch {
      /* ok */
    }
    if (prev.role === 'panel') room.panels.delete(prev.peerId);
    room.host = null;
    clearMediaSlots(room);
  }

  return { joinAsPanel: false };
}

/**
 * @param {RuntimeRoom} room
 * @param {string} peerId
 * @param {'view'|'interact'} mode
 * @param {Client} [controller]
 * @param {{ onAudit?: Function }} [opts]
 */
function applyControlMode(room, peerId, mode, controller, opts = {}) {
  const target = room.viewers.get(peerId);
  if (!target) return { ok: false, message: 'Espectador não encontrado.' };
  const next = mode === 'interact' ? 'interact' : 'view';

  // Assist only: interact exige companion transmitindo.
  if (next === 'interact' && room.transmitMode !== 'companion') {
    return {
      ok: false,
      message: 'Interagir só no modo Assist (Companion transmitindo).',
    };
  }

  if (next === 'interact') {
    for (const v of room.viewers.values()) {
      if (v.peerId !== peerId && v.controlMode === 'interact') {
        v.controlMode = 'view';
        broadcastRoom(room, {
          type: 'control_changed',
          peerId: v.peerId,
          mode: 'view',
          displayName: v.displayName,
        });
      }
    }
    room.pilotPeerId = peerId;
  } else if (room.pilotPeerId === peerId) {
    room.pilotPeerId = null;
  }
  target.controlMode = next;
  broadcastRoom(room, {
    type: 'control_changed',
    peerId,
    mode: next,
    displayName: target.displayName,
  });
  broadcastRoom(room, { type: 'roster', members: roster(room) });
  if (typeof opts.onAudit === 'function') {
    opts.onAudit(room.roomDbId, controller?.deviceId || '', peerId, target.displayName, next);
  }
  return { ok: true };
}

function detachClient(live, client) {
  const room = live.get(client.roomSlug);
  if (!room) return;

  if (client.role === 'host' && room.host && room.host.peerId === client.peerId) {
    room.host = null;
    room.slots.clear();
    room.transmitMode = 'web';
    room.pilotPeerId = null;
    for (const v of room.viewers.values()) {
      v.controlMode = 'view';
      wsSend(v.ws, { type: 'host_left' });
    }
    broadcastRoom(room, { type: 'roster', members: roster(room) });
    return;
  }

  if (client.role === 'panel' && room.panels?.has(client.peerId)) {
    room.panels.delete(client.peerId);
    broadcastRoom(room, { type: 'roster', members: roster(room) });
    return;
  }

  if (client.role === 'viewer' && room.viewers.has(client.peerId)) {
    room.viewers.delete(client.peerId);
    if (room.pilotPeerId === client.peerId) room.pilotPeerId = null;
    broadcastRoom(room, {
      type: 'viewer_left',
      peerId: client.peerId,
      displayName: client.displayName,
    });
    broadcastRoom(room, { type: 'roster', members: roster(room) });
  }
}

function kickRole(room, role, reason) {
  if (role === 'viewer') {
    const list = [...room.viewers.values()];
    room.viewers.clear();
    room.pilotPeerId = null;
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
    for (const p of room.panels?.values() || []) {
      wsSend(p.ws, { type: 'roster', members: roster(room) });
    }
  }
}

/** @returns {RuntimeRoom} */
function createTestRoom(slug = 'test') {
  return {
    slug,
    roomDbId: 1,
    maxViewers: 8,
    active: true,
    host: null,
    panels: new Map(),
    slots: new Set(),
    viewers: new Map(),
    pilotPeerId: null,
    transmitMode: 'web',
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
  canControlRoom,
  controlModeOf,
  seatOf,
  wsSend,
  slotList,
  roster,
  broadcastRoom,
  findClient,
  clearMediaSlots,
  resolveHostJoin,
  applyControlMode,
  detachClient,
  kickRole,
  createTestRoom,
  mockWs,
};
