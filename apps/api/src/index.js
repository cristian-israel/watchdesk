#!/usr/bin/env node
'use strict';

/**
 * Watchdesk API — salas MySQL, sessões (cookie), chat, sinalização WebRTC P2P + ICE/TURN.
 */

require('./load-env');

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { initDb, getPool, healthCheck } = require('./db');
const { companionLatest, cmpSemver } = require('./companion-version');
const {
  ROOM_RE,
  KEY_MIN_CREATE,
  KEY_MIN_LOGIN,
  WS_MAX_PAYLOAD,
  shaHex,
  hashEqHex,
  normalizeName,
  validateKey,
  isDeviceId,
  clientIp,
  parseCookies,
  cookieHeader,
  createRateLimiter,
  iceServers: buildIceServers,
  originAllowed,
  readJson,
} = require('./util');

const RECENT_LIMIT = 10;

const HELP = `
Uso: node src/index.js [opções]

  --port <n>           Porta HTTP/WS (padrão: 7030 ou PORT)
  --public-host <h>    IP TURN alcançável pelos peers (ou PUBLIC_HOST)
  --turn-secret <s>    Segredo Coturn (ou TURN_SECRET)
  --turn-host <h>      Host TURN (padrão: PUBLIC_HOST)
  --turn-port <n>      Porta TURN (padrão: 3478)
  --turn-realm <r>     Realm TURN (padrão: watchdesk)
  DATABASE_URL         mysql://user:pass@host:3306/db (obrigatório)
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      console.log(HELP);
      process.exit(0);
    }
    if (!a.startsWith('--')) {
      console.error(`Argumento inesperado: ${a}\n${HELP}`);
      process.exit(1);
    }
    const name = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
      console.error(`Faltou valor para ${a}`);
      process.exit(1);
    }
    out[name] = val;
    i++;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cfg = {
  port: Number(args.port || process.env.PORT || 7030),
  publicHost: args['public-host'] || process.env.PUBLIC_HOST || '',
  turnSecret: args['turn-secret'] || process.env.TURN_SECRET || '',
  turnHost: args['turn-host'] || process.env.TURN_HOST || '',
  turnPort: Number(args['turn-port'] || process.env.TURN_PORT || 3478),
  turnRealm: args['turn-realm'] || process.env.TURN_REALM || 'watchdesk',
};

const MAX_SLOTS = 8;
const ICE_TTL_SEC = 3600;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICE_TTL_SEC = 365 * 24 * 60 * 60;
const CHAT_HISTORY = 100;
const CHAT_MAX = 500;

/** Runtime presence by slug */
/** @type {Map<string, RuntimeRoom>} */
const live = new Map();

/**
 * @typedef {{
 *   slug: string,
 *   roomDbId: number,
 *   maxViewers: number,
 *   active: boolean,
 *   host: Client | null,
 *   slots: Set<number>,
 *   viewers: Map<string, Client>,
 *   pilotPeerId: string | null,
 *   transmitMode: 'web' | 'companion',
 * }} RuntimeRoom
 *
 * @typedef {{
 *   ws: import('ws').WebSocket,
 *   peerId: string,
 *   role: 'host' | 'viewer',
 *   roomSlug: string,
 *   displayName: string,
 *   sessionId: string,
 *   deviceId: string,
 *   controlMode: 'view' | 'interact',
 *   clientKind: 'web' | 'companion',
 *   companionVersion: string,
 * }} Client
 */

function ensureLive(row) {
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
  }
  return r;
}

async function touchRecentRoom(deviceId, slug, label, viewerInvite) {
  if (!deviceId || !slug) return;
  await getPool().query(
    `INSERT INTO recent_rooms (device_id, room_slug, room_label, viewer_invite, last_seen_at)
     VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       room_label = VALUES(room_label),
       viewer_invite = IF(VALUES(viewer_invite) = '', viewer_invite, VALUES(viewer_invite)),
       last_seen_at = VALUES(last_seen_at)`,
    [deviceId, slug, String(label || '').slice(0, 80), String(viewerInvite || '').slice(0, 128)],
  );
  const [rows] = await getPool().query(
    `SELECT room_slug FROM recent_rooms WHERE device_id = ? ORDER BY last_seen_at DESC`,
    [deviceId],
  );
  if (rows.length > RECENT_LIMIT) {
    const drop = rows.slice(RECENT_LIMIT).map((r) => r.room_slug);
    const ph = drop.map(() => '?').join(',');
    await getPool().query(
      `DELETE FROM recent_rooms WHERE device_id = ? AND room_slug IN (${ph})`,
      [deviceId, ...drop],
    );
  }
}

async function listRecentRooms(deviceId) {
  const [rows] = await getPool().query(
    `SELECT room_slug AS slug, room_label AS label, viewer_invite AS viewerInvite, last_seen_at AS lastSeenAt
     FROM recent_rooms WHERE device_id = ? ORDER BY last_seen_at DESC LIMIT ?`,
    [deviceId, RECENT_LIMIT],
  );
  return rows.map((r) => ({
    slug: r.slug,
    label: r.label || '',
    viewerInvite: r.viewerInvite || '',
    lastSeenAt: r.lastSeenAt,
  }));
}

async function insertControlAudit(roomId, hostDeviceId, peerId, displayName, mode) {
  try {
    await getPool().query(
      `INSERT INTO control_audit (room_id, host_device_id, target_peer_id, target_display_name, mode)
       VALUES (?, ?, ?, ?, ?)`,
      [roomId, hostDeviceId || null, peerId, String(displayName || '').slice(0, 80), mode],
    );
  } catch (e) {
    console.error('control_audit', e);
  }
}

function controlModeOf(client) {
  return client.controlMode === 'interact' ? 'interact' : 'view';
}

const { blocked, noteFailure } = createRateLimiter();

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, obj, extraHeaders = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json', ...extraHeaders });
}

function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', cookie);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', [...prev, cookie]);
  else res.setHeader('Set-Cookie', [String(prev), cookie]);
}

function setSessionCookie(res, token, req) {
  appendSetCookie(res, cookieHeader('wd_session', token, Math.floor(SESSION_TTL_MS / 1000), req));
}

function clearSessionCookie(res, req) {
  appendSetCookie(res, cookieHeader('wd_session', '', 0, req));
}

function setDeviceCookie(res, id, req) {
  appendSetCookie(res, cookieHeader('wd_device', id, DEVICE_TTL_SEC, req));
}

function randomSlug() {
  return crypto.randomBytes(9).toString('base64url').slice(0, 12);
}

function randomKey() {
  return crypto.randomBytes(18).toString('base64url');
}

function salaPath(slug, viewerInvite) {
  const base = `/sala/${slug}`;
  if (!viewerInvite) return base;
  return `${base}#k=${encodeURIComponent(viewerInvite)}`;
}

