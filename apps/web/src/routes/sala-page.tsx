import { useEffect, useRef, useState } from 'react'
import { MonitorUp } from 'lucide-react'
import { toast } from 'sonner'
import { useParams } from 'react-router'
import { useActionDialog } from '@/actions/action-dialog'
import { ChatSplit } from '@/components/chat-split'
import { RoomChat } from '@/components/room-chat'
import { StageBoard, type StageItem } from '@/components/stage-board'
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

type RemoteShare = {
  info: SlotInfo
  stream: MediaStream
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
  const [locals, setLocals] = useState<Map<number, MediaStream>>(() => new Map())
  const [remotes, setRemotes] = useState<Map<number, RemoteShare>>(() => new Map())
  const watching = active && !admitPending
  useImmersive(watching)

  const iceRef = useRef<RTCIceServer[]>([{ urls: 'stun:stun.l.google.com:19302' }])
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
        setRemotes((prev) => {
          const next = new Map(prev)
          next.set(info.slot, { info, stream })
          return next
        })
        setWaiting(false)
      },
      onRemoteSlotRemoved: (slot) => removeRemote(slot),
    })
  }

  function resumeMediaPlayback() {
    voiceRef.current?.resumePlayback()
  }

  function syncLocalShares() {
    const list = screenRef.current?.listLocalShares() || []
    setLocals(new Map(list.map((x) => [x.slot, x.stream])))
    setLocalSharing(list.length > 0)
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

  function removeRemote(slot: number) {
    setRemotes((prev) => {
      if (!prev.has(slot)) return prev
      const next = new Map(prev)
      next.delete(slot)
      const localCount = screenRef.current?.localSlotCount || 0
      setWaiting(next.size === 0 && localCount === 0)
      return next
    })
  }

  function syncSlots(slots: SlotInfo[]) {
    const self = selfPeerIdRef.current
    const remote = slots.filter((s) => s.peerId !== self)
    const wanted = new Set(remote.map((s) => s.slot))
    setRemotes((prev) => {
      const next = new Map(prev)
      for (const slot of [...next.keys()]) {
        if (!wanted.has(slot)) next.delete(slot)
      }
      for (const info of remote) {
        const cur = next.get(info.slot)
        if (cur) next.set(info.slot, { ...cur, info })
      }
      return next
    })
    screenRef.current?.applySlots(slots)
    syncLocalShares()
    const localCount = screenRef.current?.localSlotCount || 0
    setWaiting(!remote.length && localCount === 0)
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
        setLocals(new Map())
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
      setRemotes(new Map())
      setLocals(new Map())
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
    setRemotes(new Map())
    setLocals(new Map())
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
      syncLocalShares()
      setWaiting(false)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') return
      action.fail(err instanceof Error ? err.message : 'Falha ao compartilhar.')
    }
  }

  function stopSharing() {
    screenRef.current?.stopAllLocal(true)
    setLocals(new Map())
    setLocalSharing(false)
  }

  function stopLocalSlot(slot: number) {
    screenRef.current?.stopSlot(slot, true)
    setLocals((prev) => {
      const next = new Map(prev)
      next.delete(slot)
      return next
    })
    setLocalSharing((screenRef.current?.localSlotCount || 0) > 0)
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

  const stageItems: StageItem[] = [
    ...[...locals.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([slot, stream]) => ({
        slot,
        label: `Você · Tela ${slot + 1}`,
        stream,
        muted: true,
        onStop: () => stopLocalSlot(slot),
      })),
    ...[...remotes.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([slot, entry]) => ({
        slot,
        label: entry.info.displayName || `Tela ${slot + 1}`,
        stream: entry.stream,
        muted: entry.stream.getAudioTracks().length === 0,
      })),
  ]
  const slotBusy = locals.size + remotes.size >= MAX_SLOTS

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
        className="flex h-full min-h-0 flex-col bg-black"
        onPointerDownCapture={() => resumeMediaPlayback()}
      >
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border bg-card/90 px-4 py-3 backdrop-blur">
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
                  disabled={slotBusy}
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
        <div className="min-h-0 flex-1">
          <StageBoard
            items={stageItems}
            empty={
              <div className="flex flex-col items-center justify-center gap-2 px-6 text-center">
                <MonitorUp className="size-10 text-white/25" />
                <p className="text-sm text-white/60">
                  {waiting ? 'Aguardando transmissão…' : 'Nada no ar'}
                </p>
              </div>
            }
          />
        </div>
      </div>
    </ChatSplit>
  )
}
