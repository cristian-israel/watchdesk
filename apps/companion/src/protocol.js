'use strict';

/**
 * @typedef {{ type: 'move', x: number, y: number }
 *   | { type: 'down', x: number, y: number, button: number }
 *   | { type: 'up', x: number, y: number, button: number }
 *   | { type: 'wheel', x: number, y: number, dx: number, dy: number }
 *   | { type: 'keydown', key: string, code: string }
 *   | { type: 'keyup', key: string, code: string }} RemoteInputEvent
 */

function parseInput(raw) {
  try {
    const msg = JSON.parse(String(raw));
    if (!msg || typeof msg.type !== 'string') return null;
    return msg;
  } catch {
    return null;
  }
}

module.exports = { parseInput };
