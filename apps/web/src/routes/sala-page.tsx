import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useParams } from 'react-router'
import { useActionDialog } from '@/actions/action-dialog'
import { ChatSplit } from '@/components/chat-split'
import { RoomChat } from '@/components/room-chat'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { MAX_SLOTS, ScreenShareSession, normalizeSlots } from '@/lib/screen-share'
import { VoiceMesh } from '@/lib/voice-mesh'
import type { RosterMember, SignalInbound, SignalOutbound, SlotInfo } from '@/lib/signal'

type TileEntry = {
  name: string
  video: HTMLVideoElement
  stateEl: HTMLElement
  tile: HTMLDivElement
}

function SpeakingHint({
  speakingIds,
  selfPeerId,
  selfMuted,
  roster,
}: {
  speakingIds: string[]
  selfPeerId: string
  selfMuted: boolean
  roster: RosterMember[]
}) {
  const parts: string[] = []
  if (speakingIds.includes(selfPeerId) && !selfMuted) parts.push('Você')
  for (const id of speakingIds) {
    if (id === selfPeerId) continue
    const name = roster.find((m) => m.peerId === id)?.displayName
    if (name) parts.push(name)
    if (parts.length >= 4) break
  }
  if (!parts.length) return null
  return (
    <p className="truncate text-xs text-muted-foreground">{parts.join(', ')} falando</p>
  )
}

