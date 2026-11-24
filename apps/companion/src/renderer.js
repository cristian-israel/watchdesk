'use strict';

const $ = (id) => document.getElementById(id);
const logEl = $('log');

function log(line) {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, cls = 'ok') {
  $('status').textContent = text;
  $('status').className = cls;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** @type {any} */
let me = null;
/** @type {any} */
let roomInfo = null;
let transmitting = false;

let ws = null;
/** @type {Map<string, RTCPeerConnection>} */
const peers = new Map();
/** @type {Map<string, { displayName: string, controlMode: string }>} */
const viewers = new Map();
let localStream = null;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
let selfPeerId = '';
let pilotPeerId = null;
let slot = 0;
let autoTransmitAfterSync = false;

function peerKey(id) {
  return `${id}:${slot}`;
}

function originVal() {
  return $('origin').value.trim().replace(/\/$/, '');
}

function show(el, on) {
  el.classList.toggle('hidden', !on);
}

function renderRoomUi() {
  const owned = me?.room || null;
  roomInfo = owned
    ? {
        slug: owned.slug,
        active: owned.active,
        maxViewers: owned.maxViewers,
        viewerInvite: owned.viewerInvite || '',
        hostInvite: owned.hostInvite || '',
      }
    : roomInfo;

  show($('roomCard'), Boolean(me));
  show($('txCard'), Boolean(me && roomInfo?.slug));
  show($('controlCard'), transmitting || Boolean(viewers.size));

  if (!me) return;

  if (!roomInfo?.slug) {
    $('roomSummary').textContent = 'Nenhuma sala neste aparelho.';
    show($('roomActionsCreate'), true);
    show($('roomActionsOwned'), false);
    return;
  }

  $('roomSummary').textContent = `Sala ${roomInfo.slug} · ${roomInfo.active ? 'ativa' : 'desativada'} · máx. ${roomInfo.maxViewers}`;
  $('room').value = roomInfo.slug;
  if (roomInfo.hostInvite) $('hostKey').value = roomInfo.hostInvite;
  $('maxViewers').value = String(roomInfo.maxViewers || 8);
  $('btnToggleActive').textContent = roomInfo.active ? 'Desativar sala' : 'Ativar sala';
  show($('roomActionsCreate'), false);
  show($('roomActionsOwned'), true);
}

function renderViewers() {
  const ul = $('viewers');
  show($('controlCard'), transmitting || Boolean(viewers.size));
  if (!viewers.size) {
    ul.innerHTML = '<li class="muted" style="border:none;padding:0">Nenhum espectador.</li>';
    return;
  }
  ul.innerHTML = [...viewers.entries()]
    .map(([id, v]) => {
      const interacting = v.controlMode === 'interact' || id === pilotPeerId;
      return `<li>
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(v.displayName || id)}${interacting ? ' · piloto' : ''}</span>
        <button type="button" data-peer="${id}" data-mode="${interacting ? 'view' : 'interact'}" class="secondary">
          ${interacting ? 'Revogar' : 'Promover'}
        </button>
      </li>`;
    })
    .join('');
  ul.querySelectorAll('button[data-peer]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const peerId = btn.getAttribute('data-peer');
      const mode = btn.getAttribute('data-mode');
      if (peerId && mode) wsSend({ type: 'set_control', peerId, mode });
    });
  });
}

function setPilot(peerId, displayName) {
  pilotPeerId = peerId;
  $('pilot').textContent = peerId ? displayName || peerId : 'ninguém';
  $('revoke').disabled = !peerId;
  renderViewers();
}

async function ensurePeer(peerId, stream) {
  const key = peerKey(peerId);
  if (peers.has(key) || !stream) return;
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
      viewers.clear();
      for (const v of msg.viewers || []) {
        viewers.set(v.peerId, {
          displayName: v.displayName || v.peerId,
          controlMode: v.controlMode || 'view',
        });
      }
      const pilotName = msg.pilotPeerId
        ? viewers.get(msg.pilotPeerId)?.displayName || msg.pilotPeerId
        : null;
      setPilot(msg.pilotPeerId || null, pilotName);
      log(`WS ok · peer ${selfPeerId} · transmit=${msg.transmitMode}`);
      wsSend({ type: 'slot_add', slot });
      for (const v of msg.viewers || []) {
        await ensurePeer(v.peerId, localStream);
      }
      return;
    }
    if (msg.type === 'viewer_joined' && localStream) {
      viewers.set(msg.peerId, {
        displayName: msg.displayName || msg.peerId,
        controlMode: msg.controlMode || 'view',
      });
      renderViewers();
      await ensurePeer(msg.peerId, localStream);
      return;
    }
    if (msg.type === 'viewer_left') {
      viewers.delete(msg.peerId);
      if (pilotPeerId === msg.peerId) setPilot(null, null);
      else renderViewers();
      const key = peerKey(msg.peerId);
      peers.get(key)?.close();
      peers.delete(key);
      return;
    }
    if (msg.type === 'roster') {
      const next = new Map();
      for (const m of msg.members || []) {
        if (m.role !== 'viewer') continue;
        next.set(m.peerId, {
          displayName: m.displayName || m.peerId,
          controlMode: m.controlMode || 'view',
        });
      }
      viewers.clear();
      for (const [id, v] of next) viewers.set(id, v);
      renderViewers();
      return;
    }
    if (msg.type === 'control_changed') {
      const row = viewers.get(msg.peerId);
      if (row) row.controlMode = msg.mode;
      for (const [id, v] of viewers) {
        if (id !== msg.peerId && msg.mode === 'interact') v.controlMode = 'view';
      }
      if (msg.mode === 'interact') setPilot(msg.peerId, msg.displayName);
      else if (msg.peerId === pilotPeerId) setPilot(null, null);
      else renderViewers();
      log(`controle: ${msg.displayName} → ${msg.mode}`);
      return;
    }
    if (msg.type === 'room_updated' && roomInfo) {
      roomInfo.active = msg.active;
      roomInfo.maxViewers = msg.maxViewers;
      if (me?.room) {
        me.room.active = msg.active;
        me.room.maxViewers = msg.maxViewers;
      }
      renderRoomUi();
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
      setStatus(msg.message, 'err');
      log(`erro: ${msg.message}`);
    }
  };
  ws.onclose = () => {
    log('WS fechado');
    if (transmitting) setStatus('Conexão encerrada', 'err');
  };
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

