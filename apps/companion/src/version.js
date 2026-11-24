'use strict';

const { version: LOCAL_VERSION } = require('../package.json');

function cmpSemver(a, b) {
  const pa = String(a || '')
    .split('.')
    .map((n) => Number(n) || 0);
  const pb = String(b || '')
    .split('.')
    .map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function fetchLatest(origin) {
  const base = String(origin || '').replace(/\/$/, '');
  const urls = [`${base}/api/companion/version`, `${base}/companion/latest.json`];
  for (const url of urls) {
    try {
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) continue;
      return await r.json();
    } catch {
      /* try next */
    }
  }
  return null;
}

module.exports = { LOCAL_VERSION, cmpSemver, fetchLatest };
