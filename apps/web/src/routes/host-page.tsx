import { FormEvent, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNavigate, useParams } from 'react-router'
import { useActionDialog } from '@/actions/action-dialog'
import { ChatSplit } from '@/components/chat-split'
import { RoomChat } from '@/components/room-chat'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, apiOrThrow, type SessionInfo } from '@/lib/api'
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
import {
  peerKey,
  type ControlMode,
  type RosterMember,
  type SignalInbound,
  type SignalOutbound,
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
  const { displayName: profileName, deviceId, room: owned } = useProfile()
  const [displayName, setDisplayName] = useState('')
  const [hostKey, setHostKey] = useState('')
  const [booting, setBooting] = useState(true)
  const [panel, setPanel] = useState(false)
  const [shares, setShares] = useState<Map<number, ShareEntry>>(new Map())
  const [roster, setRoster] = useState<RosterMember[]>([])
  const [chatFeed, setChatFeed] = useState<ChatFeedItem[]>([])
  const [active, setActive] = useState(true)
  const [maxViewers, setMaxViewers] = useState(8)
  const [viewerInvite, setViewerInvite] = useState('')
  const [hostInvite, setHostInvite] = useState('')
  const [newMax, setNewMax] = useState(8)
  const [pilotPeerId, setPilotPeerId] = useState<string | null>(null)
  const [transmitMode, setTransmitMode] = useState<'web' | 'companion'>('web')
  const [companionPanel, setCompanionPanel] = useState(false)
  const [companionMeta, setCompanionMeta] = useState<{
    version: string
    downloadUrl?: string
    downloadUrlLinux?: string
  } | null>(null)

  const companionPanelRef = useRef(false)
  const sharesRef = useRef(shares)
  sharesRef.current = shares
  companionPanelRef.current = companionPanel

  const iceRef = useRef<RTCIceServer[]>([{ urls: 'stun:stun.l.google.com:19302' }])
  const viewersRef = useRef(new Map<string, string>())
  const peersRef = useRef(new Map<string, PeerLink>())
  const sendRef = useRef<(msg: SignalOutbound) => void>(() => undefined)

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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room])

  function openFromSession(data: SessionInfo) {
    setDisplayName(data.displayName)
    setActive(data.active)
    setMaxViewers(data.maxViewers)
    setNewMax(data.maxViewers)
    if (data.viewerInvite) setViewerInvite(data.viewerInvite)
    if (data.hostInvite) setHostInvite(data.hostInvite)
    panelRef.current = true
    setPanel(true)
  }

  async function boot() {
    setBooting(true)
    const res = await api<SessionInfo>('/api/session')
    if (res.ok && res.data.role === 'host' && res.data.room === room) {
      openFromSession(res.data)
      setBooting(false)
      return
    }
    if (owned?.slug === room) {
      if (owned.viewerInvite) setViewerInvite(owned.viewerInvite)
      if (owned.hostInvite) setHostInvite(owned.hostInvite)
      const host = await api<SessionInfo>(`/api/rooms/${encodeURIComponent(room)}/host`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      if (host.ok) {
        openFromSession(host.data)
        setBooting(false)
        return
      }
      toast.error(host.message, { id: host.message })
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
    // Canal para input remoto (companion injeta; web host ignora eventos).
    pc.createDataChannel('watchdesk-input', { ordered: true })

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
      setPilotPeerId(msg.pilotPeerId ?? null)
      setTransmitMode(msg.transmitMode || 'web')
      setCompanionPanel(Boolean(msg.panel) || msg.transmitMode === 'companion')
      if (msg.companion) setCompanionMeta(msg.companion)
      viewersRef.current = new Map((msg.viewers || []).map((v) => [v.peerId, v.displayName]))
      // Painel não publica mídia — companion (ou este browser em modo web) transmite.
      if (!msg.panel && msg.transmitMode !== 'companion') {
        for (const [slot, share] of sharesRef.current) {
          await offerAllViewers(slot, share.stream)
        }
      }
      return
    }
    if (msg.type === 'host_role') {
      setCompanionPanel(msg.role === 'panel')
      if (msg.transmitMode) setTransmitMode(msg.transmitMode)
      if (msg.role === 'panel') {
        for (const key of [...peersRef.current.keys()]) closePeer(key)
        for (const [, share] of sharesRef.current) {
          share.stream.getTracks().forEach((t) => t.stop())
        }
        sharesRef.current = new Map()
        setShares(new Map())
        toast.message(msg.message || 'Companion transmitindo — este navegador é o painel.')
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
      if (!companionPanelRef.current && transmitMode !== 'companion') {
        for (const [slot, share] of sharesRef.current) {
          await ensurePeer(msg.peerId, slot, share.stream)
        }
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
      return
    }
    if (msg.type === 'room_updated') {
      setActive(msg.active)
      setMaxViewers(msg.maxViewers)
      setNewMax(msg.maxViewers)
      return
    }
    if (msg.type === 'control_changed') {
      setPilotPeerId(msg.mode === 'interact' ? msg.peerId : null)
      setRoster((prev) =>
        prev.map((m) =>
          m.peerId === msg.peerId ? { ...m, controlMode: msg.mode } : m.role === 'viewer' && msg.mode === 'interact' ? { ...m, controlMode: 'view' } : m,
        ),
      )
      if (msg.mode === 'interact') {
        toast.message(`${msg.displayName} pode interagir`)
      }
    }
  }

  function setViewerControl(peerId: string, mode: ControlMode) {
    sendRef.current({ type: 'set_control', peerId, mode })
  }

  async function onEnter(e: FormEvent) {
    e.preventDefault()
    if (hostKey.length < 4) {
      action.fail('Informe a chave do host.')
      return
    }
    await action.run({ pending: 'Entrando…', success: 'Pronto' }, async () => {
      const data = await apiOrThrow<SessionInfo>(`/api/rooms/${encodeURIComponent(room)}/host`, {
        method: 'POST',
        body: JSON.stringify({ hostKey }),
      })
      openFromSession(data)
    })
  }

  async function shareScreen() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      action.fail('Este endereço não permite compartilhar tela. Use localhost ou HTTPS.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
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
    await api('/api/logout', { method: 'POST' })
    setPanel(false)
    navigate('/salas')
  }

  async function patchRoom(body: Record<string, unknown>, labels: { pending: string; success: string }) {
    await action.run(labels, async () => {
      const data = await apiOrThrow<{
        message?: string
        active?: boolean
        maxViewers?: number
        viewerInvite?: string
        hostInvite?: string
      }>(`/api/rooms/${encodeURIComponent(room)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      })
      if (typeof data.active === 'boolean') setActive(data.active)
      if (typeof data.maxViewers === 'number') {
        setMaxViewers(data.maxViewers)
        setNewMax(data.maxViewers)
      }
      if (typeof data.viewerInvite === 'string') setViewerInvite(data.viewerInvite)
      if (typeof data.hostInvite === 'string') setHostInvite(data.hostInvite)
    })
  }

  async function kickAllViewers() {
    await action.run({ pending: 'Removendo…', success: 'Espectadores removidos' }, async () => {
      await apiOrThrow(`/api/rooms/${encodeURIComponent(room)}/kick-viewers`, { method: 'POST' })
      for (const key of [...peersRef.current.keys()]) closePeer(key)
      viewersRef.current.clear()
      setRoster((prev) => prev.filter((m) => m.role !== 'viewer'))
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
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Transmitir — {room}</CardTitle>
            <CardDescription>Entre com a chave do host.</CardDescription>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-3" onSubmit={(e) => void onEnter(e)} autoComplete="off">
              <div className="space-y-2">
                <Label htmlFor="hostKey">Chave do host</Label>
                <Input
                  id="hostKey"
                  type="password"
                  value={hostKey}
                  onChange={(e) => setHostKey(e.target.value)}
                  minLength={4}
                  required
                  autoFocus
                />
              </div>
              <Button type="submit" disabled={action.busy} className="w-full">
                Entrar
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    )
  }

  const sorted = [...shares.entries()].sort((a, b) => a[0] - b[0])
  const viewers = roster.filter((m) => m.role === 'viewer')

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
              <h1 className="text-xl font-semibold">
                {transmitMode === 'companion' || companionPanel ? 'Painel' : 'Watch'} — {room}
              </h1>
              <p className="text-sm text-muted-foreground">
                {profileName || displayName} · {active ? 'sala ativa' : 'sala desativada'} · máx.{' '}
                {maxViewers} espectadores
                {transmitMode === 'companion' || companionPanel
                  ? ' · Assist (companion)'
                  : ' · Watch (só ver)'}
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void logout()}>
              Sair
            </Button>
          </header>

          {transmitMode === 'companion' || companionPanel ? (
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
              Painel leve: o Companion está transmitindo. Aqui você ainda pode promover, chat e
              segurança. Preferência: fazer isso no próprio app.
            </p>
          ) : (
            <>
              <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                Controle remoto com mouse/teclado no desktop exige o{' '}
                <a className="text-primary underline" href="/">
                  Companion
                </a>
                . Compartilhar tela pelo browser é só visualização (sem injeção no SO).
              </p>
              <Button type="button" disabled={shares.size >= MAX_SLOTS} onClick={() => void shareScreen()}>
                Compartilhar uma tela (só ver)
              </Button>
              {companionMeta ? (
                <p className="text-sm text-muted-foreground">
                  Baixar companion:{' '}
                  <a className="text-primary underline" href={companionMeta.downloadUrl || '#'}>
                    Windows
                  </a>
                  {' · '}
                  <a
                    className="text-primary underline"
                    href={companionMeta.downloadUrlLinux || '/companion/watchdesk-companion.AppImage'}
                  >
                    Linux
                  </a>
                  {companionMeta.version ? ` (v${companionMeta.version})` : ''}.
                </p>
              ) : null}
            </>
          )}

          <section>
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">No ar</h2>
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

          <section className="space-y-2">
            <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Espectadores ({viewers.length}/{maxViewers})
            </h2>
            {transmitMode === 'web' && !companionPanel ? (
              <p className="text-sm text-muted-foreground">
                Modo Watch (só ver): promover a interagir exige o Companion transmitindo. Baixe na
                página Início.
              </p>
            ) : null}
            {!viewers.length ? (
              <p className="text-sm text-muted-foreground">Ninguém assistindo.</p>
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {viewers.map((v) => {
                    const interacting = v.controlMode === 'interact' || v.peerId === pilotPeerId
                    const canAssist = transmitMode === 'companion' || companionPanel
                    return (
                      <li
                        key={v.peerId}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2"
                      >
                        <span className="text-sm">
                          {v.displayName}
                          <span className="text-muted-foreground">
                            {' '}
                            · {interacting ? 'interagir' : 'só ver'}
                          </span>
                        </span>
                        {canAssist ? (
                          <div className="flex flex-wrap gap-1">
                            {interacting ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => setViewerControl(v.peerId, 'view')}
                              >
                                Só ver
                              </Button>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => setViewerControl(v.peerId, 'interact')}
                              >
                                Permitir interagir
                              </Button>
                            )}
                          </div>
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

          <section>
            <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Link para espectadores
            </h2>
            <div className="flex items-start justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <span className="font-mono text-xs break-all">
                {viewerInviteUrl(room, viewerInvite || owned?.viewerInvite || '')}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  void copy(viewerInviteUrl(room, viewerInvite || owned?.viewerInvite || ''))
                }
              >
                Copiar
              </Button>
            </div>
          </section>

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
            </div>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
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

          <section className="space-y-3 rounded-lg border border-border p-3">
            <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Segurança
            </h2>
            <p className="text-sm text-muted-foreground">
              Regenerar invalida o link antigo. Quem já está na sala como espectador precisa entrar de novo.
            </p>
            {hostInvite || owned?.hostInvite ? (
              <div className="space-y-1">
                <Label>Chave do host (outro aparelho)</Label>
                <p className="font-mono text-xs break-all text-muted-foreground">
                  {hostInvite || owned?.hostInvite}
                </p>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  void patchRoom(
                    { regenerateViewerKey: true },
                    { pending: 'Regenerando…', success: 'Link dos espectadores regenerado' },
                  )
                }
              >
                Regenerar link
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  void patchRoom(
                    { regenerateHostKey: true },
                    { pending: 'Regenerando…', success: 'Chave do host regenerada' },
                  )
                }
              >
                Regenerar chave do host
              </Button>
            </div>
          </section>

        </div>
      </div>
    </ChatSplit>
  )
}
