'use strict';

/**
 * Watchdesk Companion — console do host (salas, convite, transmitir, controle).
 *
 * Env (opcional): WATCHDESK_ORIGIN, WATCHDESK_ROOM, WATCHDESK_HOST_KEY,
 * WATCHDESK_ELECTRON_NO_SANDBOX, WATCHDESK_XDOTOOL
 *
 * Deep link: watchdesk://connect?origin=https://…&room=slug&transmit=1
 */

const {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  shell,
  screen,
  session,
  clipboard,
} = require('electron');
const path = require('path');
const { LOCAL_VERSION, cmpSemver, fetchLatest } = require('./version');
const { applyInput, setScreenSize, platform } = require('./input');
const { parseInput } = require('./protocol');
const store = require('./store');
const http = require('./http');

if (process.env.WATCHDESK_ELECTRON_NO_SANDBOX === '1' || platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}

const PROTOCOL = 'watchdesk';

/** @type {BrowserWindow | null} */
let win = null;
let updateInfo = null;
/** @type {object | null} */
let pendingDeepLink = null;

function parseDeepLink(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== `${PROTOCOL}:`) return null;
    const origin = u.searchParams.get('origin') || '';
    const room = u.searchParams.get('room') || '';
    const hostKey = u.searchParams.get('hostKey') || u.searchParams.get('key') || '';
    const transmit = ['1', 'true', 'yes'].includes(
      String(u.searchParams.get('transmit') || '').toLowerCase(),
    );
    return { origin, room, hostKey, transmit };
  } catch {
    return null;
  }
}

function sendToRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 440,
    height: 720,
    minWidth: 380,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'ui.html'));
  win.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) {
      sendToRenderer('companion:deep-link', pendingDeepLink);
      pendingDeepLink = null;
    }
  });
}

async function syncElectronCookies(origin) {
  const base = String(origin || '').replace(/\/$/, '');
  if (!base) return;
  const u = new URL(base);
  const sess = http.sessionCookieValue();
  const device = http.deviceCookieValue();
  if (sess) {
    await session.defaultSession.cookies.set({
      url: base,
      name: 'wd_session',
      value: sess.replace(/^wd_session=/, ''),
      path: '/',
      secure: u.protocol === 'https:',
      httpOnly: true,
    });
  }
  if (device) {
    await session.defaultSession.cookies.set({
      url: base,
      name: 'wd_device',
      value: device.replace(/^wd_device=/, ''),
      path: '/',
      secure: u.protocol === 'https:',
      httpOnly: true,
    });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = argv.find((a) => String(a).startsWith(`${PROTOCOL}:`));
    const parsed = link ? parseDeepLink(link) : null;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (parsed) sendToRenderer('companion:deep-link', parsed);
    } else if (parsed) {
      pendingDeepLink = parsed;
    }
  });
}

