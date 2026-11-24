'use strict';

/** Versão do companion publicada na LAN (override via env). */
function companionLatest() {
  return {
    version: process.env.COMPANION_VERSION || '0.2.0',
    minVersion: process.env.COMPANION_MIN_VERSION || '0.1.0',
    downloadUrl: process.env.COMPANION_DOWNLOAD_URL || '/companion/watchdesk-companion-setup.exe',
    downloadUrlLinux:
      process.env.COMPANION_DOWNLOAD_URL_LINUX || '/companion/watchdesk-companion.AppImage',
    notes: process.env.COMPANION_NOTES || '',
    mandatory: String(process.env.COMPANION_MANDATORY || '').toLowerCase() === 'true',
  };
}

function parseSemver(v) {
  const m = String(v || '')
    .trim()
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

module.exports = { companionLatest, cmpSemver, parseSemver };