/** Path relativo — o front monta a URL com location.origin (padrão frontier/alias). */
function viewerLinks(slug, viewerInvite = '') {
  return [salaPath(slug, viewerInvite)];
}

function iceServers(userId = 'anon') {
  return buildIceServers(
    {
      turnSecret: cfg.turnSecret,
      turnHost: cfg.turnHost,
      publicHost: cfg.publicHost,
      turnPort: cfg.turnPort,
    },
    userId,
    ICE_TTL_SEC,
  );
}

// ----------------------------------------------------------------- DB helpers

async function findRoomBySlug(slug) {
  const [rows] = await getPool().query('SELECT * FROM rooms WHERE slug = ? LIMIT 1', [slug]);
  return rows[0] || null;
}

async function findRoomByDevice(deviceId) {
  const [rows] = await getPool().query('SELECT * FROM rooms WHERE device_id = ? LIMIT 1', [deviceId]);
  return rows[0] || null;
}

function roomSummary(row) {
  return {
    slug: row.slug,
    active: Boolean(row.active),
    maxViewers: row.max_viewers,
    links: viewerLinks(row.slug, row.viewer_invite),
    viewerInvite: row.viewer_invite || '',
    hostInvite: row.host_invite || '',
  };
}

function mePayload(device, room) {
  return {
    deviceId: device.id,
    displayName: device.display_name || '',
    room: room ? roomSummary(room) : null,
  };
}

async function ensureDevice(req, res) {
  const cookies = parseCookies(req);
  const ip = clientIp(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 255);
  let id = cookies.wd_device;
  if (isDeviceId(id)) {
    const [rows] = await getPool().query('SELECT * FROM devices WHERE id = ? LIMIT 1', [id]);
    if (rows[0]) {
      await getPool().query(
        'UPDATE devices SET last_seen_at = UTC_TIMESTAMP(3), last_ip = ?, user_agent = ? WHERE id = ?',
        [ip || null, ua || null, id],
      );
      setDeviceCookie(res, id, req);
      return rows[0];
    }
  }
  id = crypto.randomBytes(32).toString('hex');
  await getPool().query('INSERT INTO devices (id, last_ip, user_agent) VALUES (?, ?, ?)', [
    id,
    ip || null,
    ua || null,
  ]);
  setDeviceCookie(res, id, req);
  const [created] = await getPool().query('SELECT * FROM devices WHERE id = ? LIMIT 1', [id]);
  return created[0];
}

