'use strict';

/**
 * Injeção de input — Windows (user32 via PowerShell) e Linux (xdotool).
 */

const { execFile } = require('child_process');
const os = require('os');

const platform = os.platform();

function screenSize() {
  return global.__watchdeskScreen || { w: 1920, h: 1080 };
}

function setScreenSize(w, h) {
  global.__watchdeskScreen = { w, h };
}

function toPixels(x, y) {
  const { w, h } = screenSize();
  return {
    x: Math.round(Math.min(1, Math.max(0, Number(x) || 0)) * (w - 1)),
    y: Math.round(Math.min(1, Math.max(0, Number(y) || 0)) * (h - 1)),
  };
}

let xdotoolWarned = false;

function xdotoolBin() {
  return process.env.WATCHDESK_XDOTOOL || 'xdotool';
}

function run(bin, args) {
  execFile(bin, args, { timeout: 2000, windowsHide: true }, (err) => {
    if (!err) return;
    if (bin.includes('xdotool') || bin === 'xdotool') {
      if (!xdotoolWarned) {
        xdotoolWarned = true;
        console.warn(
          '[input] xdotool falhou — instale e deixe no PATH (ou WATCHDESK_XDOTOOL).',
          err.message,
        );
      }
      return;
    }
    console.warn('[input]', bin, err.message);
  });
}

function ps(cmd) {
  run('powershell.exe', ['-NoProfile', '-Command', cmd]);
}

/** Mapear KeyboardEvent.code → keysym xdotool / virtual-key PowerShell aproximado */
const CODE_TO_XDOTOOL = {
  Enter: 'Return',
  Escape: 'Escape',
  Backspace: 'BackSpace',
  Tab: 'Tab',
  Space: 'space',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page_Up',
  PageDown: 'Page_Down',
};

function xdotoolKey(code, key) {
  if (CODE_TO_XDOTOOL[code]) return CODE_TO_XDOTOOL[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (key && key.length === 1) return key;
  return null;
}

function applyWin(ev) {
  if (ev.type === 'move' || ev.type === 'down' || ev.type === 'up') {
    const { x, y } = toPixels(ev.x, ev.y);
    if (ev.type === 'move') {
      ps(
        `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`,
      );
      return;
    }
    const down = ev.type === 'down';
    const flag = ev.button === 2 ? (down ? 0x0008 : 0x0010) : down ? 0x0002 : 0x0004;
    ps(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); ` +
        `$sig='[DllImport(\\"user32.dll\\")]public static extern void mouse_event(int f,int x,int y,int d,int e);'; ` +
        `Add-Type -MemberDefinition $sig -Name U -Namespace W; [W.U]::mouse_event(${flag},0,0,0,0)`,
    );
    return;
  }
  if (ev.type === 'wheel') {
    const { x, y } = toPixels(ev.x, ev.y);
    const delta = Math.round(-(ev.dy || 0));
    ps(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); ` +
        `$sig='[DllImport(\\"user32.dll\\")]public static extern void mouse_event(int f,int x,int y,int d,int e);'; ` +
        `Add-Type -MemberDefinition $sig -Name U -Namespace W; [W.U]::mouse_event(0x0800,0,0,${delta},0)`,
    );
    return;
  }
  if (ev.type === 'keydown' || ev.type === 'keyup') {
    const k = String(ev.key || '');
    if (!k || k.length > 1) {
      // teclas especiais: SendKeys limitado
      const map = { Enter: '{ENTER}', Escape: '{ESC}', Tab: '{TAB}', Backspace: '{BACKSPACE}' };
      const send = map[ev.code] || map[k];
      if (send && ev.type === 'keydown') {
        ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${send}')`);
      }
      return;
    }
    if (ev.type === 'keydown') {
      const escaped = k.replace(/[+^%~(){}]/g, '{$&}');
      ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`);
    }
  }
}

function applyLinux(ev) {
  const xd = xdotoolBin();
  if (ev.type === 'move' || ev.type === 'down' || ev.type === 'up') {
    const { x, y } = toPixels(ev.x, ev.y);
    if (ev.type === 'move') {
      run(xd, ['mousemove', '--sync', String(x), String(y)]);
      return;
    }
    run(xd, ['mousemove', '--sync', String(x), String(y)]);
    const btn = ev.button === 2 ? '3' : ev.button === 1 ? '2' : '1';
    run(xd, [ev.type === 'down' ? 'mousedown' : 'mouseup', btn]);
    return;
  }
  if (ev.type === 'wheel') {
    const { x, y } = toPixels(ev.x, ev.y);
    run(xd, ['mousemove', '--sync', String(x), String(y)]);
    const btn = (ev.dy || 0) > 0 ? '5' : '4';
    run(xd, ['click', btn]);
    return;
  }
  if (ev.type === 'keydown' || ev.type === 'keyup') {
    const name = xdotoolKey(ev.code, ev.key);
    if (!name) return;
    run(xd, [ev.type === 'keydown' ? 'keydown' : 'keyup', name]);
  }
}

/** @param {import('./protocol').RemoteInputEvent} ev */
function applyInput(ev) {
  if (!ev || !ev.type) return;
  if (platform === 'win32') applyWin(ev);
  else if (platform === 'linux') applyLinux(ev);
  else console.log('[input:unsupported]', platform, ev.type);
}

module.exports = { applyInput, setScreenSize, platform };
