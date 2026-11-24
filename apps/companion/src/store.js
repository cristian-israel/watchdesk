'use strict';

/**
 * Persistência local do companion (origem, nome, device cookie, última sala).
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  origin: '',
  displayName: 'Companion',
  deviceCookie: '',
  lastRoomSlug: '',
  lastHostKey: '',
  autoTransmit: false,
};

function storePath() {
  return path.join(app.getPath('userData'), 'companion-settings.json');
}

function load() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const data = JSON.parse(raw);
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(partial) {
  const next = { ...load(), ...partial };
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { load, save, DEFAULTS };