async function renameDevice(deviceId, displayName) {
  await getPool().query('UPDATE devices SET display_name = ? WHERE id = ?', [displayName, deviceId]);
  const [sessRows] = await getPool().query('SELECT id FROM sessions WHERE device_id = ?', [deviceId]);
  await getPool().query('UPDATE sessions SET display_name = ? WHERE device_id = ?', [displayName, deviceId]);
  const ids = new Set(sessRows.map((row) => row.id));
  for (const room of live.values()) {
    let changed = false;
    const touch = (client) => {
      if (!client) return;
      if (client.deviceId === deviceId || ids.has(client.sessionId)) {
        client.displayName = displayName;
        client.deviceId = deviceId;
        changed = true;
      }
    };
    touch(room.host);
    for (const viewer of room.viewers.values()) touch(viewer);
    if (changed) broadcastRoom(room, { type: 'roster', members: roster(room) });
  }
}

function dropLiveRoom(slug, message) {
  const rt = live.get(slug);
  if (!rt) return;
  const closeOne = (client) => {
    try {
      wsSend(client.ws, { type: 'error', message });
      client.ws.close();
    } catch {
      /* ok */
    }
  };
  if (rt.host) closeOne(rt.host);
  for (const viewer of rt.viewers.values()) closeOne(viewer);
  live.delete(slug);
}

async function createSession(roomId, role, displayName, deviceId) {
  if (deviceId) {
    await getPool().query('DELETE FROM sessions WHERE room_id = ? AND role = ? AND device_id = ?', [
      roomId,
      role,
      deviceId,
    ]);
  }
  const id = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await getPool().query(
    'INSERT INTO sessions (id, room_id, role, display_name, expires_at, device_id) VALUES (?, ?, ?, ?, ?, ?)',
    [id, roomId, role, displayName, expires, deviceId || null],
  );
  return { id, expires };
}

async function getSession(token) {
  if (!token || token.length < 16) return null;
  const [rows] = await getPool().query(
    `SELECT s.*, r.slug, r.active, r.max_viewers, r.creator_name, r.viewer_invite, r.host_invite
     FROM sessions s
     JOIN rooms r ON r.id = s.room_id
     WHERE s.id = ? AND s.expires_at > UTC_TIMESTAMP(3)
     LIMIT 1`,
    [token],
  );
  return rows[0] || null;
}

async function deleteSession(token) {
  if (!token) return;
  await getPool().query('DELETE FROM sessions WHERE id = ?', [token]);
}

async function deleteSessionsByRole(roomId, role, exceptId = null) {
  if (exceptId) {
    await getPool().query('DELETE FROM sessions WHERE room_id = ? AND role = ? AND id != ?', [
      roomId,
      role,
      exceptId,
    ]);
  } else {
    await getPool().query('DELETE FROM sessions WHERE room_id = ? AND role = ?', [roomId, role]);
  }
}

function mapChatRow(r) {
  return {
    id: r.id,
    authorName: r.authorName,
    authorDeviceId: r.authorDeviceId || '',
    role: r.role,
    body: r.body,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  };
}

async function loadChat(roomId) {
  const [rows] = await getPool().query(
    `SELECT id, author_name AS authorName, device_id AS authorDeviceId, role, body, created_at AS createdAt
     FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT ?`,
    [roomId, CHAT_HISTORY],
  );
  return rows.reverse().map(mapChatRow);
}

async function insertChat(roomId, authorName, role, body, deviceId) {
  const [result] = await getPool().query(
    'INSERT INTO chat_messages (room_id, author_name, role, body, device_id) VALUES (?, ?, ?, ?, ?)',
    [roomId, authorName, role, body, deviceId || null],
  );
  return {
    id: result.insertId,
    authorName,
    authorDeviceId: deviceId || '',
    role,
    body,
    createdAt: new Date().toISOString(),
  };
}

function sessionPayload(row) {
  const payload = {
    room: row.slug,
    role: row.role,
    displayName: row.display_name,
    active: Boolean(row.active),
    maxViewers: row.max_viewers,
    links: viewerLinks(row.slug, row.role === 'host' ? row.viewer_invite : ''),
  };
  if (row.role === 'host') {
    payload.viewerInvite = row.viewer_invite || '';
    payload.hostInvite = row.host_invite || '';
  }
  return payload;
}

// ----------------------------------------------------------------- WebSocket

