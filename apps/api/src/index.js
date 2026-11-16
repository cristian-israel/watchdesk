#!/usr/bin/env node
'use strict';

/**
 * Watchdesk API — salas MySQL, sessões (cookie), chat, sinalização WebRTC P2P + ICE/TURN.
 */

require('./load-env');

const http = require('http');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');
const { initDb, getPool, healthCheck } = require('./db');

const HELP = `
Uso: node src/index.js [opções]

  --port <n>           Porta HTTP/WS (padrão: 7030 ou PORT)
  --public-host <h>    IP/DNS público TURN (ou PUBLIC_HOST)
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

const ROOM_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const NAME_RE = /^.{1,80}$/;
const MAX_SLOTS = 8;
const ICE_TTL_SEC = 3600;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICE_TTL_SEC = 365 * 24 * 60 * 60;
const CHAT_HISTORY = 100;
const CHAT_MAX = 500;

const shaHex = (s) => crypto.createHash('sha256').update(s).digest('hex');

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
 * }} Client
 */

function hashEqHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

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
    };
    live.set(row.slug, r);
  } else {
    r.roomDbId = row.id;
    r.maxViewers = row.max_viewers;
    r.active = Boolean(row.active);
  }
  return r;
}

const failures = new Map();
function blocked(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < 60_000);
  failures.set(ip, list);
  return list.length >= 8;
}
function noteFailure(ip) {
  (failures.get(ip) || failures.set(ip, []).get(ip)).push(Date.now());
}

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

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isSecureReq(req) {
  const xf = String(req.headers['x-forwarded-proto'] || '');
  return xf.split(',')[0].trim() === 'https';
}

function cookieHeader(name, value, maxAge, req) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (isSecureReq(req)) parts.push('Secure');
  return parts.join('; ');
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

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
  return out;
}

function viewerLinks(slug) {
  const hosts = [...(cfg.publicHost ? [cfg.publicHost] : []), ...lanAddresses()];
  return hosts.map((h) => {
    const https = Boolean(cfg.publicHost && h === cfg.publicHost);
    return `${https ? 'https' : 'http'}://${h}/sala/${slug}`;
  });
}

function turnUsername(userId) {
  const expiry = Math.floor(Date.now() / 1000) + ICE_TTL_SEC;
  return `${expiry}:${userId}`;
}

function turnCredential(username) {
  return crypto.createHmac('sha1', cfg.turnSecret).update(username).digest('base64');
}

function iceServers(userId = 'anon') {
  /** @type {Array<{ urls: string | string[], username?: string, credential?: string }>} */
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const host = cfg.turnHost || cfg.publicHost;
  if (cfg.turnSecret && host) {
    const username = turnUsername(userId);
    const credential = turnCredential(username);
    const base = `${host}:${cfg.turnPort}`;
    servers.push({
      urls: [`turn:${base}?transport=udp`, `turn:${base}?transport=tcp`],
      username,
      credential,
    });
  }
  return servers;
}

function normalizeName(name) {
  const n = String(name || '').trim();
  if (!NAME_RE.test(n)) return null;
  return n;
}

function validateKey(key) {
  return typeof key === 'string' && key.length >= 4 && key.length <= 128;
}

// ----------------------------------------------------------------- DB helpers

async function findRoomBySlug(slug) {
  const [rows] = await getPool().query('SELECT * FROM rooms WHERE slug = ? LIMIT 1', [slug]);
  return rows[0] || null;
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  const fromHeader = xf.split(',')[0].trim();
  return (fromHeader || req.socket.remoteAddress || '').slice(0, 64);
}

function isDeviceId(id) {
  return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
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
    links: viewerLinks(row.slug),
  };
}

