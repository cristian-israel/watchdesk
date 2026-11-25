import { FormEvent, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNavigate, useParams } from 'react-router'
import { useActionDialog } from '@/actions/action-dialog'
import { ChatSplit } from '@/components/chat-split'
import { RoomChat } from '@/components/room-chat'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, apiOrThrow, type JoinMode, type SessionInfo } from '@/lib/api'
import {
  appendMessage,
  appendSystem,
  joinedLine,
  leftLine,
  messagesToFeed,
  type ChatFeedItem,
} from '@/lib/chat-feed'
import { viewerInviteUrl } from '@/lib/room'
import { useProfile } from '@/shell/profile'
import { useSignal } from '@/lib/use-signal'
import { VoiceMesh } from '@/lib/voice-mesh'
import {
  peerKey,
  type PendingMember,
  type RosterMember,
  type SignalInbound,
  type SignalOutbound,
  type VoicePeerState,
} from '@/lib/signal'

const MAX_SLOTS = 8

type ShareEntry = {
  stream: MediaStream
  state: 'connecting' | 'live'
}

type PeerLink = {
  pc: RTCPeerConnection
  peerId: string
  slot: number
}

export function HostPage() {
  const { room = '' } = useParams()
  const navigate = useNavigate()
  const action = useActionDialog()
  const { displayName: profileName, deviceId, rooms: ownedRooms } = useProfile()
  const owned = ownedRooms.find((r) => r.slug === room)
  const [displayName, setDisplayName] = useState('')
  const [booting, setBooting] = useState(true)
  const [panel, setPanel] = useState(false)
  const [denied, setDenied] = useState('')
  const [shares, setShares] = useState<Map<number, ShareEntry>>(new Map())
  const [roster, setRoster] = useState<RosterMember[]>([])
  const [pending, setPending] = useState<PendingMember[]>([])
  const [chatFeed, setChatFeed] = useState<ChatFeedItem[]>([])
  const [active, setActive] = useState(true)
  const [maxViewers, setMaxViewers] = useState(8)
  const [joinMode, setJoinMode] = useState<JoinMode>('ask')
  const [newMax, setNewMax] = useState(8)
  const [voiceEnabled, setVoiceEnabled] = useState(false)
  const [voiceMuted, setVoiceMuted] = useState(true)
  const [voiceForceMuted, setVoiceForceMuted] = useState(false)
  const [voicePeers, setVoicePeers] = useState<VoicePeerState[]>([])
  const [speakingIds, setSpeakingIds] = useState<string[]>([])
  const [selfPeerId, setSelfPeerId] = useState('')

  const panelRef = useRef(false)
  const sharesRef = useRef(shares)
  sharesRef.current = shares
  panelRef.current = panel
  const rosterRef = useRef(roster)
  rosterRef.current = roster

  const iceRef = useRef<RTCIceServer[]>([{ urls: 'stun:stun.l.google.com:19302' }])
  const viewersRef = useRef(new Map<string, string>())
  const peersRef = useRef(new Map<string, PeerLink>())
  const sendRef = useRef<(msg: SignalOutbound) => void>(() => undefined)
  const voiceRef = useRef<VoiceMesh | null>(null)
  if (!voiceRef.current) {
    voiceRef.current = new VoiceMesh({
      send: (msg) => sendRef.current(msg),
      iceServers: () => iceRef.current,
      onLocalMuteChange: (muted, forceMuted) => {
        setVoiceMuted(muted)
        setVoiceForceMuted(forceMuted)
      },
      onPeersChange: (peers) => setVoicePeers(peers),
      onSpeakingChange: (ids) => setSpeakingIds(ids),
    })
  }

  const { send } = useSignal(
    panel,
    (msg) => {
      void onSignal(msg)
    },
    () => toast.error('Conexão perdida. Tentando de novo…'),
  )
  sendRef.current = (msg) => send(msg)

  useEffect(() => {
    void boot()
    return () => {
      ;[...sharesRef.current.keys()].forEach((slot) => stopSlot(slot, false))
      peersRef.current.forEach((p) => p.pc.close())
      peersRef.current.clear()
      voiceRef.current?.teardown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room])

  function syncVoiceMembers(members: RosterMember[]) {
    voiceRef.current?.setMembers(members.map((m) => m.peerId))
  }

  function openFromSession(data: SessionInfo) {
    setDisplayName(data.displayName)
    setActive(data.active)
    setMaxViewers(data.maxViewers)
    setNewMax(data.maxViewers)
    setJoinMode(data.joinMode || 'ask')
    setVoiceEnabled(Boolean(data.voiceEnabled))
    setDenied('')
    panelRef.current = true
    setPanel(true)
  }

  async function boot() {
    setBooting(true)
    setDenied('')
    const res = await api<SessionInfo>('/api/session')
    if (res.ok && res.data.role === 'host' && res.data.room === room) {
      openFromSession(res.data)
      setBooting(false)
      return
    }
    if (owned) {
      const host = await api<SessionInfo>(`/api/rooms/${encodeURIComponent(room)}/resume`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      if (host.ok) {
        openFromSession(host.data)
        setBooting(false)
        return
      }
      setDenied(host.message)
      toast.error(host.message, { id: host.message })
    } else {
      setDenied('Só o aparelho que criou esta sala pode transmitir.')
    }
    setBooting(false)
  }

  function closePeer(key: string) {
    const link = peersRef.current.get(key)
    if (!link) return
    peersRef.current.delete(key)
    try {
      link.pc.close()
    } catch {
      /* ok */
    }
  }

  async function ensurePeer(peerId: string, slot: number, stream: MediaStream) {
    const key = peerKey(peerId, slot)
    if (peersRef.current.has(key)) return

    const pc = new RTCPeerConnection({ iceServers: iceRef.current })
    peersRef.current.set(key, { pc, peerId, slot })
    stream.getTracks().forEach((t) => pc.addTrack(t, stream))

    pc.onicecandidate = (ev) => {
      sendRef.current({
        type: 'ice',
        to: peerId,
        slot,
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
      })
    }
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) closePeer(key)
    }

    try {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
      if (sender) {
        const p = sender.getParameters()
        if (p.encodings?.[0]) {
          p.encodings[0].maxBitrate = 4_000_000
          await sender.setParameters(p)
        }
      }
    } catch {
      /* opcional */
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    sendRef.current({ type: 'offer', to: peerId, slot, sdp: offer.sdp || '' })
  }

  async function offerAllViewers(slot: number, stream: MediaStream) {
    for (const peerId of viewersRef.current.keys()) {
      await ensurePeer(peerId, slot, stream)
    }
  }

  async function onSignal(msg: SignalInbound) {
    if (msg.type === 'welcome') {
      iceRef.current = msg.iceServers?.length ? msg.iceServers : iceRef.current
      setActive(msg.active)
      setMaxViewers(msg.maxViewers)
      setNewMax(msg.maxViewers)
      if (msg.joinMode) setJoinMode(msg.joinMode)
      setSelfPeerId(msg.peerId)
      voiceRef.current?.setSelfPeerId(msg.peerId)
      const ve = Boolean(msg.voiceEnabled)
      setVoiceEnabled(ve)
      viewersRef.current = new Map((msg.viewers || []).map((v) => [v.peerId, v.displayName]))
      setPending(msg.pending || [])
      if (msg.voiceState) voiceRef.current?.applyVoiceState(msg.voiceState)
      const welcomeMembers: RosterMember[] = [
        { peerId: msg.peerId, role: 'host', displayName: msg.displayName },
        ...(msg.viewers || []).map((v) => ({
          peerId: v.peerId,
          role: 'viewer' as const,
          displayName: v.displayName,
        })),
      ]
      setRoster(welcomeMembers)
      syncVoiceMembers(welcomeMembers)
      await voiceRef.current?.setEnabled(ve)
      for (const [slot, share] of sharesRef.current) {
        await offerAllViewers(slot, share.stream)
      }
      return
    }
    if (msg.type === 'error') {
      toast.error(msg.message, { id: msg.message })
      return
    }
    if (msg.type === 'viewer_joined') {
      viewersRef.current.set(msg.peerId, msg.displayName)
      setChatFeed((prev) =>
        appendSystem(prev, joinedLine(msg.displayName, 'viewer'), `join-${msg.peerId}`),
      )
      for (const [slot, share] of sharesRef.current) {
        await ensurePeer(msg.peerId, slot, share.stream)
      }
      return
    }
    if (msg.type === 'viewer_left') {
      viewersRef.current.delete(msg.peerId)
      setChatFeed((prev) =>
        appendSystem(
          prev,
          leftLine(msg.displayName || 'Espectador', 'viewer'),
          `leave-${msg.peerId}`,
        ),
      )
      for (const key of [...peersRef.current.keys()]) {
        if (key.startsWith(`${msg.peerId}:`)) closePeer(key)
      }
      return
    }
    if (msg.type === 'answer') {
      const link = peersRef.current.get(peerKey(msg.from, msg.slot))
      if (!link) return
      if (!link.pc.currentRemoteDescription) {
        await link.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
      }
      const share = sharesRef.current.get(msg.slot)
      if (share && share.state !== 'live') {
        setShares((prev) => new Map(prev).set(msg.slot, { ...share, state: 'live' }))
      }
      return
    }
    if (msg.type === 'ice') {
      const link = peersRef.current.get(peerKey(msg.from, msg.slot))
      if (!link || !msg.candidate) return
      try {
        await link.pc.addIceCandidate(msg.candidate)
      } catch {
        /* race */
      }
      return
    }
    if (msg.type === 'voice_offer') {
      await voiceRef.current?.handleOffer(msg.from, msg.sdp)
      return
    }
    if (msg.type === 'voice_answer') {
      await voiceRef.current?.handleAnswer(msg.from, msg.sdp)
      return
    }
    if (msg.type === 'voice_ice') {
      await voiceRef.current?.handleIce(msg.from, msg.candidate)
      return
    }
    if (msg.type === 'voice_state') {
      voiceRef.current?.applyVoiceState(msg.peers)
      return
    }
    if (msg.type === 'chat_history') {
      setChatFeed(messagesToFeed(msg.messages))
      return
    }
    if (msg.type === 'chat') {
      setChatFeed((prev) => appendMessage(prev, msg.message))
      return
    }
    if (msg.type === 'roster') {
      setRoster(msg.members)
      const next = new Map(
        msg.members.filter((m) => m.role === 'viewer').map((m) => [m.peerId, m.displayName]),
      )
      for (const key of [...peersRef.current.keys()]) {
        const peerId = key.split(':')[0]
        if (!next.has(peerId)) closePeer(key)
      }
      viewersRef.current = next
      syncVoiceMembers(msg.members)
      return
    }
    if (msg.type === 'admit_request' || msg.type === 'pending') {
      if (msg.type === 'pending') setPending(msg.pending)
      else {
        setPending((prev) => {
          if (prev.some((p) => p.peerId === msg.peerId)) return prev
          return [...prev, { peerId: msg.peerId, displayName: msg.displayName }]
        })
      }
      return
    }
    if (msg.type === 'room_updated') {
      setActive(msg.active)
      setMaxViewers(msg.maxViewers)
      setNewMax(msg.maxViewers)
      if (msg.joinMode) setJoinMode(msg.joinMode)
      if (typeof msg.voiceEnabled === 'boolean') {
        setVoiceEnabled(msg.voiceEnabled)
        if (msg.voiceEnabled) syncVoiceMembers(rosterRef.current)
        void voiceRef.current?.setEnabled(msg.voiceEnabled)
      }
    }
  }

  async function shareScreen() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      action.fail('Este endereço não permite compartilhar tela. Use localhost ou HTTPS.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      })
      await publish(stream)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') return
      action.fail(err instanceof Error ? err.message : 'Falha ao compartilhar.')
    }
  }

  async function publish(stream: MediaStream) {
    const [track] = stream.getVideoTracks()
    if ('contentHint' in track) track.contentHint = 'detail'

    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      if (sharesRef.current.has(slot)) continue
      const entry: ShareEntry = { stream, state: 'live' }
      setShares((prev) => new Map(prev).set(slot, entry))
      sendRef.current({ type: 'slot_add', slot })
      track.addEventListener('ended', () => stopSlot(slot))
      await offerAllViewers(slot, stream)
      return
    }
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('Limite de telas atingido.')
  }

  function stopSlot(slot: number, notify = true) {
    const e = sharesRef.current.get(slot)
    if (!e) return
    setShares((prev) => {
      const next = new Map(prev)
      next.delete(slot)
      return next
    })
    if (notify) sendRef.current({ type: 'slot_remove', slot })
    for (const key of [...peersRef.current.keys()]) {
      if (key.endsWith(`:${slot}`)) closePeer(key)
    }
    e.stream.getTracks().forEach((t) => t.stop())
  }

  async function logout() {
    ;[...sharesRef.current.keys()].forEach((slot) => stopSlot(slot, false))
    voiceRef.current?.teardown()
    await api('/api/logout', { method: 'POST' })
    setPanel(false)
    navigate('/salas')
  }

  async function patchRoom(
    body: Record<string, unknown>,
    labels: { pending: string; success: string },
  ) {
    await action.run(labels, async () => {
      const data = await apiOrThrow<{
        active?: boolean
        maxViewers?: number
        joinMode?: JoinMode
        voiceEnabled?: boolean
      }>(`/api/rooms/${encodeURIComponent(room)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      if (typeof data.active === 'boolean') setActive(data.active)
      if (typeof data.maxViewers === 'number') {
        setMaxViewers(data.maxViewers)
        setNewMax(data.maxViewers)
      }
      if (data.joinMode) setJoinMode(data.joinMode)
      if (typeof data.voiceEnabled === 'boolean') {
        setVoiceEnabled(data.voiceEnabled)
        if (data.voiceEnabled) syncVoiceMembers(rosterRef.current)
        void voiceRef.current?.setEnabled(data.voiceEnabled)
      }
    })
  }

  async function toggleSelfMute() {
    try {
      await voiceRef.current?.setMuted(!voiceMuted)
      voiceRef.current?.resumePlayback()
    } catch (err) {
      action.fail(err instanceof Error ? err.message : 'Falha no microfone.')
    }
  }

  function hostMutePeer(peerId: string, muted: boolean) {
    sendRef.current({ type: 'voice_mute', peerId, muted })
  }

  function admit(peerId: string, accept: boolean) {
    sendRef.current({ type: 'admit', peerId, accept })
    setPending((prev) => prev.filter((p) => p.peerId !== peerId))
  }

  async function kickAllViewers() {
    await action.run({ pending: 'Removendo…', success: 'Espectadores removidos' }, async () => {
      await apiOrThrow(`/api/rooms/${encodeURIComponent(room)}/kick-viewers`, { method: 'POST' })
      for (const key of [...peersRef.current.keys()]) closePeer(key)
      viewersRef.current.clear()
      setRoster((prev) => prev.filter((m) => m.role !== 'viewer'))
      setPending([])
    })
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      toast.success('Link copiado')
    } catch {
      toast.error('Não foi possível copiar o link')
    }
  }

  if (booting) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-4 text-sm text-muted-foreground">
        Carregando…
      </div>
    )
  }

  if (!panel) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-4 pb-20 sm:pb-0">
        <div className="w-full max-w-md space-y-3 rounded-xl border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">Transmitir — {room}</h1>
          <p className="text-sm text-muted-foreground">
            {denied || 'Não foi possível abrir o painel nesta sala.'}
          </p>
          <Button type="button" variant="outline" onClick={() => navigate('/salas')}>
            Voltar às salas
          </Button>
        </div>
      </div>
    )
  }

  const sorted = [...shares.entries()].sort((a, b) => a[0] - b[0])
  const viewers = roster.filter((m) => m.role === 'viewer')
  const link = viewerInviteUrl(room)

  return (
    <ChatSplit
      chat={
        <RoomChat
          items={chatFeed}
          selfName={profileName || displayName}
          selfDeviceId={deviceId}
          onSend={(body) => sendRef.current({ type: 'chat', body })}
        />
      }
    >
      <div className="h-full min-h-0 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <header className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-xl font-semibold">Transmitir — {room}</h1>
              <p className="text-sm text-muted-foreground">
                {profileName || displayName} · {active ? 'sala ativa' : 'sala desativada'} ·{' '}
                {joinMode === 'open' ? 'pública' : 'com aceite'} · máx. {maxViewers}
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void logout()}>
              Sair
            </Button>
          </header>

          <section className="space-y-2">
            <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Link para espectadores
            </h2>
            <div className="flex items-start justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <span className="font-mono text-xs break-all">{link}</span>
              <Button type="button" variant="outline" size="sm" onClick={() => void copy(link)}>
                Copiar
              </Button>
            </div>
          </section>

          <Button type="button" disabled={shares.size >= MAX_SLOTS} onClick={() => void shareScreen()}>
            Compartilhar uma tela
          </Button>

          <section>
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              No ar
            </h2>
            {!sorted.length ? (
              <p className="text-sm text-muted-foreground">Nada sendo compartilhado.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {sorted.map(([slot, e]) => (
                  <li
                    key={slot}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2"
                  >
                    <span className="text-sm">
                      Tela {slot + 1}
                      {e.state === 'live' ? ' · transmitindo' : ' · conectando…'}
                    </span>
                    <Button type="button" variant="outline" size="sm" onClick={() => stopSlot(slot)}>
                      Parar
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {joinMode === 'ask' ? (
            <section className="space-y-2">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Pedidos ({pending.length})
              </h2>
              {!pending.length ? (
                <p className="text-sm text-muted-foreground">Ninguém aguardando.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {pending.map((p) => (
                    <li
                      key={p.peerId}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                    >
                      <span className="text-sm">{p.displayName}</span>
                      <div className="flex gap-2">
                        <Button type="button" size="sm" onClick={() => admit(p.peerId, true)}>
                          Aceitar
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => admit(p.peerId, false)}
                        >
                          Recusar
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          <section className="space-y-2">
            <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Espectadores ({viewers.length}/{maxViewers})
            </h2>
            {!viewers.length ? (
              <p className="text-sm text-muted-foreground">Ninguém assistindo.</p>
            ) : (
              <>
                <ul className="flex flex-col gap-2 text-sm">
                  {viewers.map((v) => {
                    const vs = voicePeers.find((p) => p.peerId === v.peerId)
                    const talking = speakingIds.includes(v.peerId)
                    return (
                      <li
                        key={v.peerId}
                        className="flex flex-wrap items-center justify-between gap-2"
                      >
                        <span>
                          {v.displayName}
                          {voiceEnabled ? (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {vs?.forceMuted
                                ? 'mutado pelo host'
                                : vs?.muted
                                  ? 'mudo'
                                  : talking
                                    ? 'falando'
                                    : 'mic ligado'}
                            </span>
                          ) : null}
                        </span>
                        {voiceEnabled ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => hostMutePeer(v.peerId, !vs?.forceMuted)}
                          >
                            {vs?.forceMuted ? 'Liberar mic' : 'Mutar'}
                          </Button>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
                <Button type="button" variant="outline" size="sm" onClick={() => void kickAllViewers()}>
                  Remover todos
                </Button>
              </>
            )}
          </section>

          {voiceEnabled ? (
            <section className="space-y-2 rounded-lg border border-border p-3">
              <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Seu microfone
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={voiceForceMuted}
                  onClick={() => void toggleSelfMute()}
                >
                  {voiceMuted ? 'Ativar mic' : 'Mutar mic'}
                </Button>
                {voiceForceMuted ? (
                  <span className="text-sm text-muted-foreground">Mic bloqueado</span>
                ) : (
                  <span className="text-sm text-muted-foreground">
                    {voiceMuted
                      ? 'Você está mudo'
                      : speakingIds.includes(selfPeerId)
                        ? 'Falando…'
                        : 'Mic ligado'}
                  </span>
                )}
              </div>
            </section>
          ) : null}

          <section className="space-y-3 rounded-lg border border-border p-3">
            <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Sala</h2>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void patchRoom(
                    { active: !active },
                    {
                      pending: active ? 'Desativando…' : 'Reativando…',
                      success: active ? 'Sala desativada' : 'Sala reativada',
                    },
                  )
                }
              >
                {active ? 'Desativar sala' : 'Reativar sala'}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void patchRoom(
                    { joinMode: joinMode === 'ask' ? 'open' : 'ask' },
                    {
                      pending: 'Atualizando…',
                      success:
                        joinMode === 'ask' ? 'Sala pública' : 'Entrada com aceite',
                    },
                  )
                }
              >
                {joinMode === 'ask' ? 'Tornar pública' : 'Exigir aceite'}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void patchRoom(
                    { voiceEnabled: !voiceEnabled },
                    {
                      pending: 'Atualizando…',
                      success: voiceEnabled ? 'Voz desligada' : 'Voz ligada',
                    },
                  )
                }
              >
                {voiceEnabled ? 'Desligar voz' : 'Ligar voz'}
              </Button>
            </div>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e: FormEvent) => {
                e.preventDefault()
                void patchRoom(
                  { maxViewers: newMax },
                  { pending: 'Salvando…', success: 'Limite atualizado' },
                )
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="max">Máx. espectadores</Label>
                <Input
                  id="max"
                  type="number"
                  min={1}
                  max={8}
                  value={newMax}
                  onChange={(e) => setNewMax(Number(e.target.value))}
                  className="w-24"
                />
              </div>
              <Button type="submit" size="sm" variant="outline">
                Salvar limite
              </Button>
            </form>
          </section>
        </div>
      </div>
    </ChatSplit>
  )
}