function wsSend(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
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
      clientKind: room.host.clientKind || 'web',
    });
  }
  for (const v of room.viewers.values()) {
    list.push({
      peerId: v.peerId,
      role: 'viewer',
      displayName: v.displayName,
      controlMode: controlModeOf(v),
    });
  }
  return list;
}

function applyControlMode(room, peerId, mode, hostClient) {
  const target = room.viewers.get(peerId);
  if (!target) return { ok: false, message: 'Espectador não encontrado.' };
  const next = mode === 'interact' ? 'interact' : 'view';
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
  void insertControlAudit(
    room.roomDbId,
    hostClient?.deviceId || '',
    peerId,
    target.displayName,
    next,
  );
  return { ok: true };
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

function detachClient(client) {
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
    if (room.pilotPeerId === client.peerId) room.pilotPeerId = null;
    broadcastRoom(room, {
      type: 'viewer_left',
      peerId: client.peerId,
      displayName: client.displayName,
    });
    broadcastRoom(room, { type: 'roster', members: roster(room) });
  }
}

async function handleHello(ws, req, ip) {
  const cookies = parseCookies(req);
  const session = await getSession(cookies.wd_session);

  if (!session) {
    noteFailure(ip);
    wsSend(ws, { type: 'error', message: 'Sessão inválida ou expirada.' });
    ws.close();
    return;
  }

  const roomRow = await findRoomBySlug(session.slug);
  if (!roomRow) {
    wsSend(ws, { type: 'error', message: 'Sala não encontrada.' });
    ws.close();
    return;
  }

  if (session.role === 'viewer' && !roomRow.active) {
    wsSend(ws, { type: 'error', message: 'Sala desativada.' });
    ws.close();
    return;
  }

  const room = ensureLive(roomRow);

  if (session.role === 'viewer' && room.viewers.size >= room.maxViewers) {
    wsSend(ws, { type: 'error', message: 'Sala cheia.' });
    ws.close();
    return;
  }

  if (session.role === 'host') {
    if (room.host && room.host.ws !== ws) {
      try {
        wsSend(room.host.ws, { type: 'error', message: 'Outro host entrou nesta sala.' });
        room.host.ws.close();
      } catch {
        /* ok */
      }
      room.host = null;
      room.slots.clear();
    }
  }

  const peerId = crypto.randomBytes(8).toString('hex');
  const helloKind = ws.watchdeskHelloKind === 'companion' ? 'companion' : 'web';
  const companionVersion = String(ws.watchdeskCompanionVersion || '');
  /** @type {Client} */
  const client = {
    ws,
    peerId,
    role: session.role,
    roomSlug: session.slug,
    displayName: session.display_name,
    sessionId: session.id,
    deviceId: session.device_id || '',
    controlMode: 'view',
    clientKind: session.role === 'host' ? helloKind : 'web',
    companionVersion,
  };
  ws.watchdeskClient = client;

  if (session.role === 'host') {
    if (helloKind === 'companion') {
      const latest = companionLatest();
      if (companionVersion && cmpSemver(companionVersion, latest.minVersion) < 0 && latest.mandatory) {
        wsSend(ws, {
          type: 'error',
          message: `Companion desatualizado (mínimo ${latest.minVersion}). Atualize para transmitir.`,
        });
        ws.close();
        return;
      }
      room.transmitMode = 'companion';
    } else if (room.transmitMode === 'companion' && room.host?.clientKind === 'companion') {
      // web host panel ok alongside companion later; keep transmitMode
    } else {
      room.transmitMode = 'web';
    }
    room.host = client;
  } else {
    room.viewers.set(peerId, client);
  }

  const history = await loadChat(room.roomDbId);
  const latest = companionLatest();

  wsSend(ws, {
    type: 'welcome',
    peerId,
    role: session.role,
    room: session.slug,
    displayName: session.display_name,
    slots: slotList(room),
    viewers:
      session.role === 'host'
        ? [...room.viewers.values()].map((v) => ({
            peerId: v.peerId,
            displayName: v.displayName,
            controlMode: controlModeOf(v),
          }))
        : undefined,
    iceServers: iceServers(peerId),
    maxViewers: room.maxViewers,
    active: room.active,
    controlMode: session.role === 'viewer' ? 'view' : undefined,
    pilotPeerId: room.pilotPeerId,
    transmitMode: room.transmitMode,
    companion: session.role === 'host' ? latest : undefined,
  });
  wsSend(ws, { type: 'chat_history', messages: history });
  broadcastRoom(room, { type: 'roster', members: roster(room) });

  if (session.role === 'host') {
    broadcastRoom(
      room,
      { type: 'host_joined', peerId, displayName: session.display_name },
      peerId,
    );
  } else {
    broadcastRoom(
      room,
      { type: 'viewer_joined', peerId, displayName: session.display_name, controlMode: 'view' },
      peerId,
    );
    if (client.deviceId) {
      void touchRecentRoom(client.deviceId, session.slug, roomRow.creator_name || session.slug, '');
    }
  }
}

