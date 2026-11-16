#!/usr/bin/env node
'use strict';

/**
 * Sala de tela — API
 *
 * Sobe MediaMTX (+ ffmpeg em screen/test), autentica por sala e faz proxy WHEP/WHIP.
 * Front fica no apps/web (Caddy em produção). Sem dependências npm.
 */

const { spawn, execFileSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- argumentos / env

const HELP = `
Uso: node src/index.js [opções]

  --port <n>           Porta HTTP da API (padrão: 7030 ou PORT)
  --webrtc-port <n>    Porta mídia WebRTC (padrão: 7031 ou WEBRTC_PORT)
  --monitors <n|auto>  Quantidade de monitores (padrão: auto)
  --fps <n>            Quadros por segundo (padrão: 30)
  --bitrate <kbps>     Bitrate de vídeo por monitor (padrão: 4000)
  --height <px>        Altura máxima (padrão: 1080)
  --encoder <nome>     libx264 | h264_nvenc | h264_qsv | h264_amf
  --source <tipo>      screen | browser | test (padrão: browser ou SOURCE)
  --room <id>          Sala inicial (screen/test); só a-z 0-9 _ -
  --key <senha>        Chave dos espectadores da sala inicial (screen/test)
  --host-key <senha>   Chave do host da sala inicial (screen/test)
  --public-host <h>    IP ou DNS público (WebRTC ICE); ou PUBLIC_HOST
  --ffmpeg <caminho>   Caminho do ffmpeg
  --mediamtx <caminho> Caminho do mediamtx
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
    if (!a.startsWith('--')) { console.error(`Argumento inesperado: ${a}\n${HELP}`); process.exit(1); }
    const name = a.slice(2);
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) { console.error(`Faltou valor para ${a}`); process.exit(1); }
    out[name] = val;
    i++;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repoBin = path.join(__dirname, '..', '..', '..', 'bin');

function findBin(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const local = path.join(repoBin, exe);
  const appLocal = path.join(__dirname, '..', 'bin', exe);
  if (fs.existsSync(local)) return local;
  if (fs.existsSync(appLocal)) return appLocal;
  return exe;
}

const cfg = {
  port: Number(args.port || process.env.PORT || 7030),
  webrtcPort: Number(args['webrtc-port'] || process.env.WEBRTC_PORT || 7031),
  monitors: args.monitors || 'auto',
  fps: Number(args.fps || process.env.FPS || 30),
  bitrate: Number(args.bitrate || process.env.BITRATE || 4000),
  height: Number(args.height || process.env.HEIGHT || 1080),
  encoder: args.encoder || process.env.ENCODER || 'libx264',
  source: args.source || process.env.SOURCE || 'browser',
  room: args.room || process.env.ROOM || '',
  key: args.key || process.env.VIEWER_KEY || '',
  hostKey: args['host-key'] || process.env.HOST_KEY || '',
  publicHost: args['public-host'] || process.env.PUBLIC_HOST || '',
  ffmpeg: args.ffmpeg || process.env.FFMPEG || findBin('ffmpeg'),
  mediamtx: args.mediamtx || process.env.MEDIAMTX || findBin('mediamtx'),
};

function fail(msg) { console.error(`Erro: ${msg}`); process.exit(1); }

if (!['screen', 'browser', 'test'].includes(cfg.source)) fail('--source deve ser screen, browser ou test.');
if (!['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'].includes(cfg.encoder)) fail('--encoder inválido.');
if (cfg.source === 'screen' && process.platform !== 'win32') {
  fail('Captura de tela real só está implementada para Windows. Use --source browser ou test.');
}
if (cfg.source !== 'browser') {
  if (!cfg.room) cfg.room = crypto.randomBytes(4).toString('hex');
  if (!cfg.key) cfg.key = crypto.randomBytes(6).toString('base64url');
  if (!cfg.hostKey) cfg.hostKey = crypto.randomBytes(6).toString('base64url');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(cfg.room)) fail('--room aceita apenas letras, números, _ e - (até 40).');
  if (cfg.key.length < 4) fail('--key precisa ter pelo menos 4 caracteres.');
  if (cfg.hostKey.length < 4) fail('--host-key precisa ter pelo menos 4 caracteres.');
}

const ROOM_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const PATH_RE = /^\/(whep|whip)\/([a-zA-Z0-9_-]{1,40})\/monitor([0-7])\/(whep|whip)(\/[0-9a-fA-F-]+)?$/;

// ----------------------------------------------------------------- monitores

function countMonitors() {
  if (cfg.monitors !== 'auto') {
    const n = Number(cfg.monitors);
    if (!Number.isInteger(n) || n < 1 || n > 8) fail('--monitors deve ser auto ou 1..8.');
    return n;
  }
  if (cfg.source === 'test') return 1;
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens.Count',
    ], { encoding: 'utf8' });
    const n = parseInt(out.trim(), 10);
    return n >= 1 ? n : 1;
  } catch {
    console.warn('Não consegui detectar os monitores; usando 1. Use --monitors N para forçar.');
    return 1;
  }
}

// ------------------------------------------------------------------ MediaMTX

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdesk-'));
const ffmpegPublishPass = crypto.randomBytes(16).toString('hex');
const internalViewerPass = crypto.randomBytes(16).toString('hex');
const internalPublisherPass = crypto.randomBytes(16).toString('hex');
const q = (s) => JSON.stringify(s);

function writeMediamtxConfig() {
  const extraHosts = cfg.publicHost ? `[${q(cfg.publicHost)}]` : '[]';
  const yml = `
logLevel: warn
api: yes
apiAddress: 127.0.0.1:9997
metrics: no
pprof: no
playback: no
rtmp: no
hls: no
srt: no

rtsp: yes
rtspAddress: 127.0.0.1:8554
rtspTransports: [tcp]

webrtc: yes
webrtcAddress: 127.0.0.1:8889
webrtcLocalUDPAddress: :${cfg.webrtcPort}
webrtcLocalTCPAddress: :${cfg.webrtcPort}
webrtcAdditionalHosts: ${extraHosts}
webrtcICEServers2:
  - url: stun:stun.l.google.com:19302

authMethod: internal
authInternalUsers:
  - user: host
    pass: ${q(ffmpegPublishPass)}
    ips: ['127.0.0.1', '::1']
    permissions:
      - action: publish
  - user: viewer
    pass: ${q(internalViewerPass)}
    permissions:
      - action: read
  - user: publisher
    pass: ${q(internalPublisherPass)}
    permissions:
      - action: publish
        path: "~^.+/monitor[0-7]$"
  - user: any
    pass:
    ips: ['127.0.0.1', '::1']
    permissions:
      - action: api

paths:
  all_others:
`;
  const file = path.join(workDir, 'mediamtx.yml');
  fs.writeFileSync(file, yml, { mode: 0o600 });
  return file;
}

// -------------------------------------------------------------------- ffmpeg

function ffmpegArgs(i, room) {
  const target = `rtsp://host:${ffmpegPublishPass}@127.0.0.1:8554/${room}/monitor${i}`;
  const scale = `scale=-2:'min(${cfg.height},ih)'`;
  const a = ['-hide_banner', '-loglevel', 'warning'];

  if (cfg.source === 'test') {
    const gens = [`testsrc2=size=1280x720:rate=${cfg.fps}`, `smptebars=size=1280x720:rate=${cfg.fps}`];
    a.push('-re', '-f', 'lavfi', '-i', gens[i % gens.length], '-vf', `${scale},format=yuv420p`);
  } else {
    a.push(
      '-f', 'lavfi', '-i', `ddagrab=output_idx=${i}:framerate=${cfg.fps}:draw_mouse=1`,
      '-vf', `hwdownload,format=bgra,${scale},format=yuv420p`,
    );
  }

  const br = `${cfg.bitrate}k`;
  const enc = {
    libx264: ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'baseline'],
    h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'll', '-profile:v', 'baseline'],
    h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-profile:v', 'baseline'],
    h264_amf: ['-c:v', 'h264_amf', '-usage', 'ultralowlatency', '-profile:v', 'constrained_baseline'],
  }[cfg.encoder];

  a.push(
    ...enc,
    '-b:v', br, '-maxrate', br, '-bufsize', `${Math.round(cfg.bitrate / 2)}k`,
    '-g', String(cfg.fps), '-bf', '0',
    '-an', '-f', 'rtsp', '-rtsp_transport', 'tcp', target,
  );
  return a;
}