function mePayload(device, room) {
  return {
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
    `SELECT s.*, r.slug, r.active, r.max_viewers, r.creator_name
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

async function loadChat(roomId) {
  const [rows] = await getPool().query(
    `SELECT id, author_name AS authorName, role, body, created_at AS createdAt
     FROM chat_messages WHERE room_id = ? ORDER BY id DESC LIMIT ?`,
    [roomId, CHAT_HISTORY],
  );
  return rows.reverse().map((r) => ({
    id: r.id,
    authorName: r.authorName,
    role: r.role,
    body: r.body,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
  }));
}

async function insertChat(roomId, authorName, role, body) {
  const [result] = await getPool().query(
    'INSERT INTO chat_messages (room_id, author_name, role, body) VALUES (?, ?, ?, ?)',
    [roomId, authorName, role, body],
  );
  return {
    id: result.insertId,
    authorName,
    role,
    body,
    createdAt: new Date().toISOString(),
  };
}

function sessionPayload(row) {
  return {
    room: row.slug,
    role: row.role,
    displayName: row.display_name,
    active: Boolean(row.active),
    maxViewers: row.max_viewers,
    links: viewerLinks(row.slug),
  };
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
    list.push({ peerId: room.host.peerId, role: 'host', displayName: room.host.displayName });
  }
  for (const v of room.viewers.values()) {
    list.push({ peerId: v.peerId, role: 'viewer', displayName: v.displayName });
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
    broadcastRoom(room, {
      type: 'viewer_left',
      peerId: client.peerId,
      displayName: client.displayName,
    });
    broadcastRoom(room, { type: 'roster', members: roster(room) });
  }
}

async function handleHello(ws, msg, req, ip) {
  const cookies = parseCookies(req);
  let session = await getSession(cookies.wd_session);

  // Optional override: login fields if no valid session
  if (!session && msg.room && msg.role && msg.key) {
    wsSend(ws, { type: 'error', message: 'Faça login pela página antes de conectar.' });
    ws.close();
    return;
  }

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
  /** @type {Client} */
  const client = {
    ws,
    peerId,
    role: session.role,
    roomSlug: session.slug,
    displayName: session.display_name,
    sessionId: session.id,
    deviceId: session.device_id || '',
  };
  ws.watchdeskClient = client;

  if (session.role === 'host') {
    room.host = client;
  } else {
    room.viewers.set(peerId, client);
  }

  const history = await loadChat(room.roomDbId);

  wsSend(ws, {
    type: 'welcome',
    peerId,
    role: session.role,
    room: session.slug,
    displayName: session.display_name,
    slots: slotList(room),
    viewers:
      session.role === 'host'
        ? [...room.viewers.values()].map((v) => ({ peerId: v.peerId, displayName: v.displayName }))
        : undefined,
    iceServers: iceServers(peerId),
    maxViewers: room.maxViewers,
    active: room.active,
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
      { type: 'viewer_joined', peerId, displayName: session.display_name },
      peerId,
    );
  }
}

function handleSignal(client, msg) {
  const room = live.get(client.roomSlug);
  if (!room) return;

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
        const saved = await insertChat(room.roomDbId, client.displayName, client.role, body);
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
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname !== '/api/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || '?';
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
        void handleHello(ws, msg, req, ip);
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
  const ip = req.socket.remoteAddress || '?';
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
    pathname === '/api/session' ||
    pathname === '/api/logout' ||
    pathname === '/api/ice';

  if (needsRate && blocked(ip)) {
    return send(res, 429, 'Muitas tentativas. Aguarde 1 minuto.', { 'Retry-After': '60' });
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

  // POST /api/rooms — create
  if (req.method === 'POST' && pathname === '/api/rooms') {
    try {
      const device = await ensureDevice(req, res);
      const body = await readJson(req);
      const slug = String(body.slug || body.room || '');
      const displayName = device.display_name || '';
      const hostKey = body.hostKey || '';
      const viewerKey = body.viewerKey || '';
      let maxViewers = Number(body.maxViewers ?? 8);
      if (!Number.isInteger(maxViewers) || maxViewers < 1 || maxViewers > 8) maxViewers = 8;

      if (!ROOM_RE.test(slug)) return send(res, 400, 'Nome de sala inválido.');
      if (!displayName) return send(res, 400, 'Informe seu nome.');
      if (!validateKey(hostKey)) return send(res, 400, 'Chave do host inválida (mín. 4).');
      if (!validateKey(viewerKey)) return send(res, 400, 'Chave dos espectadores inválida (mín. 4).');

      const owned = await findRoomByDevice(device.id);
      if (owned) return send(res, 409, 'Este aparelho já tem uma sala. Exclua-a para criar outra.');

      const existing = await findRoomBySlug(slug);
      if (existing) {
        noteFailure(ip);
        return send(res, 409, 'Sala já existe. Entre como host ou escolha outro nome.');
      }

      const [ins] = await getPool().query(
        `INSERT INTO rooms (slug, host_key_hash, viewer_key_hash, creator_name, max_viewers, active, device_id)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
        [slug, shaHex(hostKey), shaHex(viewerKey), displayName, maxViewers, device.id],
      );
      const roomId = ins.insertId;
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
        if (!validateKey(hostKey)) return send(res, 400, 'Chave do host inválida.');
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
      if (!validateKey(viewerKey)) return send(res, 400, 'Chave inválida.');

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
      return sendJson(res, 200, {
        ok: true,
        ...sessionPayload({ ...row, role: 'viewer', display_name: displayName }),
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
      if (body.hostKey !== undefined && body.hostKey !== '') {
        if (!validateKey(body.hostKey)) return send(res, 400, 'Nova chave do host inválida.');
        updates.push('host_key_hash = ?');
        params.push(shaHex(body.hostKey));
        hostKeyChanged = true;
      }
      if (body.viewerKey !== undefined && body.viewerKey !== '') {
        if (!validateKey(body.viewerKey)) return send(res, 400, 'Nova chave dos espectadores inválida.');
        updates.push('viewer_key_hash = ?');
        params.push(shaHex(body.viewerKey));
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
        message = 'Chave dos espectadores atualizada — quem já estava assistindo precisa entrar de novo.';
      } else if (hostKeyChanged) {
        message = 'Chave do host atualizada.';
      }

      return sendJson(res, 200, {
        ok: true,
        message,
        active: Boolean(updated.active),
        maxViewers: updated.max_viewers,
        links: viewerLinks(slug),
      });
    } catch (e) {
      console.error(e);
      return send(res, 500, 'Erro ao atualizar');
    }
  }

  // GET /api/ice (session-based)
  if (pathname === '/api/ice') {
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