function handleSignal(client, msg) {
  const room = live.get(client.roomSlug);
  if (!room) return;

  if (client.role === 'host' && msg.type === 'set_control') {
    const peerId = String(msg.peerId || '');
    const mode = msg.mode === 'interact' ? 'interact' : 'view';
    const result = applyControlMode(room, peerId, mode, client);
    if (!result.ok) wsSend(client.ws, { type: 'error', message: result.message });
    return;
  }

  if (client.role === 'host' && (msg.type === 'slot_add' || msg.type === 'slot_remove')) {
    const slot = Number(msg.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) return;
    if (msg.type === 'slot_add') room.slots.add(slot);
    else room.slots.delete(slot);
    const payload = { type: 'slots', slots: slotList(room) };
    for (const v of room.viewers.values()) wsSend(v.ws, payload);
    return;
  }

  if (msg.type === 'chat') {
    void (async () => {
      const body = String(msg.body || '').trim().slice(0, CHAT_MAX);
      if (!body) return;
      try {
        const saved = await insertChat(
          room.roomDbId,
          client.displayName,
          client.role,
          body,
          client.deviceId,
        );
        broadcastRoom(room, { type: 'chat', message: saved });
      } catch (e) {
        console.error('chat', e);
      }
    })();
    return;
  }

  if (!['offer', 'answer', 'ice'].includes(msg.type)) return;
  const to = String(msg.to || '');
  const target = findClient(room, to);
  if (!target) return;

  const okPair =
    (client.role === 'host' && target.role === 'viewer') ||
    (client.role === 'viewer' && target.role === 'host');
  if (!okPair) return;

  const slot = Number(msg.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_SLOTS) return;

  if (msg.type === 'ice') {
    wsSend(target.ws, {
      type: 'ice',
      from: client.peerId,
      slot,
      candidate: msg.candidate ?? null,
    });
    return;
  }

  if (typeof msg.sdp !== 'string' || !msg.sdp) return;
  wsSend(target.ws, {
    type: msg.type,
    from: client.peerId,
    slot,
    sdp: msg.sdp,
  });
}

function kickRole(room, role, reason) {
  if (role === 'viewer') {
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
        v.ws.close();
      } catch {
        /* ok */
      }
    }
    if (room.host) {
      wsSend(room.host.ws, { type: 'roster', members: roster(room) });
    }
  } else if (role === 'host' && room.host) {
    // keep current host; used when invalidating other host sessions only
  }
}

function attachWs(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname !== '/api/ws') {
      socket.destroy();
      return;
    }
    if (!originAllowed(req, cfg.publicHost)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req) || '?';
    if (blocked(ip)) {
      wsSend(ws, { type: 'error', message: 'Muitas tentativas. Aguarde 1 minuto.' });
      ws.close();
      return;
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'hello') {
        if (ws.watchdeskClient) return;
        ws.watchdeskHelloKind = msg.clientKind === 'companion' ? 'companion' : 'web';
        ws.watchdeskCompanionVersion = String(msg.version || '');
        void handleHello(ws, req, ip);
        return;
      }

      const client = ws.watchdeskClient;
      if (!client) return;
      handleSignal(client, msg);
    });

    ws.on('close', () => {
      const client = ws.watchdeskClient;
      if (client) detachClient(client);
    });
  });
}

// ----------------------------------------------------------------- HTTP

