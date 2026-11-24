'use strict';

const crypto = require('crypto');

const ROOM_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const NAME_RE = /^.{1,80}$/;
const KEY_MAX = 128;
const KEY_MIN_CREATE = 8;
const KEY_MIN_LOGIN = 4;
const JSON_MAX_BYTES = 64 * 1024;
const WS_MAX_PAYLOAD = 256 * 1024;

const shaHex = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashEqHex(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

function normalizeName(name) {
  const n = String(name || '').trim();
  if (!NAME_RE.test(n)) return null;
  return n;
}

function validateKey(key, min = KEY_MIN_CREATE) {
  return typeof key === 'string' && key.length >= min && key.length <= KEY_MAX;
}

function isDeviceId(id) {
  return typeof id === 'string' && /^[a-f0-9]{64}$/.test(id);
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  const fromHeader = xf.split(',')[0].trim();
  return (fromHeader || req.socket.remoteAddress || '').slice(0, 64);
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
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
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

function createRateLimiter({ windowMs = 60_000, max = 8 } = {}) {
  const failures = new Map();
  function blocked(ip) {
    const now = Date.now();
    const list = (failures.get(ip) || []).filter((t) => now - t < windowMs);
    failures.set(ip, list);
    return list.length >= max;
  }
  function noteFailure(ip) {
    (failures.get(ip) || failures.set(ip, []).get(ip)).push(Date.now());
  }
  return { blocked, noteFailure };
}

function iceServers({ turnSecret, turnHost, publicHost, turnPort }, userId = 'anon', ttlSec = 3600) {
  /** @type {Array<{ urls: string | string[], username?: string, credential?: string }>} */
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  const host = turnHost || publicHost;
  if (turnSecret && host) {
    const expiry = Math.floor(Date.now() / 1000) + ttlSec;
    const username = `${expiry}:${userId}`;
    const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
    const base = `${host}:${turnPort}`;
    servers.push({
      urls: [`turn:${base}?transport=udp`, `turn:${base}?transport=tcp`],
      username,
      credential,
    });
  }
  return servers;
}

function publicOriginHostname(publicOrigin = '') {
  const raw = String(publicOrigin || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}

/**
 * Alias/túnel reescreve Host para FRONTIER_ALIAS; Origin fica no DNS do site.
 * Aceita Host, PUBLIC_HOST (IP TURN) e hostname de PUBLIC_ORIGIN.
 */
function originAllowed(req, publicHost = '', publicOrigin = '') {
  const origin = String(req.headers.origin || '');
  if (!origin) return true;
  let hostname;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  const host = String(req.headers.host || '').split(':')[0];
  if (hostname === host) return true;
  if (publicHost && hostname === publicHost) return true;
  const siteHost = publicOriginHostname(publicOrigin);
  if (siteHost && hostname === siteHost) return true;
  return false;
}

function readJson(req, maxBytes = JSON_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
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

module.exports = {
  ROOM_RE,
  NAME_RE,
  KEY_MIN_CREATE,
  KEY_MIN_LOGIN,
  JSON_MAX_BYTES,
  WS_MAX_PAYLOAD,
  shaHex,
  hashEqHex,
  normalizeName,
  validateKey,
  isDeviceId,
  clientIp,
  parseCookies,
  isSecureReq,
  cookieHeader,
  createRateLimiter,
  iceServers,
  publicOriginHostname,
  originAllowed,
  readJson,
};
