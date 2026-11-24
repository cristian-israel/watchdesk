'use strict';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
function log(line) {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

let cookie = '';
let ws = null;
/** @type {Map<string, RTCPeerConnection>} */
const peers = new Map();
let localStream = null;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
let selfPeerId = '';
let pilotPeerId = null;
let slot = 0;

function peerKey(id) {
  return `${id}:${slot}`;
}

async function ensurePeer(peerId, stream) {
  const key = peerKey(peerId);
  if (peers.has(key)) return;
  const pc = new RTCPeerConnection({ iceServers });
  peers.set(key, pc);
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));
  const dc = pc.createDataChannel('watchdesk-input', { ordered: true });
  dc.onmessage = (ev) => {
    if (pilotPeerId && peerId === pilotPeerId) {
      window.watchdesk.sendInput(String(ev.data));
    }
  };
  pc.onicecandidate = (ev) => {
    wsSend({
      type: 'ice',
      to: peerId,
      slot,
      candidate: ev.candidate ? ev.candidate.toJSON() : null,
    });
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type: 'offer', to: peerId, slot, sdp: offer.sdp || '' });
}

function closePeers() {
  for (const pc of peers.values()) pc.close();
  peers.clear();
}

function wsSend(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connectWs(origin) {
  const u = new URL(origin);
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  // Cookie da sessão já está no session Electron (host-login).
  ws = new WebSocket(`${proto}//${u.host}/api/ws`);
  ws.onopen = () => {
    const meta = window.__companionMeta;
    wsSend({
      type: 'hello',
      clientKind: 'companion',
      version: meta?.version || '0.1.0',
    });
  };
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === 'welcome') {
      selfPeerId = msg.peerId;
      iceServers = msg.iceServers?.length ? msg.iceServers : iceServers;
      pilotPeerId = msg.pilotPeerId || null;
      $('pilot').textContent = pilotPeerId || 'ninguém';
      $('revoke').disabled = !pilotPeerId;
      log(`WS ok · peer ${selfPeerId} · transmit=${msg.transmitMode}`);
      wsSend({ type: 'slot_add', slot });
      for (const v of msg.viewers || []) {
        await ensurePeer(v.peerId, localStream);
      }
      return;
    }
    if (msg.type === 'viewer_joined' && localStream) {
      await ensurePeer(msg.peerId, localStream);
      return;
    }
    if (msg.type === 'viewer_left') {
      const key = peerKey(msg.peerId);
      peers.get(key)?.close();
      peers.delete(key);
      return;
    }
    if (msg.type === 'control_changed') {
      if (msg.mode === 'interact') pilotPeerId = msg.peerId;
      else if (msg.peerId === pilotPeerId) pilotPeerId = null;
      $('pilot').textContent = pilotPeerId ? msg.displayName : 'ninguém';
      $('revoke').disabled = !pilotPeerId;
      log(`controle: ${msg.displayName} → ${msg.mode}`);
      return;
    }
    if (msg.type === 'answer') {
      const pc = peers.get(peerKey(msg.from));
      if (pc && !pc.currentRemoteDescription) {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      }
      return;
    }
    if (msg.type === 'ice') {
      const pc = peers.get(peerKey(msg.from));
      if (pc && msg.candidate) {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch {
          /* race */
        }
      }
      return;
    }
    if (msg.type === 'error') {
      $('status').textContent = msg.message;
      $('status').className = 'err';
      log(`erro: ${msg.message}`);
    }
  };
  ws.onclose = () => log('WS fechado');
}

async function startCapture(sourceId) {
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      // @ts-expect-error electron constraint
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxFrameRate: 30,
      },
    },
  });
}

async function boot() {
  const meta = await window.watchdesk.meta();
  window.__companionMeta = meta;
  $('ver').textContent = `v${meta.version}`;
  if (meta.outdated && meta.update) {
    const box = $('update');
    box.hidden = false;
    box.innerHTML = `Nova versão ${meta.update.version} disponível. ${meta.mandatory ? '<b>Atualização obrigatória.</b> ' : ''}<button type="button" id="btnUpd">Atualizar</button>`;
    $('btnUpd')?.addEventListener('click', () => void window.watchdesk.openDownload());
  }
  const env = await window.watchdesk.env();
  if (env.origin) $('origin').value = env.origin;
  if (env.room) $('room').value = env.room;

  async function refreshSources() {
    const sources = await window.watchdesk.listSources();
    $('source').innerHTML = sources.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  }
  $('refreshSources').onclick = () => void refreshSources();
  await refreshSources();

  $('connect').onclick = async () => {
    try {
      $('status').textContent = 'Conectando…';
      $('status').className = '';
      const origin = $('origin').value.trim();
      const room = $('room').value.trim();
      const hostKey = $('hostKey').value;
      if (!origin || !room) throw new Error('Informe origem e sala.');
      if (meta.mandatory) throw new Error('Atualize o companion antes de transmitir.');

      await window.watchdesk.hostLogin({ origin, room, hostKey });
      cookie = (await window.watchdesk.sessionCookie()) || '';
      await startCapture($('source').value);
      connectWs(origin);
      $('connect').disabled = true;
      $('stop').disabled = false;
      $('status').textContent = 'Transmitindo';
      $('status').className = 'ok';
    } catch (e) {
      $('status').textContent = e instanceof Error ? e.message : String(e);
      $('status').className = 'err';
      log(String(e));
    }
  };

  $('stop').onclick = () => {
    ws?.close();
    closePeers();
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    $('connect').disabled = false;
    $('stop').disabled = true;
    $('revoke').disabled = true;
    $('status').textContent = 'Parado';
  };

  $('revoke').onclick = () => {
    if (!pilotPeerId) return;
    wsSend({ type: 'set_control', peerId: pilotPeerId, mode: 'view' });
  };
}

void boot();