const handler = async (req, res) => {
  const ip = clientIp(req) || '?';
  const url = new URL(req.url || '/', 'http://x');
  const { pathname } = url;

  if (pathname === '/api/health') {
    try {
      const ok = await healthCheck();
      return sendJson(res, ok ? 200 : 503, { ok });
    } catch {
      return sendJson(res, 503, { ok: false });
    }
  }

  const needsRate =
    pathname.startsWith('/api/rooms') ||
    pathname === '/api/me' ||
    pathname === '/api/me/room' ||
    pathname === '/api/me/recent' ||
    pathname === '/api/session' ||
    pathname === '/api/logout' ||
    pathname === '/api/ice' ||
    pathname === '/api/companion/version';

  if (needsRate && blocked(ip)) {
    return send(res, 429, 'Muitas tentativas. Aguarde 1 minuto.', { 'Retry-After': '60' });
  }

  // GET /api/companion/version — latest companion build (LAN)
  if (req.method === 'GET' && pathname === '/api/companion/version') {
    return sendJson(res, 200, companionLatest());
  }

  // GET /api/me/recent
  if (req.method === 'GET' && pathname === '/api/me/recent') {
    const device = await ensureDevice(req, res);
    const items = await listRecentRooms(device.id);
    return sendJson(res, 200, { items });
  }

  // DELETE /api/me/recent
  if (req.method === 'DELETE' && pathname === '/api/me/recent') {
    const device = await ensureDevice(req, res);
    await getPool().query('DELETE FROM recent_rooms WHERE device_id = ?', [device.id]);
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/session
  if (req.method === 'GET' && pathname === '/api/session') {
    const cookies = parseCookies(req);
    const session = await getSession(cookies.wd_session);
    if (!session) return sendJson(res, 401, { ok: false });
    return sendJson(res, 200, { ok: true, ...sessionPayload(session) });
  }

  // POST /api/logout
  if (req.method === 'POST' && pathname === '/api/logout') {
    const cookies = parseCookies(req);
    await deleteSession(cookies.wd_session);
    clearSessionCookie(res, req);
    return sendJson(res, 200, { ok: true });
  }

  // GET /api/me
  if (req.method === 'GET' && pathname === '/api/me') {
    const device = await ensureDevice(req, res);
    const room = await findRoomByDevice(device.id);
    return sendJson(res, 200, mePayload(device, room));
  }

  // PATCH /api/me
  if (req.method === 'PATCH' && pathname === '/api/me') {
    try {
      const device = await ensureDevice(req, res);
      const body = await readJson(req);
      const displayName = normalizeName(body.displayName);
      if (!displayName) return send(res, 400, 'Informe seu nome.');
      await renameDevice(device.id, displayName);
      const room = await findRoomByDevice(device.id);
      return sendJson(res, 200, mePayload({ ...device, display_name: displayName }, room));
    } catch (e) {
      console.error(e);
      return send(res, 400, 'Não foi possível salvar o nome.');
    }
  }

  // DELETE /api/me/room
  if (req.method === 'DELETE' && pathname === '/api/me/room') {
    const device = await ensureDevice(req, res);
    const room = await findRoomByDevice(device.id);
    if (room) {
      await getPool().query('DELETE FROM rooms WHERE id = ? AND device_id = ?', [room.id, device.id]);
      dropLiveRoom(room.slug, 'Sala excluída.');
    }
    return sendJson(res, 200, { ok: true, ...mePayload(device, null) });
  }

  // POST /api/rooms — create (slug e chaves gerados no servidor)
  if (req.method === 'POST' && pathname === '/api/rooms') {
    try {
      const device = await ensureDevice(req, res);
      const body = await readJson(req);
      const displayName = device.display_name || '';
      let maxViewers = Number(body.maxViewers ?? 8);
      if (!Number.isInteger(maxViewers) || maxViewers < 1 || maxViewers > 8) maxViewers = 8;

      if (!displayName) return send(res, 400, 'Informe seu nome.');

      const owned = await findRoomByDevice(device.id);
      if (owned) return send(res, 409, 'Este aparelho já tem uma sala. Exclua-a para criar outra.');

      const hostKey = randomKey();
      const viewerKey = randomKey();
      let slug = '';
      let roomId = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        slug = randomSlug();
        if (!ROOM_RE.test(slug)) continue;
        try {
          const [ins] = await getPool().query(
            `INSERT INTO rooms
              (slug, host_key_hash, viewer_key_hash, host_invite, viewer_invite, creator_name, max_viewers, active, device_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            [
              slug,
              shaHex(hostKey),
              shaHex(viewerKey),
              hostKey,
              viewerKey,
              displayName,
              maxViewers,
              device.id,
            ],
          );
          roomId = ins.insertId;
          break;
        } catch (e) {
          if (e && e.code === 'ER_DUP_ENTRY') {
            const dup = String(e.message || '');
            if (dup.includes('uq_rooms_device') || dup.includes('device_id')) {
              return send(res, 409, 'Este aparelho já tem uma sala. Exclua-a para criar outra.');
            }
            continue;
          }
          throw e;
        }
      }
      if (!roomId) return send(res, 500, 'Não foi possível criar a sala.');

      const sess = await createSession(roomId, 'host', displayName, device.id);
      setSessionCookie(res, sess.id, req);
      const row = await findRoomBySlug(slug);
      ensureLive(row);
      return sendJson(res, 201, { ok: true, ...sessionPayload({ ...row, role: 'host', display_name: displayName }) });
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') {
        const dup = String(e.message || '');
        if (dup.includes('uq_rooms_device') || dup.includes('device_id')) {
          return send(res, 409, 'Este aparelho já tem uma sala. Exclua-a para criar outra.');
        }
        return send(res, 409, 'Sala já existe.');
      }
      console.error(e);
      return send(res, 500, 'Erro ao criar sala');
    }
  }

  // GET /api/rooms/:slug
  const roomGet = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]{1,40})$/);
  if (req.method === 'GET' && roomGet) {
    const row = await findRoomBySlug(roomGet[1]);
    if (!row) return sendJson(res, 404, { exists: false });
    return sendJson(res, 200, {
      exists: true,
      slug: row.slug,
      active: Boolean(row.active),
      maxViewers: row.max_viewers,
    });
  }

  // POST /api/rooms/:slug/host
  const roomHost = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]{1,40})\/host$/);
  if (req.method === 'POST' && roomHost) {
    try {
      const device = await ensureDevice(req, res);
      const body = await readJson(req);
      const slug = roomHost[1];
      const displayName = device.display_name || '';
      const hostKey = body.hostKey || '';
      if (!displayName) return send(res, 400, 'Informe seu nome.');

      const row = await findRoomBySlug(slug);
      if (!row) return send(res, 404, 'Sala não encontrada.');
      const owner = Boolean(row.device_id) && row.device_id === device.id;
      if (!owner) {
        if (!validateKey(hostKey, KEY_MIN_LOGIN)) return send(res, 400, 'Chave do host inválida.');
        if (!hashEqHex(row.host_key_hash, shaHex(hostKey))) {
          noteFailure(ip);
          return send(res, 401, 'Chave do host incorreta.');
        }
      }

      const sess = await createSession(row.id, 'host', displayName, device.id);
      setSessionCookie(res, sess.id, req);
      ensureLive(row);
      return sendJson(res, 200, {
        ok: true,
        ...sessionPayload({ ...row, role: 'host', display_name: displayName }),
      });
    } catch (e) {
      console.error(e);
      return send(res, 500, 'Erro ao entrar');
    }
  }

  // POST /api/rooms/:slug/viewer
  const roomViewer = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]{1,40})\/viewer$/);
  if (req.method === 'POST' && roomViewer) {
    try {
      const device = await ensureDevice(req, res);
      const body = await readJson(req);
      const slug = roomViewer[1];
      const displayName = device.display_name || '';
      const viewerKey = body.viewerKey || '';
      if (!displayName) return send(res, 400, 'Informe seu nome.');
      if (!validateKey(viewerKey, KEY_MIN_LOGIN)) return send(res, 400, 'Chave inválida.');

      const row = await findRoomBySlug(slug);
      if (!row) return send(res, 404, 'Sala não encontrada.');
      if (!row.active) return send(res, 403, 'Sala desativada.');
      if (!hashEqHex(row.viewer_key_hash, shaHex(viewerKey))) {
        noteFailure(ip);
        return send(res, 401, 'Chave incorreta.');
      }

      const rt = ensureLive(row);
      if (rt.viewers.size >= rt.maxViewers) return send(res, 403, 'Sala cheia.');

      const sess = await createSession(row.id, 'viewer', displayName, device.id);
      setSessionCookie(res, sess.id, req);
      await touchRecentRoom(device.id, slug, row.creator_name || slug, viewerKey);
      return sendJson(res, 200, {
        ok: true,
        ...sessionPayload({ ...row, role: 'viewer', display_name: displayName }),
        controlMode: 'view',
      });
    } catch (e) {
      console.error(e);
      return send(res, 500, 'Erro ao entrar');
    }
  }

  // POST /api/rooms/:slug/kick-viewers
  const roomKickViewers = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]{1,40})\/kick-viewers$/);
  if (req.method === 'POST' && roomKickViewers) {
    try {
      const cookies = parseCookies(req);
      const session = await getSession(cookies.wd_session);
      const slug = roomKickViewers[1];
      if (!session || session.slug !== slug || session.role !== 'host') {
        return send(res, 401, 'Só o host autenticado pode remover espectadores.');
      }

      const row = await findRoomBySlug(slug);
      if (!row) return send(res, 404, 'Sala não encontrada.');

      await deleteSessionsByRole(row.id, 'viewer');
      const rt = live.get(slug);
      if (rt) {
        kickRole(rt, 'viewer', 'Você foi removido da sala pelo host.');
      }

      return sendJson(res, 200, { ok: true, message: 'Todos os espectadores foram removidos.' });
    } catch (e) {
      console.error(e);
      return send(res, 500, 'Erro ao remover espectadores');
    }
  }

  // PATCH /api/rooms/:slug
  if (req.method === 'PATCH' && roomGet) {
    try {
      const cookies = parseCookies(req);
      const session = await getSession(cookies.wd_session);
      const slug = roomGet[1];
      if (!session || session.slug !== slug || session.role !== 'host') {
        return send(res, 401, 'Só o host autenticado pode alterar a sala.');
      }

      const body = await readJson(req);
      const row = await findRoomBySlug(slug);
      if (!row) return send(res, 404, 'Sala não encontrada.');

      const updates = [];
      const params = [];
      let viewerKeyChanged = false;
      let hostKeyChanged = false;

      if (typeof body.active === 'boolean') {
        updates.push('active = ?');
        params.push(body.active ? 1 : 0);
      }
      if (body.maxViewers !== undefined) {
        const mv = Number(body.maxViewers);
        if (!Number.isInteger(mv) || mv < 1 || mv > 8) return send(res, 400, 'maxViewers deve ser 1..8');
        updates.push('max_viewers = ?');
        params.push(mv);
      }
      if (body.regenerateHostKey === true) {
        const hostKey = randomKey();
        updates.push('host_key_hash = ?', 'host_invite = ?');
        params.push(shaHex(hostKey), hostKey);
        hostKeyChanged = true;
      }
      if (body.regenerateViewerKey === true) {
        const viewerKey = randomKey();
        updates.push('viewer_key_hash = ?', 'viewer_invite = ?');
        params.push(shaHex(viewerKey), viewerKey);
        viewerKeyChanged = true;
      }

      if (!updates.length) return send(res, 400, 'Nada para atualizar.');

      params.push(row.id);
      await getPool().query(`UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`, params);

      if (hostKeyChanged) {
        await deleteSessionsByRole(row.id, 'host', session.id);
      }
      if (viewerKeyChanged) {
        await deleteSessionsByRole(row.id, 'viewer');
        const rt = live.get(slug);
        if (rt) {
          kickRole(rt, 'viewer', 'Chave dos espectadores alterada. Entre novamente.');
        }
      }

      const updated = await findRoomBySlug(slug);
      const rt = ensureLive(updated);
      broadcastRoom(rt, {
        type: 'room_updated',
        active: rt.active,
        maxViewers: rt.maxViewers,
      });

      let message = 'Sala atualizada.';
      if (viewerKeyChanged) {
        message = 'Link dos espectadores regenerado — quem já estava assistindo precisa entrar de novo.';
      } else if (hostKeyChanged) {
        message = 'Chave do host regenerada.';
      }

      return sendJson(res, 200, {
        ok: true,
        message,
        active: Boolean(updated.active),
        maxViewers: updated.max_viewers,
        links: viewerLinks(slug, updated.viewer_invite),
        viewerInvite: updated.viewer_invite || '',
        hostInvite: updated.host_invite || '',
      });
    } catch (e) {
      console.error(e);
      return send(res, 500, 'Erro ao atualizar');
    }
  }

  if (req.method === 'GET' && pathname === '/api/ice') {
    const cookies = parseCookies(req);
    const session = await getSession(cookies.wd_session);
    if (!session) return send(res, 401, 'Sessão inválida');
    return sendJson(res, 200, { iceServers: iceServers(crypto.randomBytes(4).toString('hex')) });
  }

  send(res, 404, 'Não encontrado');
};

async function main() {
  await initDb();

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => {
      console.error(e);
      send(res, 500, 'Erro interno');
    });
  });

  attachWs(server);

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\nErro: a porta ${cfg.port} já está em uso. Use --port.`);
    } else {
      console.error(`\nErro no servidor: ${e.message}`);
    }
    process.exit(1);
  });

  server.listen(cfg.port, '0.0.0.0', () => {
    console.log('\n=== Watchdesk API ===');
    console.log(`Porta:  ${cfg.port}`);
    console.log(`WS:     /api/ws`);
    console.log('DB:     ok');
    if (cfg.turnSecret && (cfg.turnHost || cfg.publicHost)) {
      console.log(`TURN:   ${cfg.turnHost || cfg.publicHost}:${cfg.turnPort}`);
    } else {
      console.log('TURN:   (não configurado — só STUN; ok em LAN)');
    }
    console.log('');
  });
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
