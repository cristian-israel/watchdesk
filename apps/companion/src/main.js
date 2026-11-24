'use strict';

/**
 * Watchdesk Companion (Electron) — Windows + Linux.
 *
 * Fluxo:
 * 1. Checa /api/companion/version (banner se desatualizado).
 * 2. Login host (POST /api/rooms/:slug/host) com cookie jar.
 * 3. WS hello clientKind=companion + captura desktopCapturer.
 * 4. DataChannel watchdesk-input → applyInput (Win user32 / Linux xdotool).
 *
 * Env:
 *   WATCHDESK_ORIGIN=https://watchdesk-giganet.ilumea.com.br
 *   WATCHDESK_ROOM=slug
 *   WATCHDESK_HOST_KEY=...
 */

const { app, BrowserWindow, desktopCapturer, ipcMain, shell, screen, session } = require('electron');
const path = require('path');
const { LOCAL_VERSION, cmpSemver, fetchLatest } = require('./version');
const { applyInput, setScreenSize, platform } = require('./input');
const { parseInput } = require('./protocol');

// NixOS / sandboxes restritivos
if (process.env.WATCHDESK_ELECTRON_NO_SANDBOX === '1' || platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
}

/** @type {BrowserWindow | null} */
let win = null;
let updateInfo = null;
/** @type {string} */
let sessionCookie = '';
/** @type {string} */
let deviceCookie = '';

function createWindow() {
  win = new BrowserWindow({
    width: 480,
    height: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'ui.html'));
}

app.whenReady().then(async () => {
  const primary = screen.getPrimaryDisplay().size;
  setScreenSize(primary.width, primary.height);

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const jar = [deviceCookie, sessionCookie].filter(Boolean).join('; ');
    if (jar && /\/api\/ws/.test(details.url)) {
      details.requestHeaders.Cookie = jar;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  const origin = process.env.WATCHDESK_ORIGIN || '';
  if (origin) {
    updateInfo = await fetchLatest(origin);
  }
  createWindow();
});

ipcMain.handle('companion:meta', () => ({
  version: LOCAL_VERSION,
  update: updateInfo,
  outdated:
    updateInfo && updateInfo.version
      ? cmpSemver(LOCAL_VERSION, updateInfo.version) < 0
      : false,
  mandatory:
    updateInfo &&
    updateInfo.mandatory &&
    updateInfo.minVersion &&
    cmpSemver(LOCAL_VERSION, updateInfo.minVersion) < 0,
}));

ipcMain.handle('companion:open-download', async () => {
  const origin = (process.env.WATCHDESK_ORIGIN || '').replace(/\/$/, '');
  const path =
    platform === 'linux'
      ? updateInfo?.downloadUrlLinux || updateInfo?.downloadUrl
      : updateInfo?.downloadUrl || updateInfo?.downloadUrlLinux;
  if (!path) return false;
  const url = String(path).startsWith('http') ? path : `${origin}${path}`;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('companion:list-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 0, height: 0 },
  });
  return sources.map((s) => ({ id: s.id, name: s.name }));
});

ipcMain.on('companion:input', (_ev, raw) => {
  const msg = typeof raw === 'string' ? parseInput(raw) : raw;
  if (msg) applyInput(msg);
});

ipcMain.handle('companion:env', () => ({
  origin: process.env.WATCHDESK_ORIGIN || '',
  room: process.env.WATCHDESK_ROOM || '',
  hasHostKey: Boolean(process.env.WATCHDESK_HOST_KEY),
}));

function absorbCookies(r) {
  const raw = r.headers.getSetCookie?.() || [];
  const list = raw.length ? raw : [r.headers.get('set-cookie')].filter(Boolean);
  for (const c of list) {
    const s = String(c).match(/wd_session=[^;]+/);
    if (s) sessionCookie = s[0];
    const d = String(c).match(/wd_device=[^;]+/);
    if (d) deviceCookie = d[0];
  }
}

function cookieHeader() {
  return [deviceCookie, sessionCookie].filter(Boolean).join('; ');
}

ipcMain.handle('companion:host-login', async (_e, { origin, room, hostKey, displayName }) => {
  const base = String(origin || '').replace(/\/$/, '');
  const name = String(displayName || 'Companion').slice(0, 80);

  const meRes = await fetch(`${base}/api/me`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
    },
    body: JSON.stringify({ displayName: name }),
  });
  absorbCookies(meRes);
  if (!meRes.ok) {
    throw new Error((await meRes.text()) || 'Não foi possível definir o nome do companion.');
  }

  const r = await fetch(`${base}/api/rooms/${encodeURIComponent(room)}/host`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(),
    },
    body: JSON.stringify({ hostKey: hostKey || '' }),
  });
  absorbCookies(r);
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok) {
    throw new Error(typeof data === 'string' ? data : data?.message || `HTTP ${r.status}`);
  }
  const u = new URL(base);
  if (sessionCookie) {
    await session.defaultSession.cookies.set({
      url: base,
      name: 'wd_session',
      value: sessionCookie.replace(/^wd_session=/, ''),
      path: '/',
      secure: u.protocol === 'https:',
      httpOnly: true,
    });
  }
  if (deviceCookie) {
    await session.defaultSession.cookies.set({
      url: base,
      name: 'wd_device',
      value: deviceCookie.replace(/^wd_device=/, ''),
      path: '/',
      secure: u.protocol === 'https:',
      httpOnly: true,
    });
  }
  return { ok: true, cookie: cookieHeader(), data };
});

ipcMain.handle('companion:session-cookie', () => sessionCookie);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