app.whenReady().then(async () => {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  const primary = screen.getPrimaryDisplay().size;
  setScreenSize(primary.width, primary.height);

  const settings = store.load();
  if (settings.deviceCookie) {
    http.setCookiesFromStore(
      settings.deviceCookie.startsWith('wd_device=')
        ? settings.deviceCookie
        : `wd_device=${settings.deviceCookie}`,
    );
  }

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const jar = http.cookieHeader();
    if (jar && /\/api\/ws/.test(details.url)) {
      details.requestHeaders.Cookie = jar;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  const origin = process.env.WATCHDESK_ORIGIN || settings.origin || '';
  if (origin) {
    updateInfo = await fetchLatest(origin);
  }

  const bootLink = process.argv.find((a) => String(a).startsWith(`${PROTOCOL}:`));
  if (bootLink) pendingDeepLink = parseDeepLink(bootLink);

  createWindow();
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  const parsed = parseDeepLink(url);
  if (!parsed) return;
  if (win) sendToRenderer('companion:deep-link', parsed);
  else pendingDeepLink = parsed;
});

ipcMain.handle('companion:meta', () => ({
  version: LOCAL_VERSION,
  update: updateInfo,
  outdated:
    updateInfo && updateInfo.version ? cmpSemver(LOCAL_VERSION, updateInfo.version) < 0 : false,
  mandatory:
    updateInfo &&
    updateInfo.mandatory &&
    updateInfo.minVersion &&
    cmpSemver(LOCAL_VERSION, updateInfo.minVersion) < 0,
}));

ipcMain.handle('companion:open-download', async () => {
  const settings = store.load();
  const origin = (process.env.WATCHDESK_ORIGIN || settings.origin || '').replace(/\/$/, '');
  const p =
    platform === 'linux'
      ? updateInfo?.downloadUrlLinux || updateInfo?.downloadUrl
      : updateInfo?.downloadUrl || updateInfo?.downloadUrlLinux;
  if (!p) return false;
  const url = String(p).startsWith('http') ? p : `${origin}${p}`;
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

ipcMain.handle('companion:settings-get', () => {
  const s = store.load();
  return {
    ...s,
    origin: process.env.WATCHDESK_ORIGIN || s.origin,
    room: process.env.WATCHDESK_ROOM || s.lastRoomSlug,
    hostKey: process.env.WATCHDESK_HOST_KEY || s.lastHostKey,
  };
});

ipcMain.handle('companion:settings-save', (_e, partial) => {
  const next = store.save(partial || {});
  if (partial?.deviceCookie) {
    http.setCookiesFromStore(
      String(partial.deviceCookie).startsWith('wd_device=')
        ? partial.deviceCookie
        : `wd_device=${partial.deviceCookie}`,
    );
  }
  return next;
});

ipcMain.handle('companion:clipboard', (_e, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('companion:open-external', async (_e, url) => {
  await shell.openExternal(String(url || ''));
  return true;
});

async function ensureName(origin, displayName) {
  const name = String(displayName || 'Companion').slice(0, 80);
  await http.api(origin, '/api/me', {
    method: 'PATCH',
    body: { displayName: name },
  });
  persistDevice(origin);
  return name;
}

function persistDevice(origin) {
  const device = http.deviceCookieValue();
  if (!device) return;
  store.save({
    origin: String(origin || '').replace(/\/$/, ''),
    deviceCookie: device.replace(/^wd_device=/, ''),
  });
}

ipcMain.handle('companion:fetch-me', async (_e, { origin, displayName }) => {
  const base = String(origin || '').replace(/\/$/, '');
  if (!base) throw new Error('Informe a origem HTTPS.');
  await ensureName(base, displayName);
  const me = await http.api(base, '/api/me');
  persistDevice(base);
  store.save({ origin: base, displayName: me.displayName || displayName });
  await syncElectronCookies(base);
  if (me.room?.slug) {
    updateInfo = await fetchLatest(base);
  }
  return me;
});

ipcMain.handle('companion:create-room', async (_e, { origin, displayName, maxViewers }) => {
  const base = String(origin || '').replace(/\/$/, '');
  await ensureName(base, displayName);
  const data = await http.api(base, '/api/rooms', {
    method: 'POST',
    body: { maxViewers: maxViewers || 8 },
  });
  persistDevice(base);
  store.save({
    origin: base,
    displayName: data.displayName || displayName,
    lastRoomSlug: data.room || data.slug,
    lastHostKey: data.hostInvite || '',
  });
  await syncElectronCookies(base);
  return data;
});

ipcMain.handle('companion:delete-room', async (_e, { origin }) => {
  const base = String(origin || '').replace(/\/$/, '');
  const data = await http.api(base, '/api/me/room', { method: 'DELETE' });
  store.save({ lastRoomSlug: '', lastHostKey: '' });
  http.clearSession();
  return data;
});

ipcMain.handle('companion:host-login', async (_e, { origin, room, hostKey, displayName }) => {
  const base = String(origin || '').replace(/\/$/, '');
  await ensureName(base, displayName);
  const data = await http.api(base, `/api/rooms/${encodeURIComponent(room)}/host`, {
    method: 'POST',
    body: { hostKey: hostKey || '' },
  });
  persistDevice(base);
  store.save({
    origin: base,
    displayName: data.displayName || displayName,
    lastRoomSlug: data.room || room,
    lastHostKey: hostKey || data.hostInvite || store.load().lastHostKey || '',
  });
  await syncElectronCookies(base);
  return { ok: true, cookie: http.cookieHeader(), data };
});

ipcMain.handle('companion:patch-room', async (_e, { origin, room, patch }) => {
  const base = String(origin || '').replace(/\/$/, '');
  const data = await http.api(base, `/api/rooms/${encodeURIComponent(room)}`, {
    method: 'PATCH',
    body: patch || {},
  });
  if (data.hostInvite) store.save({ lastHostKey: data.hostInvite });
  return data;
});

ipcMain.handle('companion:session-cookie', () => http.sessionCookieValue());

ipcMain.handle('companion:viewer-link', (_e, { origin, slug, viewerInvite }) =>
  http.viewerInviteUrl(origin, slug, viewerInvite),
);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