export function SalaPage() {
  const { room = '' } = useParams()
  const action = useActionDialog()
  const { displayName: profileName, deviceId } = useProfile()
  const [displayName, setDisplayName] = useState('')
  const [missing, setMissing] = useState('')
  const [booting, setBooting] = useState(true)
  const [active, setActive] = useState(false)
  const [admitPending, setAdmitPending] = useState(false)
  const [denied, setDenied] = useState('')
  const [waiting, setWaiting] = useState(true)
  const [chatFeed, setChatFeed] = useState<ChatFeedItem[]>([])
  const [roomActive, setRoomActive] = useState(true)
  const [voiceEnabled, setVoiceEnabled] = useState(false)
  const [voiceMuted, setVoiceMuted] = useState(true)
  const [voiceForceMuted, setVoiceForceMuted] = useState(false)
  const [speakingIds, setSpeakingIds] = useState<string[]>([])
  const [selfPeerId, setSelfPeerId] = useState('')
  const [roster, setRoster] = useState<RosterMember[]>([])
  const [canShareScreen, setCanShareScreen] = useState(false)
  const [localSharing, setLocalSharing] = useState(false)
  const watching = active && !admitPending
  useImmersive(watching)

  const iceRef = useRef<RTCIceServer[]>([{ urls: 'stun:stun.l.google.com:19302' }])
  const tilesRef = useRef(new Map<number, TileEntry>())
  const gridRef = useRef<HTMLDivElement>(null)
  const sendRef = useRef<(msg: SignalOutbound) => void>(() => undefined)
  const admitPendingRef = useRef(admitPending)
  admitPendingRef.current = admitPending
  const voiceEnabledRef = useRef(voiceEnabled)
  voiceEnabledRef.current = voiceEnabled
  const selfPeerIdRef = useRef('')
  selfPeerIdRef.current = selfPeerId
  const rosterRef = useRef(roster)
  rosterRef.current = roster
  const voiceRef = useRef<VoiceMesh | null>(null)
  if (!voiceRef.current) {
    voiceRef.current = new VoiceMesh({
      send: (msg) => sendRef.current(msg),
      iceServers: () => iceRef.current,
      onLocalMuteChange: (muted, forceMuted) => {
        setVoiceMuted(muted)
        setVoiceForceMuted(forceMuted)
      },
      onSpeakingChange: (ids) => setSpeakingIds(ids),
    })
  }

  const screenRef = useRef<ScreenShareSession | null>(null)
  if (!screenRef.current) {
    screenRef.current = new ScreenShareSession({
      send: (msg) => sendRef.current(msg),
      iceServers: () => iceRef.current,
      selfPeerId: () => selfPeerIdRef.current,
      memberIds: () =>
        rosterRef.current.map((m) => m.peerId).filter((id) => id !== selfPeerIdRef.current),
      onRemoteStream: (info, stream) => {
        const tile = ensureTile(info)
        if (!tile) return
        tile.video.srcObject = stream
        if (stream.getAudioTracks().length) tile.video.muted = false
        void tile.video.play().catch(() => {
          /* autoplay */
        })
        setWaiting(false)
      },
      onRemoteSlotRemoved: (slot) => removeTile(slot),
    })
  }

  function resumeMediaPlayback() {
    voiceRef.current?.resumePlayback()
    for (const { video } of tilesRef.current.values()) {
      const stream = video.srcObject
      if (stream instanceof MediaStream && stream.getAudioTracks().length) {
        video.muted = false
      }
      void video.play().catch(() => {
        /* autoplay */
      })
    }
  }

  const { send } = useSignal(
    active,
    (msg) => {
      void onSignal(msg)
    },
    () => {
      if (!admitPendingRef.current) toast.error('Conexão perdida. Tentando de novo…')
    },
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
    if (!watching) return

    function resumeVideos() {
      for (const { video, tile } of tilesRef.current.values()) {
        const stream = video.srcObject
        if (!stream) continue
        video.srcObject = null
        video.srcObject = stream
        void video
          .play()
          .then(() => {
            tile.classList.add('live')
            setWaiting(false)
          })
          .catch(() => {
            /* autoplay bloqueado */
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
  }, [watching])

  async function boot() {
    setBooting(true)
    setDenied('')
    setAdmitPending(false)
    const meta = await api<{ exists: boolean; active?: boolean; joinMode?: string }>(
      `/api/rooms/${encodeURIComponent(room)}`,
    )
    if (!meta.ok || meta.data.exists === false) {
      setMissing('Sala não encontrada.')
      setBooting(false)
      return
    }
    if (meta.data.active === false) {
      setRoomActive(false)
      setBooting(false)
      return
    }

    const res = await api<SessionInfo>('/api/session')
    if (res.ok && res.data.role === 'viewer' && res.data.room === room) {
      setDisplayName(res.data.displayName)
      setActive(true)
      // welcome no WS confirma admitido vs fila (ask)
      setAdmitPending((meta.data.joinMode || res.data.joinMode) === 'ask')
      setBooting(false)
      return
    }

    await enter()
    setBooting(false)
  }

  async function enter() {
    if (!profileName) {
      setMissing('Defina seu nome no menu antes de entrar.')
      return
    }
    await action.run({ pending: 'Entrando…', success: 'Pronto' }, async () => {
      const data = await apiOrThrow<SessionInfo>(`/api/rooms/${encodeURIComponent(room)}/viewer`, {
        method: 'POST',
        body: JSON.stringify({}),
      })
      setDisplayName(data.displayName)
      setMissing('')
      setDenied('')
      setActive(true)
      setAdmitPending(data.status === 'pending')
    })
  }

  function ensureTile(info: SlotInfo | number) {
    const slotInfo: SlotInfo =
      typeof info === 'number'
        ? { slot: info, peerId: '', displayName: `Tela ${info + 1}` }
        : info
    const grid = gridRef.current
    if (!grid) return null
    let entry = tilesRef.current.get(slotInfo.slot)
    if (entry) {
      const tag = entry.tile.querySelector('.tag') as HTMLElement
      tag.textContent = slotInfo.displayName || `Tela ${slotInfo.slot + 1}`
      entry.name = tag.textContent
      return entry
    }

    const tile = document.createElement('div')
    tile.dataset.slot = String(slotInfo.slot)
    tile.className =
      'tile relative overflow-hidden rounded-xl border border-border bg-black ring-1 ring-foreground/10'
    tile.innerHTML =
      '<video autoplay muted playsinline class="block aspect-video w-full bg-black object-contain"></video>' +
      '<span class="tag absolute left-2.5 top-2.5 rounded-full bg-black/65 px-2 py-0.5 text-xs text-white"></span>' +
      '<span class="state absolute inset-0 grid place-items-center text-sm text-muted-foreground pointer-events-none">Conectando…</span>' +
      '<button type="button" class="fs absolute right-2.5 top-2.5 rounded bg-black/65 px-2 py-0.5 text-xs text-white">Tela cheia</button>'
    const tag = tile.querySelector('.tag') as HTMLElement
    tag.textContent = slotInfo.displayName || `Tela ${slotInfo.slot + 1}`
    const video = tile.querySelector('video') as HTMLVideoElement
    const stateEl = tile.querySelector('.state') as HTMLElement
    tile.querySelector('.fs')!.addEventListener('click', () => {
      void video.requestFullscreen?.()
    })
    video.addEventListener('playing', () => {
      tile.classList.add('live')
      setWaiting(false)
    })
    video.addEventListener('pause', () => {
      if (document.visibilityState !== 'visible' || !video.srcObject) return
      void video.play().catch(() => {
        /* ok */
      })
    })
    grid.appendChild(tile)
    entry = { name: tag.textContent, video, stateEl, tile }
    tilesRef.current.set(slotInfo.slot, entry)
    return entry
  }

  function removeTile(slot: number) {
    const entry = tilesRef.current.get(slot)
    if (!entry) return
    tilesRef.current.delete(slot)
    entry.tile.remove()
    setWaiting(!tilesRef.current.size && !screenRef.current?.localSlotCount)
  }

  function syncSlots(slots: SlotInfo[]) {
    const self = selfPeerIdRef.current
    const remote = slots.filter((s) => s.peerId !== self)
    const wanted = new Set(remote.map((s) => s.slot))
    for (const slot of [...tilesRef.current.keys()]) {
      if (!wanted.has(slot)) removeTile(slot)
    }
    for (const info of remote) ensureTile(info)
    screenRef.current?.applySlots(slots)
    setWaiting(!remote.length && !screenRef.current?.localSlotCount)
    setLocalSharing((screenRef.current?.localSlotCount || 0) > 0)
  }

  async function onSignal(msg: SignalInbound) {
    if (msg.type === 'welcome') {
      iceRef.current = msg.iceServers?.length ? msg.iceServers : iceRef.current
      setRoomActive(msg.active)
      setSelfPeerId(msg.peerId)
      selfPeerIdRef.current = msg.peerId
      voiceRef.current?.setSelfPeerId(msg.peerId)
      const ve = Boolean(msg.voiceEnabled)
      setVoiceEnabled(ve)
      setCanShareScreen(Boolean(msg.canShareScreen))
      if (msg.admitStatus === 'pending') {
        setAdmitPending(true)
        await voiceRef.current?.setEnabled(false)
        return
      }
      setAdmitPending(false)
      syncSlots(normalizeSlots(msg.slots))
      if (msg.voiceState) voiceRef.current?.applyVoiceState(msg.voiceState)
      await voiceRef.current?.setEnabled(ve)
      return
    }
    if (msg.type === 'admit_result') {
      if (msg.accepted) {
        setAdmitPending(false)
        setDenied('')
        syncSlots(normalizeSlots(msg.slots))
        toast.success('Você entrou na sala')
        if (voiceEnabledRef.current) await voiceRef.current?.setEnabled(true)
      } else {
        setDenied(msg.message || 'O host recusou sua entrada.')
        teardown()
        setActive(false)
        setAdmitPending(false)
        await api('/api/logout', { method: 'POST' })
      }
      return
    }
    if (msg.type === 'error') {
      toast.error(msg.message, { id: msg.message })
      return
    }
    if (msg.type === 'auth_changed') {
      toast.error(msg.message, { id: msg.message })
      void leave()
      return
    }
    if (msg.type === 'slots') {
      if (!admitPendingRef.current) syncSlots(normalizeSlots(msg.slots))
      return
    }
    if (msg.type === 'screen_allow') {
      setCanShareScreen(msg.canShareScreen)
      if (!msg.canShareScreen) {
        screenRef.current?.stopAllLocal(true)
        setLocalSharing(false)
      }
      return
    }
    if (msg.type === 'host_joined') {
      setChatFeed((prev) =>
        appendSystem(prev, joinedLine(msg.displayName, 'host'), `host-join-${msg.peerId}`),
      )
      await screenRef.current?.onMemberJoined(msg.peerId)
      return
    }
    if (msg.type === 'host_left') {
      setChatFeed((prev) => appendSystem(prev, 'O host saiu', `host-leave-${Date.now()}`))
      screenRef.current?.teardown()
      tilesRef.current.forEach((t) => {
        t.video.srcObject = null
        t.tile.classList.remove('live')
        t.stateEl.textContent = 'Aguardando o host transmitir…'
      })
      setLocalSharing(false)
      setWaiting(true)
      return
    }
    if (msg.type === 'viewer_joined') {
      setChatFeed((prev) =>
        appendSystem(prev, joinedLine(msg.displayName, 'viewer'), `join-${msg.peerId}`),
      )
      await screenRef.current?.onMemberJoined(msg.peerId)
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
      screenRef.current?.onMemberLeft(msg.peerId)
      return
    }
    if (msg.type === 'roster') {
      setRoster(msg.members)
      voiceRef.current?.setMembers(msg.members.map((m) => m.peerId))
      return
    }
    if (msg.type === 'offer') {
      if (admitPendingRef.current) return
      await screenRef.current?.handleOffer(msg.from, msg.slot, msg.sdp)
      return
    }
    if (msg.type === 'answer') {
      await screenRef.current?.handleAnswer(msg.from, msg.slot, msg.sdp)
      return
    }
    if (msg.type === 'ice') {
      if (admitPendingRef.current) return
      await screenRef.current?.handleIce(msg.from, msg.slot, msg.candidate)
      return
    }
    if (msg.type === 'voice_offer') {
      if (admitPendingRef.current) return
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
    if (msg.type === 'room_updated') {
      setRoomActive(msg.active)
      if (typeof msg.voiceEnabled === 'boolean') {
        setVoiceEnabled(msg.voiceEnabled)
        if (!admitPendingRef.current) {
          void voiceRef.current?.setEnabled(msg.voiceEnabled)
        }
      }
      if (!msg.active) {
        toast.error('Sala desativada pelo host.')
        void leave()
      }
    }
  }

  function teardown() {
    screenRef.current?.teardown()
    tilesRef.current.forEach((t) => t.tile.remove())
    tilesRef.current.clear()
    gridRef.current?.replaceChildren()
    voiceRef.current?.teardown()
    setChatFeed([])
    setRoster([])
    setSpeakingIds([])
    setSelfPeerId('')
    setVoiceEnabled(false)
    setCanShareScreen(false)
    setLocalSharing(false)
    setWaiting(true)
  }

  async function toggleSelfMute() {
    try {
      await voiceRef.current?.setMuted(!voiceMuted)
      resumeMediaPlayback()
    } catch (err) {
      action.fail(err instanceof Error ? err.message : 'Falha no microfone.')
    }
  }

  async function shareScreen() {
    if (!canShareScreen) return
    if (!navigator.mediaDevices?.getDisplayMedia) {
      action.fail('Este endereço não permite compartilhar tela. Use localhost ou HTTPS.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: true,
      })
      await screenRef.current!.publish(stream)
      setLocalSharing(true)
      setWaiting(false)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') return
      action.fail(err instanceof Error ? err.message : 'Falha ao compartilhar.')
    }
  }

  function stopSharing() {
    screenRef.current?.stopAllLocal(true)
    setLocalSharing(false)
  }

  async function leave() {
    teardown()
    setActive(false)
    setAdmitPending(false)
    await api('/api/logout', { method: 'POST' })
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
              {denied
                ? denied
                : missing
                  ? missing
                  : !roomActive
                    ? 'Esta sala está desativada no momento.'
                    : 'Entre com o link desta sala.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {roomActive && !missing && !denied ? (
              <Button
                type="button"
                disabled={action.busy || !profileName}
                className="w-full"
                onClick={() => void enter()}
              >
                Entrar
              </Button>
            ) : denied ? (
              <Button type="button" className="w-full" onClick={() => void enter()}>
                Tentar de novo
              </Button>
            ) : null}
          </CardContent>
        </Card>
      </div>
    )
  }

  if (admitPending) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-4 pb-20 sm:pb-0">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Aguardando o host…</CardTitle>
            <CardDescription>
              Você pediu para entrar em {room}. Quando o host aceitar, a transmissão aparece aqui.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="outline" className="w-full" onClick={() => void leave()}>
              Cancelar
            </Button>
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
      <div
        className="flex h-full min-h-0 flex-col"
        onPointerDownCapture={() => resumeMediaPlayback()}
      >
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-card/80 px-4 py-3 backdrop-blur">
          <div className="min-w-0">
            <b className="font-medium">Sala {room}</b>
            {voiceEnabled ? (
              <SpeakingHint
                speakingIds={speakingIds}
                selfPeerId={selfPeerId}
                selfMuted={voiceMuted}
                roster={roster}
              />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canShareScreen ? (
              localSharing ? (
                <Button type="button" variant="outline" size="sm" onClick={() => stopSharing()}>
                  Parar tela
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={tilesRef.current.size >= MAX_SLOTS}
                  onClick={() => void shareScreen()}
                >
                  Compartilhar tela
                </Button>
              )
            ) : null}
            {voiceEnabled ? (
              <>
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
                  <span className="text-xs text-muted-foreground">Mic bloqueado pelo host</span>
                ) : speakingIds.includes(selfPeerId) && !voiceMuted ? (
                  <span className="text-xs text-muted-foreground">Falando…</span>
                ) : null}
              </>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={() => void leave()}>
              Sair
            </Button>
          </div>
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
