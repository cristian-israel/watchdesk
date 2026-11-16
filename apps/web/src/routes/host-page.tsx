import { FormEvent, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ChatSplit } from '@/components/chat-split'
import { RoomChat } from '@/components/room-chat'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, type SessionInfo } from '@/lib/api'
import {
  appendMessage,
  appendSystem,
  joinedLine,
  leftLine,
  messagesToFeed,
  type ChatFeedItem,
} from '@/lib/chat-feed'
import { useProfile } from '@/shell/profile'
import {
  SignalClient,
  peerKey,
  type RosterMember,
  type SignalInbound,
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
  const { displayName: profileName, room: owned } = useProfile()
  const [displayName, setDisplayName] = useState('')
  const [hostKey, setHostKey] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [booting, setBooting] = useState(true)
  const [panel, setPanel] = useState(false)
  const [links, setLinks] = useState<string[]>([])
  const [shares, setShares] = useState<Map<number, ShareEntry>>(new Map())
  const [roster, setRoster] = useState<RosterMember[]>([])
  const [chatFeed, setChatFeed] = useState<ChatFeedItem[]>([])
  const [active, setActive] = useState(true)
  const [maxViewers, setMaxViewers] = useState(8)
  const [newHostKey, setNewHostKey] = useState('')
  const [newViewerKey, setNewViewerKey] = useState('')
  const [newMax, setNewMax] = useState(8)

  const panelRef = useRef(false)
  const sharesRef = useRef(shares)
  sharesRef.current = shares
  panelRef.current = panel

  const signalRef = useRef<SignalClient | null>(null)
  const iceRef = useRef<RTCIceServer[]>([{ urls: 'stun:stun.l.google.com:19302' }])
  const viewersRef = useRef(new Map<string, string>())
  const peersRef = useRef(new Map<string, PeerLink>())
  const welcomedRef = useRef(false)

  useEffect(() => {
    void boot()
    return () => {
      ;[...sharesRef.current.keys()].forEach((slot) => stopSlot(slot))
      signalRef.current?.close()
      peersRef.current.forEach((p) => p.pc.close())
      peersRef.current.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room])

  function openFromSession(data: SessionInfo) {
    setDisplayName(data.displayName)
    setLinks(data.links || [])
    setActive(data.active)
    setMaxViewers(data.maxViewers)
    setNewMax(data.maxViewers)
    panelRef.current = true
    setPanel(true)
    openSignal()
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
      const host = await api<SessionInfo>(`/api/rooms/${encodeURIComponent(room)}/host`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      if (host.ok) {
        openFromSession(host.data)
        setBooting(false)
        return
      }
      setError(host.message)
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
      signalRef.current?.send({
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
    signalRef.current?.send({ type: 'offer', to: peerId, slot, sdp: offer.sdp || '' })
  }

  async function offerAllViewers(slot: number, stream: MediaStream) {
    for (const peerId of viewersRef.current.keys()) {
      await ensurePeer(peerId, slot, stream)
    }
  }

  async function onSignal(msg: SignalInbound) {
    if (msg.type === 'welcome') {
      welcomedRef.current = true
      iceRef.current = msg.iceServers?.length ? msg.iceServers : iceRef.current
      setActive(msg.active)
      setMaxViewers(msg.maxViewers)
      setNewMax(msg.maxViewers)
      viewersRef.current = new Map((msg.viewers || []).map((v) => [v.peerId, v.displayName]))
      for (const [slot, share] of sharesRef.current) {
        await offerAllViewers(slot, share.stream)
      }
      return
    }
    if (msg.type === 'error') {
      setError(msg.message)
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
    }
  }

  function openSignal() {
    signalRef.current?.close()
    welcomedRef.current = false
    const client = new SignalClient()
    signalRef.current = client
    client.onMessage = (msg) => {
      void onSignal(msg)
    }
    client.onClose = () => {
      if (panelRef.current && welcomedRef.current) {
        setError('Conexão perdida. Tentando de novo…')
        setTimeout(() => {
          if (panelRef.current) openSignal()
        }, 1500)
      }
    }
    client.connect({ type: 'hello' })
  }

  async function onEnter(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    const res = await api<SessionInfo>(`/api/rooms/${encodeURIComponent(room)}/host`, {
      method: 'POST',
      body: JSON.stringify({ hostKey }),
    })
    setBusy(false)
    if (!res.ok) {
      setError(res.message)
      return
    }
    openFromSession(res.data)
  }

  async function shareScreen() {
    setError('')
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setError('Este endereço não permite compartilhar tela. Use localhost ou HTTPS.')
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
      setError(err instanceof Error ? err.message : 'Falha ao compartilhar.')
    }
  }

  async function publish(stream: MediaStream) {
    const [track] = stream.getVideoTracks()
    if ('contentHint' in track) track.contentHint = 'detail'

    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      if (sharesRef.current.has(slot)) continue
      const entry: ShareEntry = { stream, state: 'live' }
      setShares((prev) => new Map(prev).set(slot, entry))
      signalRef.current?.send({ type: 'slot_add', slot })
      track.addEventListener('ended', () => stopSlot(slot))
      await offerAllViewers(slot, stream)
      return
    }
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('Limite de telas atingido.')
  }

  function stopSlot(slot: number) {
    const e = sharesRef.current.get(slot)
    if (!e) return
    setShares((prev) => {
      const next = new Map(prev)
      next.delete(slot)
      return next
    })
    signalRef.current?.send({ type: 'slot_remove', slot })
    for (const key of [...peersRef.current.keys()]) {
      if (key.endsWith(`:${slot}`)) closePeer(key)
    }
    e.stream.getTracks().forEach((t) => t.stop())
  }

  async function logout() {
    ;[...sharesRef.current.keys()].forEach((slot) => stopSlot(slot))
    signalRef.current?.close()
    await api('/api/logout', { method: 'POST' })
    setPanel(false)
    navigate('/')
  }

  async function patchRoom(body: Record<string, unknown>) {
    setError('')
    setInfo('')
    const res = await api<{ message?: string; links?: string[]; active?: boolean; maxViewers?: number }>(
      `/api/rooms/${encodeURIComponent(room)}`,
      { method: 'PATCH', body: JSON.stringify(body) },
    )
    if (!res.ok) {
      setError(res.message)
      return
    }
    if (res.data.links) setLinks(res.data.links)
    if (typeof res.data.active === 'boolean') setActive(res.data.active)
    if (typeof res.data.maxViewers === 'number') {
      setMaxViewers(res.data.maxViewers)
      setNewMax(res.data.maxViewers)
    }
    setInfo(res.data.message || 'Atualizado.')
    setNewHostKey('')
    setNewViewerKey('')
  }

  async function kickAllViewers() {
    setError('')
    setInfo('')
    const res = await api<{ message?: string }>(`/api/rooms/${encodeURIComponent(room)}/kick-viewers`, {
      method: 'POST',
    })
    if (!res.ok) {
      setError(res.message)
      return
    }
    for (const key of [...peersRef.current.keys()]) closePeer(key)
    viewersRef.current.clear()
    setRoster((prev) => prev.filter((m) => m.role !== 'viewer'))
    setInfo(res.data.message || 'Espectadores removidos.')
  }

  async function copy(url: string, btn: HTMLButtonElement) {
    try {
      await navigator.clipboard.writeText(url)
      btn.textContent = 'Copiado'
    } catch {
      btn.textContent = 'Selecione'
    }
    setTimeout(() => {
      btn.textContent = 'Copiar'
    }, 1500)
  }

  if (booting) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-4 pb-20 text-sm text-muted-foreground sm:pb-0">
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
              <Button type="submit" disabled={busy} className="w-full">
                Entrar
              </Button>
              {error ? (
                <p className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
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
          onSend={(body) => signalRef.current?.send({ type: 'chat', body })}
        />
      }
    >
      <div className="h-full min-h-0 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          <header className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="text-xl font-semibold">Transmitir — {room}</h1>
              <p className="text-sm text-muted-foreground">
                {profileName || displayName} · {active ? 'sala ativa' : 'sala desativada'} · máx. {maxViewers} espectadores
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void logout()}>
              Sair
            </Button>
          </header>

          <Button type="button" disabled={shares.size >= MAX_SLOTS} onClick={() => void shareScreen()}>
            Compartilhar uma tela
          </Button>

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
            {!viewers.length ? (
              <p className="text-sm text-muted-foreground">Ninguém assistindo.</p>
            ) : (
              <>
                <ul className="text-sm">
                  {viewers.map((v) => (
                    <li key={v.peerId}>{v.displayName}</li>
                  ))}
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
            <ul className="flex flex-col gap-2">
              {(links.length ? links : [`${location.origin}/sala/${room}`]).map((url) => (
                <li
                  key={url}
                  className="flex items-start justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2"
                >
                  <span className="font-mono text-xs break-all">{url}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={(ev) => void copy(url, ev.currentTarget)}
                  >
                    Copiar
                  </Button>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-3 rounded-lg border border-border p-3">
            <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Sala</h2>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void patchRoom({ active: !active })}
              >
                {active ? 'Desativar sala' : 'Reativar sala'}
              </Button>
            </div>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void patchRoom({ maxViewers: newMax })
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
              Chaves da sala
            </h2>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (!newHostKey) return
                void patchRoom({ hostKey: newHostKey })
              }}
            >
              <Label htmlFor="newHost">Nova chave do host</Label>
              <div className="flex gap-2">
                <Input
                  id="newHost"
                  type="password"
                  value={newHostKey}
                  onChange={(e) => setNewHostKey(e.target.value)}
                  minLength={4}
                  placeholder="deixe vazio para não alterar"
                />
                <Button type="submit" size="sm" variant="outline" disabled={newHostKey.length < 4}>
                  Trocar
                </Button>
              </div>
            </form>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (!newViewerKey) return
                void patchRoom({ viewerKey: newViewerKey })
              }}
            >
              <Label htmlFor="newViewer">Nova chave dos espectadores</Label>
              <div className="flex gap-2">
                <Input
                  id="newViewer"
                  type="password"
                  value={newViewerKey}
                  onChange={(e) => setNewViewerKey(e.target.value)}
                  minLength={4}
                />
                <Button type="submit" size="sm" variant="outline" disabled={newViewerKey.length < 4}>
                  Trocar
                </Button>
              </div>
            </form>
          </section>

          {info ? <p className="text-sm text-muted-foreground">{info}</p> : null}
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </ChatSplit>
  )
}