// ---------------------------------------------------------- processos filhos

const children = new Set();
let shuttingDown = false;

function run(label, cmd, cmdArgs, { restart = false, onMissing } = {}) {
  const p = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.add(p);
  const pipe = (s) => s.on('data', (d) => {
    for (const line of String(d).split(/\r?\n/)) if (line.trim()) console.log(`[${label}] ${line}`);
  });
  pipe(p.stdout); pipe(p.stderr);
  p.on('error', (e) => {
    if (e.code === 'ENOENT' && onMissing) onMissing();
    else console.error(`[${label}] erro: ${e.message}`);
  });
  p.on('exit', (code) => {
    children.delete(p);
    if (shuttingDown) return;
    console.warn(`[${label}] terminou (código ${code}).`);
    if (restart) setTimeout(() => !shuttingDown && run(label, cmd, cmdArgs, { restart, onMissing }), 2000);
  });
  return p;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nEncerrando...');
  for (const p of children) p.kill();
  try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ok */ }
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());

// --------------------------------------------------------------- salas / auth

const sha = (s) => crypto.createHash('sha256').update(s).digest();
/** @type {Map<string, { hostKeyHash: Buffer, viewerKeyHash: Buffer }>} */
const rooms = new Map();

function hashEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseBasic(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return null;
  const [user, ...rest] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
  return { user, pass: rest.join(':') };
}

