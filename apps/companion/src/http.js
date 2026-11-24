'use strict';

/**
 * Cliente HTTP do companion com jar de cookies wd_device / wd_session.
 */

let deviceCookie = '';
let sessionCookie = '';

function setCookiesFromStore(device) {
  deviceCookie = device || '';
}

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

function deviceCookieValue() {
  return deviceCookie;
}

function sessionCookieValue() {
  return sessionCookie;
}

function clearSession() {
  sessionCookie = '';
}

async function api(origin, path, { method = 'GET', body, headers = {} } = {}) {
  const base = String(origin || '').replace(/\/$/, '');
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookieHeader() ? { Cookie: cookieHeader() } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  absorbCookies(r);
  const text = await r.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!r.ok) {
    const message =
      typeof data === 'string'
        ? data
        : data && typeof data === 'object' && data.message
          ? String(data.message)
          : text || `HTTP ${r.status}`;
    const err = new Error(message);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data;
}

function viewerInviteUrl(origin, slug, viewerInvite) {
  const base = String(origin || '').replace(/\/$/, '');
  const path = `/sala/${encodeURIComponent(slug)}`;
  if (!viewerInvite) return `${base}${path}`;
  return `${base}${path}#k=${encodeURIComponent(viewerInvite)}`;
}

module.exports = {
  api,
  absorbCookies,
  cookieHeader,
  setCookiesFromStore,
  deviceCookieValue,
  sessionCookieValue,
  clearSession,
  viewerInviteUrl,
};
