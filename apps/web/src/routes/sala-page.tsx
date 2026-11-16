import { FormEvent, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useParams } from 'react-router'
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
import { useProfile } from '@/shell/profile'
import { useImmersive } from '@/shell/shell-mode'
import { useSignal } from '@/lib/use-signal'
import { peerKey, type SignalInbound, type SignalOutbound } from '@/lib/signal'

type TileEntry = {
  name: string
  video: HTMLVideoElement
  stateEl: HTMLElement
  tile: HTMLDivElement
}

export function SalaPage() {
  const { room = '' } = useParams()
  const action = useActionDialog()
  const { displayName: profileName, deviceId } = useProfile()
  const [displayName, setDisplayName] = useState('')
  const [key, setKey] = useState('')
  const [missing, setMissing] = useState('')
  const [booting, setBooting] = useState(true)
  const [active, setActive] = useState(false)
  const [waiting, setWaiting] = useState(true)
  const [chatFeed, setChatFeed] = useState<ChatFeedItem[]>([])
  const [roomActive, setRoomActive] = useState(true)

  useImmersive(active)

  const iceRef = useRef<RTCIceServer[]>([{ urls: 'stun:stun.l.google.com:19302' }])
  const peersRef = useRef(new Map<string, RTCPeerConnection>())
  const tilesRef = useRef(new Map<number, TileEntry>())
  const gridRef = useRef<HTMLDivElement>(null)
  const sendRef = useRef<(msg: SignalOutbound) => void>(() => undefined)

  const { send } = useSignal(
    active,
    (msg) => {
      void onSignal(msg)
    },
    () => toast.error('Conexão perdida. Tentando de novo…'),
  )
  sendRef.current = (msg) => send(msg)

  useEffect(() => {
    void boot()
    return () => {
      teardown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room])

  // Firefox pausa/congela <video> com MediaStream ao perder foco; ao voltar precisa play().
  useEffect(() => {
    if (!active) return

    function resumeVideos() {
      for (const { video, tile } of tilesRef.current.values()) {
        const stream = video.srcObject
        if (!stream) continue
        // Reatribuir o stream acorda o decoder do Firefox quando o frame fica preto.
        video.srcObject = null
        video.srcObject = stream
        void video
          .play()
          .then(() => {
            tile.classList.add('live')
            setWaiting(false)
          })
          .catch(() => {
            /* autoplay bloqueado — usuário precisa interagir */
          })
      }
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') resumeVideos()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', resumeVideos)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', resumeVideos)
    }
  }, [active])

  async function boot() {
    setBooting(true)
    const meta = await api<{ exists: boolean; active?: boolean }>(`/api/rooms/${encodeURIComponent(room)}`)
    if (!meta.ok || meta.data.exists === false) {
      setMissing('Sala não encontrada.')
      setBooting(false)
      return
    }
    if (meta.data.active === false) {
      setRoomActive(false)
    }

    const res = await api<SessionInfo>('/api/session')
    if (res.ok && res.data.role === 'viewer' && res.data.room === room) {
      setDisplayName(res.data.displayName)
      setActive(true)
    }
    setBooting(false)
  }

  function ensureTile(slot: number) {
    const grid = gridRef.current
    if (!grid) return null
    let entry = tilesRef.current.get(slot)
    if (entry) return entry

    const tile = document.createElement('div')
    tile.dataset.slot = String(slot)
    tile.className =
      'tile relative overflow-hidden rounded-xl border border-border bg-black ring-1 ring-foreground/10'
    tile.innerHTML =
      '<video autoplay muted playsinline class="block aspect-video w-full bg-black object-contain"></video>' +
      '<span class="tag absolute left-2.5 top-2.5 rounded-full bg-black/65 px-2 py-0.5 text-xs text-white"></span>' +
      '<span class="state absolute inset-0 grid place-items-center text-sm text-muted-foreground pointer-events-none">Conectando…</span>' +
      '<button type="button" class="fs absolute right-2.5 top-2.5 rounded bg-black/65 px-2 py-0.5 text-xs text-white">Tela cheia</button>'
    const tag = tile.querySelector('.tag') as HTMLElement
    tag.textContent = `Tela ${slot + 1}`
    const video = tile.querySelector('video') as HTMLVideoElement
    const stateEl = tile.querySelector('.state') as HTMLElement
    tile.querySelector('.fs')!.addEventListener('click', () => {
      void video.requestFullscreen?.()
    })
    video.addEventListener('playing', () => {
      tile.classList.add('live')
      setWaiting(false)
    })
    // Firefox: ao voltar do background o elemento fica paused sem limpar o stream.
    video.addEventListener('pause', () => {
      if (document.visibilityState !== 'visible' || !video.srcObject) return
      void video.play().catch(() => {
        /* ok */
      })
    })
    grid.appendChild(tile)
    entry = { name: `Tela ${slot + 1}`, video, stateEl, tile }
    tilesRef.current.set(slot, entry)
    return entry
  }

  function removeTile(slot: number) {
    const entry = tilesRef.current.get(slot)
    if (!entry) return
    tilesRef.current.delete(slot)
    entry.tile.remove()
  }

  function syncSlots(slots: number[]) {
    const wanted = new Set(slots)
    for (const slot of [...tilesRef.current.keys()]) {
      if (!wanted.has(slot)) {
        removeTile(slot)
        for (const key of [...peersRef.current.keys()]) {
          if (key.endsWith(`:${slot}`)) closePeer(key)
        }
      }
    }
    for (const slot of slots) ensureTile(slot)
    setWaiting(slots.length === 0)
  }

  function closePeer(key: string) {
    const pc = peersRef.current.get(key)
    if (!pc) return
    peersRef.current.delete(key)
    try {
      pc.close()
    } catch {
      /* ok */
    }
  }

  async function handleOffer(from: string, slot: number, sdp: string) {
    const tile = ensureTile(slot)
    if (!tile) return

    const key = peerKey(from, slot)
    closePeer(key)

    const pc = new RTCPeerConnection({ iceServers: iceRef.current })
    peersRef.current.set(key, pc)

    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track])
      tile.video.srcObject = stream
      void tile.video.play().catch(() => {
        /* autoplay — muted+playsinline cobrem o caso normal */
      })
    }
    pc.onicecandidate = (ev) => {
      sendRef.current({
        type: 'ice',
        to: from,
        slot,
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
      })
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        tile.stateEl.textContent = 'Reconectando…'
        tile.tile.classList.remove('live')
      }
      if (['failed', 'closed'].includes(pc.connectionState)) closePeer(key)
    }

    await pc.setRemoteDescription({ type: 'offer', sdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    sendRef.current({ type: 'answer', to: from, slot, sdp: answer.sdp || '' })
  }

  async function onSignal(msg: SignalInbound) {
    if (msg.type === 'welcome') {
      iceRef.current = msg.iceServers?.length ? msg.iceServers : iceRef.current
      setRoomActive(msg.active)
      syncSlots(msg.slots || [])
      return
    }
    if (msg.type === 'error') {
      toast.error(msg.message, { id: msg.message })
      if (
        msg.message.includes('Sessão') ||
        msg.message.includes('Chave') ||
        msg.message.includes('desativada') ||
        msg.message.includes('cheia')
      ) {
        void leave()
      }
      return
    }
    if (msg.type === 'auth_changed') {
      toast.error(msg.message, { id: msg.message })
      void leave()
      return
    }
    if (msg.type === 'slots') {
      syncSlots(msg.slots)
      return
    }
    if (msg.type === 'host_joined') {
      setChatFeed((prev) =>
        appendSystem(prev, joinedLine(msg.displayName, 'host'), `host-join-${msg.peerId}`),
      )
      return
    }
    if (msg.type === 'host_left') {
      setChatFeed((prev) => appendSystem(prev, 'O host saiu', `host-leave-${Date.now()}`))
      peersRef.current.forEach((pc) => pc.close())
      peersRef.current.clear()
      tilesRef.current.forEach((t) => {
        t.video.srcObject = null
        t.tile.classList.remove('live')
        t.stateEl.textContent = 'Aguardando o host transmitir…'
      })
      setWaiting(true)
      return
    }
    if (msg.type === 'viewer_joined') {
      setChatFeed((prev) =>
        appendSystem(prev, joinedLine(msg.displayName, 'viewer'), `join-${msg.peerId}`),
      )
      return
    }
    if (msg.type === 'viewer_left') {
      setChatFeed((prev) =>
        appendSystem(
          prev,
          leftLine(msg.displayName || 'Espectador', 'viewer'),
          `leave-${msg.peerId}`,
        ),
      )
      return
    }
    if (msg.type === 'offer') {
      await handleOffer(msg.from, msg.slot, msg.sdp)
      return
    }
    if (msg.type === 'ice') {
      const pc = peersRef.current.get(peerKey(msg.from, msg.slot))
      if (!pc || !msg.candidate) return
      try {
        await pc.addIceCandidate(msg.candidate)
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
    if (msg.type === 'room_updated') {
      setRoomActive(msg.active)
      if (!msg.active) {
        toast.error('Sala desativada pelo host.')
        void leave()
      }
    }
  }

  async function enter(e?: FormEvent) {
    e?.preventDefault()
    if (!key) {
      action.fail('Informe a chave.')
      return
    }
    await action.run({ pending: 'Entrando…', success: 'Pronto' }, async () => {
      const data = await apiOrThrow<SessionInfo>(`/api/rooms/${encodeURIComponent(room)}/viewer`, {
        method: 'POST',
        body: JSON.stringify({ viewerKey: key }),
      })
      setDisplayName(data.displayName)
      setActive(true)
    })
  }

  function teardown() {
    peersRef.current.forEach((pc) => pc.close())
    peersRef.current.clear()
    tilesRef.current.forEach((t) => t.tile.remove())
    tilesRef.current.clear()
    gridRef.current?.replaceChildren()
    setChatFeed([])
    setWaiting(true)
  }

  async function leave() {
    teardown()
    setActive(false)
    await api('/api/logout', { method: 'POST' })
    setKey('')
  }

  if (booting) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-4 text-sm text-muted-foreground">
        Carregando…
      </div>
    )
  }

  if (!active) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-4 pb-20 sm:pb-0">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Sala {room}</CardTitle>
            <CardDescription>
              {missing
                ? missing
                : !roomActive
                  ? 'Esta sala está desativada no momento.'
                  : 'Informe a chave dos espectadores.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {roomActive && !missing ? (
              <form className="flex flex-col gap-3" onSubmit={(e) => void enter(e)} autoComplete="off">
                <div className="space-y-2">
                  <Label htmlFor="key">Chave</Label>
                  <Input
                    id="key"
                    type="password"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    required
                    autoFocus
                  />
                </div>
                <Button type="submit" disabled={action.busy} className="w-full">
                  Entrar
                </Button>
              </form>
            ) : null}
          </CardContent>
        </Card>
      </div>
    )
  }

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
      <div className="flex h-full min-h-0 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-border bg-card/80 px-4 py-3 backdrop-blur">
          <b className="font-medium">Sala {room}</b>
          <Button type="button" variant="outline" size="sm" onClick={() => void leave()}>
            Sair
          </Button>
        </header>
        <div
          ref={gridRef}
          className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto p-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]"
        />
        {waiting ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">Aguardando o host transmitir…</p>
        ) : null}
        <style>{`.tile.live .state{display:none}`}</style>
      </div>
    </ChatSplit>
  )
}