function claimRoom(roomId, hostKey, viewerKey) {
  if (!ROOM_RE.test(roomId)) return { ok: false, status: 400, msg: 'Nome de sala inválido.' };
  if (!hostKey || hostKey.length < 4) return { ok: false, status: 400, msg: 'Chave do host precisa ter pelo menos 4 caracteres.' };
  if (!viewerKey || viewerKey.length < 4) return { ok: false, status: 400, msg: 'Chave dos espectadores precisa ter pelo menos 4 caracteres.' };

  const existing = rooms.get(roomId);
  const hostKeyHash = sha(hostKey);
  if (existing && !hashEq(existing.hostKeyHash, hostKeyHash)) {
    return { ok: false, status: 401, msg: 'Chave do host incorreta.' };
  }
  rooms.set(roomId, { hostKeyHash, viewerKeyHash: sha(viewerKey) });
  return { ok: true };
}

function roomAuth(req, roomId, role) {
  const basic = parseBasic(req);
  if (!basic) return false;
  const expectUser = role === 'publisher' ? 'publisher' : 'viewer';
  if (basic.user !== expectUser) return false;
  const room = rooms.get(roomId);
  if (!room) return false;
  const hash = role === 'publisher' ? room.hostKeyHash : room.viewerKeyHash;
  return hashEq(sha(basic.pass), hash);
}

function basicHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
}

const failures = new Map();
function blocked(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < 60_000);
  failures.set(ip, list);
  return list.length >= 8;
}
function noteFailure(ip) { (failures.get(ip) || failures.set(ip, []).get(ip)).push(Date.now()); }

function listStreams(roomId) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 9997, path: '/v3/paths/list', timeout: 2000 }, (r) => {
      let body = '';
      r.on('data', (d) => { body += d; });
      r.on('end', () => {
        try {
          const prefix = `${roomId}/monitor`;
          const nums = (JSON.parse(body).items || [])
            .filter((p) => p.ready && p.name.startsWith(prefix))
            .map((p) => Number(p.name.slice(prefix.length)))
            .filter(Number.isInteger)
            .sort((a, b) => a - b);
          resolve(nums.map((n) => ({ name: `Tela ${n + 1}`, whep: `/whep/${roomId}/monitor${n}/whep` })));
        } catch { resolve([]); }
      });
    });
    req.on('error', () => resolve([]));
    req.on('timeout', () => { req.destroy(); resolve([]); });
  });
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

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  }
  return out;
}