async function refreshSources() {
  const sources = await window.watchdesk.listSources();
  $('source').innerHTML = sources.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
}

async function syncAccount() {
  const origin = originVal();
  const displayName = $('displayName').value.trim() || 'Companion';
  if (!origin) throw new Error('Informe a origem HTTPS.');
  setStatus('Sincronizando…', '');
  me = await window.watchdesk.fetchMe({ origin, displayName });
  roomInfo = me.room
    ? {
        slug: me.room.slug,
        active: me.room.active,
        maxViewers: me.room.maxViewers,
        viewerInvite: me.room.viewerInvite || '',
        hostInvite: me.room.hostInvite || '',
      }
    : null;
  await window.watchdesk.settingsSave({
    origin,
    displayName: me.displayName || displayName,
    lastRoomSlug: roomInfo?.slug || '',
    lastHostKey: roomInfo?.hostInvite || '',
  });
  renderRoomUi();
  setStatus(`Conectado como ${me.displayName || displayName}`, 'ok');
  log(`device ${me.deviceId}${roomInfo ? ` · sala ${roomInfo.slug}` : ''}`);
  if (autoTransmitAfterSync && roomInfo?.slug) {
    autoTransmitAfterSync = false;
    await startTransmit();
  }
}

async function createRoom() {
  const origin = originVal();
  const displayName = $('displayName').value.trim() || 'Companion';
  const maxViewers = Number($('maxViewers')?.value || 8);
  setStatus('Criando sala…', '');
  const data = await window.watchdesk.createRoom({ origin, displayName, maxViewers });
  roomInfo = {
    slug: data.room,
    active: data.active,
    maxViewers: data.maxViewers,
    viewerInvite: data.viewerInvite || '',
    hostInvite: data.hostInvite || '',
  };
  me = {
    ...(me || {}),
    displayName: data.displayName || displayName,
    room: {
      slug: roomInfo.slug,
      active: roomInfo.active,
      maxViewers: roomInfo.maxViewers,
      viewerInvite: roomInfo.viewerInvite,
      hostInvite: roomInfo.hostInvite,
      links: data.links || [],
    },
  };
  renderRoomUi();
  setStatus(`Sala ${roomInfo.slug} criada`, 'ok');
  log(`sala criada ${roomInfo.slug}`);
}

async function patchOwned(patch) {
  if (!roomInfo?.slug) throw new Error('Sem sala.');
  const data = await window.watchdesk.patchRoom({
    origin: originVal(),
    room: roomInfo.slug,
    patch,
  });
  roomInfo = {
    ...roomInfo,
    active: data.active ?? roomInfo.active,
    maxViewers: data.maxViewers ?? roomInfo.maxViewers,
    viewerInvite: data.viewerInvite || roomInfo.viewerInvite,
    hostInvite: data.hostInvite || roomInfo.hostInvite,
  };
  if (me?.room) me.room = { ...me.room, ...roomInfo };
  renderRoomUi();
  setStatus(data.message || 'Sala atualizada', 'ok');
  return data;
}

async function copyInvite() {
  if (!roomInfo?.slug) return;
  const url = await window.watchdesk.viewerLink({
    origin: originVal(),
    slug: roomInfo.slug,
    viewerInvite: roomInfo.viewerInvite,
  });
  await window.watchdesk.clipboard(url);
  setStatus('Link do espectador copiado', 'ok');
}

