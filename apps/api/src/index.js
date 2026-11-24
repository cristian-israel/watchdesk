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
const liveRoom = require('./live-room');
const {
  ROOM_RE,
  WS_MAX_PAYLOAD,
  normalizeName,
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

const { MAX_SLOTS } = liveRoom;
const ICE_TTL_SEC = 3600;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICE_TTL_SEC = 365 * 24 * 60 * 60;
const CHAT_HISTORY = 100;
const CHAT_MAX = 500;

/** Runtime presence by slug */
/** @type {Map<string, RuntimeRoom>} */
const live = new Map();

function ensureLive(row) {
  return liveRoom.ensureLive(live, row);
}

async function touchRecentRoom(deviceId, slug, label) {
  if (!deviceId || !slug) return;
  await getPool().query(
    `INSERT INTO recent_rooms (device_id, room_slug, room_label, last_seen_at)
     VALUES (?, ?, ?, UTC_TIMESTAMP(3))
     ON DUPLICATE KEY UPDATE
       room_label = VALUES(room_label),
       last_seen_at = VALUES(last_seen_at)`,
    [deviceId, slug, String(label || '').slice(0, 80)],
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
    `SELECT room_slug AS slug, room_label AS label, last_seen_at AS lastSeenAt
     FROM recent_rooms WHERE device_id = ? ORDER BY last_seen_at DESC LIMIT ?`,
    [deviceId, RECENT_LIMIT],
  );
  return rows.map((r) => ({
    slug: r.slug,
    label: r.label || '',
    lastSeenAt: r.lastSeenAt,
  }));
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

/** Path relativo — o front monta a URL com location.origin (padrão frontier/alias). */
function viewerLinks(slug) {
  return [`/sala/${slug}`];
}

function normalizeJoinMode(value) {
  return value === 'open' ? 'open' : 'ask';
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

async function listRoomsByDevice(deviceId) {
  const [rows] = await getPool().query(
    'SELECT * FROM rooms WHERE device_id = ? ORDER BY updated_at DESC',
    [deviceId],
  );
  return rows;
}

function roomSummary(row) {
  return {
    slug: row.slug,
    active: Boolean(row.active),
    maxViewers: row.max_viewers,
    joinMode: normalizeJoinMode(row.join_mode),
    links: viewerLinks(row.slug),
  };
}

function mePayload(device, rooms) {
  return {
    deviceId: device.id,
    displayName: device.display_name || '',
    rooms: (rooms || []).map(roomSummary),
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
    for (const pending of room.pending.values()) touch(pending);
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
  for (const pending of rt.pending.values()) closeOne(pending);
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
    `SELECT s.*, r.slug, r.active, r.max_viewers, r.creator_name, r.join_mode, r.device_id AS room_device_id
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
  return {
    room: row.slug,
    role: row.role,
    displayName: row.display_name,
    active: Boolean(row.active),
    maxViewers: row.max_viewers,
    joinMode: normalizeJoinMode(row.join_mode),
    links: viewerLinks(row.slug),
  };
}

// ----------------------------------------------------------------- WebSocket

const wsSend = liveRoom.wsSend;
const slotList = liveRoom.slotList;
const roster = liveRoom.roster;
const pendingList = liveRoom.pendingList;
const broadcastRoom = liveRoom.broadcastRoom;
const findClient = liveRoom.findClient;

function detachClient(client) {
  liveRoom.detachClient(live, client);
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
  const deviceId = session.device_id || '';
  const joinMode = room.joinMode;
  const alreadyAdmitted =
    session.role === 'viewer' &&
    (joinMode === 'open' || (deviceId && room.admittedDevices.has(deviceId)));

  if (session.role === 'viewer' && alreadyAdmitted && room.viewers.size >= room.maxViewers) {
    wsSend(ws, { type: 'error', message: 'Sala cheia.' });
    ws.close();
    return;
  }

  const peerId = crypto.randomBytes(8).toString('hex');

  liveRoom.resolveHostJoin(room, {
    sessionRole: session.role,
    incomingWs: ws,
  });

  const asPending = session.role === 'viewer' && joinMode === 'ask' && !alreadyAdmitted;

  const client = {
    ws,
    peerId,
    role: asPending ? 'pending' : session.role,
    roomSlug: session.slug,
    displayName: session.display_name,
    sessionId: session.id,
    deviceId,
  };
  ws.watchdeskClient = client;

  if (session.role === 'host') {
    room.host = client;
  } else if (asPending) {
    room.pending.set(peerId, client);
  } else {
    room.viewers.set(peerId, client);
    if (deviceId) room.admittedDevices.add(deviceId);
  }

  const history = await loadChat(room.roomDbId);

  wsSend(ws, {
    type: 'welcome',
    peerId,
    role: session.role,
    room: session.slug,
    displayName: session.display_name,
    slots: asPending ? [] : slotList(room),
    viewers:
      session.role === 'host'
        ? [...room.viewers.values()].map((v) => ({
            peerId: v.peerId,
            displayName: v.displayName,
          }))
        : undefined,
    pending: session.role === 'host' ? pendingList(room) : undefined,
    iceServers: iceServers(peerId),
    maxViewers: room.maxViewers,
    active: room.active,
    joinMode,
    admitStatus: asPending ? 'pending' : session.role === 'viewer' ? 'admitted' : undefined,
  });

  if (!asPending) {
    wsSend(ws, { type: 'chat_history', messages: history });
  }

  if (client.role === 'host') {
    broadcastRoom(room, { type: 'roster', members: roster(room) });
    broadcastRoom(
      room,
      { type: 'host_joined', peerId, displayName: session.display_name },
      peerId,
    );
  } else if (client.role === 'pending') {
    if (room.host) {
      wsSend(room.host.ws, {
        type: 'admit_request',
        peerId,
        displayName: session.display_name,
      });
      wsSend(room.host.ws, { type: 'pending', pending: pendingList(room) });
    }
  } else if (client.role === 'viewer') {
    broadcastRoom(room, { type: 'roster', members: roster(room) });
    broadcastRoom(
      room,
      { type: 'viewer_joined', peerId, displayName: session.display_name },
      peerId,
    );
    if (client.deviceId) {
      void touchRecentRoom(client.deviceId, session.slug, roomRow.creator_name || session.slug);
    }
  }
}

function handleSignal(client, msg) {
  const room = live.get(client.roomSlug);
  if (!room) return;

  if (client.role === 'host' && msg.type === 'admit') {
    const peerId = String(msg.peerId || '');
    const accept = Boolean(msg.accept);
    const result = accept
      ? liveRoom.promotePending(room, peerId)
      : liveRoom.denyPending(room, peerId);
    if (!result.ok) {
      wsSend(client.ws, { type: 'error', message: result.message });
      return;
    }
    if (accept) {
      if (result.client?.deviceId) {
        void touchRecentRoom(result.client.deviceId, room.slug, room.slug);
      }
      void loadChat(room.roomDbId).then((messages) => {
        if (result.client) wsSend(result.client.ws, { type: 'chat_history', messages });
      });
    } else if (result.client?.sessionId) {
      void deleteSession(result.client.sessionId);
    }
    return;
  }

  if (client.role === 'pending') return;

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
    if (client.role !== 'host' && client.role !== 'viewer') return;
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
  if (!target || target.role === 'pending') return;

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
  liveRoom.kickRole(room, role, reason);
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
    pathname === '/api/me/rooms' ||
    pathname === '/api/me/recent' ||
    pathname === '/api/session' ||
    pathname === '/api/logout' ||
    pathname === '/api/ice';

  if (needsRate && blocked(ip)) {
    return send(res, 429, 'Muitas tentativas. Aguarde 1 minuto.', { 'Retry-After': '60' });
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
    const rooms = await listRoomsByDevice(device.id);
    return sendJson(res, 200, mePayload(device, rooms));
  }

  // GET /api/me/rooms
  if (req.method === 'GET' && pathname === '/api/me/rooms') {
    const device = await ensureDevice(req, res);
    const rooms = await listRoomsByDevice(device.id);
    return sendJson(res, 200, { rooms: rooms.map(roomSummary) });
  }

  // PATCH /api/me
  if (req.method === 'PATCH' && pathname === '/api/me') {
    try {
      const device = await ensureDevice(req, res);
      const body = await readJson(req);
      const displayName = normalizeName(body.displayName);
      if (!displayName) return send(res, 400, 'Informe seu nome.');
      await renameDevice(device.id, displayName);
      const rooms = await listRoomsByDevice(device.id);
      return sendJson(res, 200, mePayload({ ...device, display_name: displayName }, rooms));
    } catch (e) {
      console.error(e);
      return send(res, 400, 'Não foi possível salvar o nome.');
    }
  }

  // POST /api/rooms — cria + sessão host
  if (req.method === 'POST' && pathname === '/api/rooms') {
    try {
      const device = await ensureDevice(req, res);
      const body = await readJson(req);
      const displayName = device.display_name || '';
      let maxViewers = Number(body.maxViewers ?? 8);
      if (!Number.isInteger(maxViewers) || maxViewers < 1 || maxViewers > 8) maxViewers = 8;
      const joinMode = normalizeJoinMode(body.joinMode);

      if (!displayName) return send(res, 400, 'Informe seu nome.');

      let slug = '';
      let roomId = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        slug = randomSlug();
        if (!ROOM_RE.test(slug)) continue;
        try {
          const [ins] = await getPool().query(
            `INSERT INTO rooms
              (slug, device_id, creator_name, join_mode, max_viewers, active)
             VALUES (?, ?, ?, ?, ?, 1)`,
            [slug, device.id, displayName, joinMode, maxViewers],
          );
          roomId = ins.insertId;
          break;
        } catch (e) {
          if (e && e.code === 'ER_DUP_ENTRY') continue;
          throw e;
        }
      }
      if (!roomId) return send(res, 500, 'Não foi possível criar a sala.');

      const sess = await createSession(roomId, 'host', displayName, device.id);
      setSessionCookie(res, sess.id, req);
      const row = await findRoomBySlug(slug);
      ensureLive(row);
      return sendJson(res, 201, {
        ok: true,
        ...sessionPayload({ ...row, role: 'host', display_name: displayName }),
      });
    } catch (e) {
      if (e && e.code === 'ER_DUP_ENTRY') return send(res, 409, 'Sala já existe.');
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
      joinMode: normalizeJoinMode(row.join_mode),
    });
  }

  // POST /api/rooms/:slug/resume — dono retoma como host
  const roomResume = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]{1,40})\/resume$/);
  if (req.method === 'POST' && roomResume) {
    try {
      const device = await ensureDevice(req, res);
      const slug = roomResume[1];
      const displayName = device.display_name || '';
      if (!displayName) return send(res, 400, 'Informe seu nome.');

      const row = await findRoomBySlug(slug);
      if (!row) return send(res, 404, 'Sala não encontrada.');
      if (row.device_id !== device.id) {
        return send(res, 403, 'Só o aparelho que criou a sala pode transmitir.');
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

  // POST /api/rooms/:slug/viewer — link only
  const roomViewer = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]{1,40})\/viewer$/);
  if (req.method === 'POST' && roomViewer) {
    try {
      const device = await ensureDevice(req, res);
      const slug = roomViewer[1];
      const displayName = device.display_name || '';
      if (!displayName) return send(res, 400, 'Informe seu nome.');

      const row = await findRoomBySlug(slug);
      if (!row) return send(res, 404, 'Sala não encontrada.');
      if (!row.active) return send(res, 403, 'Sala desativada.');

      const rt = ensureLive(row);
      const joinMode = normalizeJoinMode(row.join_mode);
      if (joinMode === 'open' && rt.viewers.size >= rt.maxViewers) {
        return send(res, 403, 'Sala cheia.');
      }

      const sess = await createSession(row.id, 'viewer', displayName, device.id);
      setSessionCookie(res, sess.id, req);
      if (joinMode === 'open') {
        await touchRecentRoom(device.id, slug, row.creator_name || slug);
      }
      return sendJson(res, 200, {
        ok: true,
        status: joinMode === 'ask' ? 'pending' : 'admitted',
        ...sessionPayload({ ...row, role: 'viewer', display_name: displayName }),
      });
    } catch (e) {
      console.error(e);
      return send(res, 500, 'Erro ao entrar');
    }
  }

  // DELETE /api/rooms/:slug
  const roomDelete = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]{1,40})$/);
  if (req.method === 'DELETE' && roomDelete) {
    const device = await ensureDevice(req, res);
    const slug = roomDelete[1];
    const row = await findRoomBySlug(slug);
    if (!row) return send(res, 404, 'Sala não encontrada.');
    if (row.device_id !== device.id) return send(res, 403, 'Só o dono pode excluir a sala.');
    await getPool().query('DELETE FROM rooms WHERE id = ? AND device_id = ?', [row.id, device.id]);
    dropLiveRoom(slug, 'Sala excluída.');
    const rooms = await listRoomsByDevice(device.id);
    return sendJson(res, 200, { ok: true, ...mePayload(device, rooms) });
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
      if (body.joinMode !== undefined) {
        updates.push('join_mode = ?');
        params.push(normalizeJoinMode(body.joinMode));
      }

      if (!updates.length) return send(res, 400, 'Nada para atualizar.');

      params.push(row.id);
      await getPool().query(`UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`, params);

      const updated = await findRoomBySlug(slug);
      const rt = ensureLive(updated);
      broadcastRoom(rt, {
        type: 'room_updated',
        active: rt.active,
        maxViewers: rt.maxViewers,
        joinMode: rt.joinMode,
      });

      return sendJson(res, 200, {
        ok: true,
        message: 'Sala atualizada.',
        active: Boolean(updated.active),
        maxViewers: updated.max_viewers,
        joinMode: normalizeJoinMode(updated.join_mode),
        links: viewerLinks(slug),
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