function viewerLinks(roomId) {
  const hosts = [...(cfg.publicHost ? [cfg.publicHost] : []), ...lanAddresses()];
  return hosts.map((h) => {
    const https = Boolean(cfg.publicHost && h === cfg.publicHost);
    return `${https ? 'https' : 'http'}://${h}/sala/${roomId}`;
  });
}

function proxyMedia(req, res, { pathname, isWhip, roomId, ip }) {
  const role = isWhip ? 'publisher' : 'viewer';
  if (!roomAuth(req, roomId, role)) {
    noteFailure(ip);
    return send(res, 401, 'Chave incorreta');
  }

  const fwd = {};
  for (const h of ['content-type', 'content-length', 'if-match']) {
    if (req.headers[h]) fwd[h] = req.headers[h];
  }
  fwd.authorization = isWhip
    ? basicHeader('publisher', internalPublisherPass)
    : basicHeader('viewer', internalViewerPass);

  const upstreamPath = pathname.replace(/^\/(whep|whip)/, '');
  const prefix = isWhip ? '/whip' : '/whep';
  const up = http.request({
    host: '127.0.0.1', port: 8889, method: req.method,
    path: upstreamPath, headers: fwd,
  }, (ur) => {
    if (ur.statusCode === 401) noteFailure(ip);
    const h = {};
    if (ur.headers['content-type']) h['Content-Type'] = ur.headers['content-type'];
    if (ur.headers.etag) h.ETag = ur.headers.etag;
    if (ur.headers.location) {
      try { h.Location = prefix + new URL(ur.headers.location, `http://up${upstreamPath}`).pathname; } catch { /* ok */ }
    }
    res.writeHead(ur.statusCode, { 'Cache-Control': 'no-store', ...h });
    ur.pipe(res);
  });
  up.on('error', () => send(res, 502, 'Servidor de mídia indisponível'));
  return req.pipe(up);
}