async function startTransmit() {
  const meta = window.__companionMeta;
  if (meta?.mandatory) throw new Error('Atualize o companion antes de transmitir.');
  if (!roomInfo?.slug) throw new Error('Crie ou sincronize uma sala primeiro.');
  const origin = originVal();
  const displayName = $('displayName').value.trim() || 'Companion';
  const hostKey = $('hostKey').value || roomInfo.hostInvite || '';

  setStatus('Conectando…', '');
  await window.watchdesk.hostLogin({
    origin,
    room: roomInfo.slug,
    hostKey,
    displayName,
  });
  await startCapture($('source').value);
  connectWs(origin);
  transmitting = true;
  $('connect').disabled = true;
  $('stop').disabled = false;
  show($('controlCard'), true);
  setStatus('Transmitindo', 'ok');
}

function stopTransmit() {
  ws?.close();
  ws = null;
  closePeers();
  viewers.clear();
  renderViewers();
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  transmitting = false;
  $('connect').disabled = false;
  $('stop').disabled = true;
  $('revoke').disabled = true;
  setPilot(null, null);
  setStatus('Parado', 'ok');
}

async function applyDeepLink(data) {
  if (!data) return;
  if (data.origin) $('origin').value = String(data.origin).replace(/\/$/, '');
  if (data.hostKey) $('hostKey').value = data.hostKey;
  if (data.room) {
    roomInfo = roomInfo || {};
    roomInfo.slug = data.room;
    $('room').value = data.room;
  }
  log(`deep link: ${data.origin || ''} ${data.room || ''}`);
  autoTransmitAfterSync = Boolean(data.transmit);
  try {
    await syncAccount();
    if (data.room && !me?.room) {
      // Sala de outro device: entrar com chave se veio no link
      roomInfo = {
        slug: data.room,
        active: true,
        maxViewers: 8,
        viewerInvite: '',
        hostInvite: data.hostKey || '',
      };
      renderRoomUi();
      if (data.transmit) await startTransmit();
    }
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e), 'err');
  }
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

  const settings = await window.watchdesk.settingsGet();
  if (settings.origin) $('origin').value = settings.origin;
  if (settings.displayName) $('displayName').value = settings.displayName;
  if (settings.room) $('room').value = settings.room;
  if (settings.hostKey) $('hostKey').value = settings.hostKey;

  $('refreshSources').onclick = () => void refreshSources();
  await refreshSources();

  $('btnSync').onclick = () =>
    void syncAccount().catch((e) => setStatus(e instanceof Error ? e.message : String(e), 'err'));
  $('btnCreate').onclick = () =>
    void createRoom().catch((e) => setStatus(e instanceof Error ? e.message : String(e), 'err'));
  $('btnCopyInvite').onclick = () =>
    void copyInvite().catch((e) => setStatus(e instanceof Error ? e.message : String(e), 'err'));
  $('btnOpenInvite').onclick = () =>
    void (async () => {
      const url = await window.watchdesk.viewerLink({
        origin: originVal(),
        slug: roomInfo.slug,
        viewerInvite: roomInfo.viewerInvite,
      });
      await window.watchdesk.openExternal(url);
    })().catch((e) => setStatus(e instanceof Error ? e.message : String(e), 'err'));
  $('btnSaveMax').onclick = () =>
    void patchOwned({ maxViewers: Number($('maxViewers').value) }).catch((e) =>
      setStatus(e instanceof Error ? e.message : String(e), 'err'),
    );
  $('btnRegenViewer').onclick = () =>
    void patchOwned({ regenerateViewerKey: true }).catch((e) =>
      setStatus(e instanceof Error ? e.message : String(e), 'err'),
    );
  $('btnToggleActive').onclick = () =>
    void patchOwned({ active: !roomInfo.active }).catch((e) =>
      setStatus(e instanceof Error ? e.message : String(e), 'err'),
    );
  $('btnDeleteRoom').onclick = () =>
    void (async () => {
      if (!confirm('Excluir a sala deste aparelho?')) return;
      stopTransmit();
      await window.watchdesk.deleteRoom({ origin: originVal() });
      me = { ...me, room: null };
      roomInfo = null;
      renderRoomUi();
      setStatus('Sala excluída', 'ok');
    })().catch((e) => setStatus(e instanceof Error ? e.message : String(e), 'err'));
  $('btnCopyHostKey').onclick = () =>
    void window.watchdesk
      .clipboard($('hostKey').value || roomInfo?.hostInvite || '')
      .then(() => setStatus('Chave do host copiada', 'ok'));

  $('connect').onclick = () =>
    void startTransmit().catch((e) => {
      setStatus(e instanceof Error ? e.message : String(e), 'err');
      log(String(e));
    });
  $('stop').onclick = () => stopTransmit();
  $('revoke').onclick = () => {
    if (!pilotPeerId) return;
    wsSend({ type: 'set_control', peerId: pilotPeerId, mode: 'view' });
  };

  window.watchdesk.onDeepLink((data) => void applyDeepLink(data));

  renderViewers();
  renderRoomUi();

  // Auto-sync se já tem origem salva
  if (settings.origin) {
    void syncAccount().catch(() => {
      /* offline / primeira vez */
    });
  }
}

void boot();