const handler = async (req, res) => {
  const ip = req.socket.remoteAddress || '?';
  const url = new URL(req.url, 'http://x');
  const { pathname } = url;

  if (pathname === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true }), { 'Content-Type': 'application/json' });
  }

  const mediaMatch = pathname.match(PATH_RE);
  const needsRate =
    pathname.startsWith('/api/rooms') ||
    pathname === '/api/streams' ||
    pathname === '/api/host-check' ||
    mediaMatch;

  if (needsRate && blocked(ip)) {
    return send(res, 429, 'Muitas tentativas. Aguarde 1 minuto.', { 'Retry-After': '60' });
  }

  // PUT /api/rooms/:room  { hostKey, viewerKey }
  const roomPut = pathname.match(/^\/api\/rooms\/([a-zA-Z0-9_-]{1,40})$/);
  if (req.method === 'PUT' && roomPut) {
    try {
      const body = await readJson(req);
      const result = claimRoom(roomPut[1], body.hostKey || '', body.viewerKey || '');
      if (!result.ok) {
        if (result.status === 401) noteFailure(ip);
        return send(res, result.status, result.msg);
      }
      return send(res, 200, JSON.stringify({
        room: roomPut[1],
        links: viewerLinks(roomPut[1]),
      }), { 'Content-Type': 'application/json' });
    } catch {
      return send(res, 400, 'JSON inválido');
    }
  }

  // POST /api/rooms  { room, hostKey, viewerKey }
  if (req.method === 'POST' && pathname === '/api/rooms') {
    try {
      const body = await readJson(req);
      const roomId = String(body.room || '');
      const result = claimRoom(roomId, body.hostKey || '', body.viewerKey || '');
      if (!result.ok) {
        if (result.status === 401) noteFailure(ip);
        return send(res, result.status, result.msg);
      }
      return send(res, 200, JSON.stringify({
        room: roomId,
        links: viewerLinks(roomId),
      }), { 'Content-Type': 'application/json' });
    } catch {
      return send(res, 400, 'JSON inválido');
    }
  }

  if (pathname === '/api/streams') {
    const roomId = url.searchParams.get('room') || '';
    if (!ROOM_RE.test(roomId)) return send(res, 400, 'Informe ?room=');
    if (!roomAuth(req, roomId, 'viewer')) {
      noteFailure(ip);
      return send(res, 401, 'Chave incorreta');
    }
    const streams = await listStreams(roomId);
    return send(res, 200, JSON.stringify({ streams }), { 'Content-Type': 'application/json' });
  }

  if (pathname === '/api/host-check') {
    const roomId = url.searchParams.get('room') || '';
    if (!ROOM_RE.test(roomId)) return send(res, 400, 'Informe ?room=');
    if (!rooms.has(roomId)) return send(res, 404, 'Sala não registrada. Defina as chaves primeiro.');
    if (!roomAuth(req, roomId, 'publisher')) {
      noteFailure(ip);
      return send(res, 401, 'Chave incorreta');
    }
    return send(res, 200, JSON.stringify({
      room: roomId,
      links: viewerLinks(roomId),
    }), { 'Content-Type': 'application/json' });
  }

  if (mediaMatch) {
    const [, kind, roomId] = mediaMatch;
    const isWhip = kind === 'whip';
    if (isWhip && cfg.source !== 'browser' && cfg.source !== 'test') {
      // WHIP só faz sentido com publicação pelo navegador; em screen o ffmpeg publica.
    }
    if (isWhip && cfg.source === 'screen') {
      return send(res, 404, 'WHIP indisponível no modo screen');
    }
    return proxyMedia(req, res, { pathname, isWhip, roomId, ip });
  }

  send(res, 404, 'Não encontrado');
};

const server = http.createServer((req, res) => {
  handler(req, res).catch((e) => {
    console.error(e);
    send(res, 500, 'Erro interno');
  });
});

// ---------------------------------------------------------------------- main

function main() {
  const confFile = writeMediamtxConfig();

  run('mediamtx', cfg.mediamtx, [confFile], {
    onMissing: () => fail('mediamtx não encontrado. Coloque em ./bin ou use --mediamtx / MEDIAMTX.'),
  });

  if (cfg.source !== 'browser') {
    claimRoom(cfg.room, cfg.hostKey, cfg.key);
    const monitorCount = countMonitors();
    setTimeout(() => {
      for (let i = 0; i < monitorCount; i++) {
        run(`ffmpeg:monitor${i + 1}`, cfg.ffmpeg, ffmpegArgs(i, cfg.room), {
          restart: true,
          onMissing: () => fail('ffmpeg não encontrado. Coloque em ./bin ou use --ffmpeg / FFMPEG.'),
        });
      }
    }, 1200);
  }

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\nErro: a porta ${cfg.port} já está em uso. Use --port.`);
    } else {
      console.error(`\nErro no servidor: ${e.message}`);
    }
    shutdown(1);
  });

  server.listen(cfg.port, '0.0.0.0', () => {
    console.log('\n=== Sala de tela API ===');
    console.log(`Fonte:  ${cfg.source}`);
    console.log(`Porta:  ${cfg.port}`);
    if (cfg.publicHost) console.log(`ICE:    ${cfg.publicHost}`);
    if (cfg.source === 'browser') {
      console.log('\nCada transmissor define hostKey + viewerKey em PUT /api/rooms/:room');
      console.log('Front: /host/:room e /sala/:room (Vite/Caddy)\n');
    } else {
      console.log(`Sala:   ${cfg.room}`);
      console.log(`Viewer: ${cfg.key}`);
      console.log(`Host:   ${cfg.hostKey}\n`);
    }
    console.log(`Liberar firewall (prod): UDP+TCP ${cfg.webrtcPort}. Ctrl+C para encerrar.\n`);
  });
}

main();
