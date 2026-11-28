import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  Headphones,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Users,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useNavigate, useParams } from 'react-router'
import { useActionDialog } from '@/actions/action-dialog'
import { AudioSettingsPanel } from '@/components/audio-settings-panel'
import { ControlButton, IslandDivider } from '@/components/control-button'
import { RoomChat } from '@/components/room-chat'
import { RoomExpiryCountdown } from '@/components/room-expiry'
import { StageBoard, type StageItem } from '@/components/stage-board'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
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
import { cn } from '@/lib/utils'
import { useProfile } from '@/shell/profile'
import { useImmersive } from '@/shell/shell-mode'
import { useSignal } from '@/lib/use-signal'
import { MAX_SLOTS, ScreenShareSession, normalizeSlots } from '@/lib/screen-share'
import { VoiceMesh, voiceMeshSupportsDevices } from '@/lib/voice-mesh'
import type { RosterMember, SignalInbound, SignalOutbound, SlotInfo } from '@/lib/signal'

type RemoteShare = {
  info: SlotInfo
  stream: MediaStream
}

type SidePanel = 'closed' | 'people' | 'chat' | 'audio'

const SIDE_MIN = 260
const SIDE_MAX = 560
const SIDE_DEFAULT = 320
const SIDE_WIDTH_KEY = 'watchdesk.viewerSideWidth'

function readSideWidth() {
  try {
    const n = Number(localStorage.getItem(SIDE_WIDTH_KEY))
    if (Number.isFinite(n)) return Math.min(SIDE_MAX, Math.max(SIDE_MIN, n))
  } catch {
    /* ignore */
  }
  return SIDE_DEFAULT
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0] || ''}${parts[1]![0] || ''}`.toUpperCase()
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
  const navigate = useNavigate()
  const action = useActionDialog()
  const { displayName: profileName, deviceId, user } = useProfile()
  const [displayName, setDisplayName] = useState('')
  const [missing, setMissing] = useState('')
  const [booting, setBooting] = useState(true)
  const [needsJoin, setNeedsJoin] = useState(false)
  const [joinRole, setJoinRole] = useState<'viewer' | 'controller'>('viewer')
  const [controllerPassword, setControllerPassword] = useState('')
  const [controllerDenied, setControllerDenied] = useState(false)
  const [active, setActive] = useState(false)
  const [admitPending, setAdmitPending] = useState(false)
  const [denied, setDenied] = useState('')
  const [waiting, setWaiting] = useState(true)
  const [chatFeed, setChatFeed] = useState<ChatFeedItem[]>([])
  const [roomActive, setRoomActive] = useState(true)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)
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
  const [side, setSide] = useState<SidePanel>('closed')
  const [sideWidth, setSideWidth] = useState(readSideWidth)
  const watching = active && !admitPending
  useImmersive(watching)

  const sideRef = useRef(side)
  sideRef.current = side
  const sideWidthRef = useRef(sideWidth)
  sideWidthRef.current = sideWidth
  const iceRef = useRef<RTCIceServer[]>([{ urls: 'stun:stun.l.google.com:19302' }])
  const sendRef = useRef<(msg: SignalOutbound) => void>(() => undefined)
  const admitPendingRef = useRef(admitPending)
  admitPendingRef.current = admitPending
  const voiceEnabledRef = useRef(voiceEnabled)
  voiceEnabledRef.current = voiceEnabled
  const voiceAwaitRosterRef = useRef(false)
  const selfPeerIdRef = useRef('')
  selfPeerIdRef.current = selfPeerId
  const rosterRef = useRef(roster)
  rosterRef.current = roster
  const voiceRef = useRef<VoiceMesh | null>(null)
  {
    const prev = voiceRef.current
    if (!voiceMeshSupportsDevices(prev)) {
      if (prev) prev.teardown()
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
    setNeedsJoin(false)
    setControllerDenied(false)
    const meta = await api<{ exists: boolean; active?: boolean; joinMode?: string; status?: string }>(
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
    if (res.ok && res.data.room === room) {
      if (res.data.role === 'host') {
        navigate(`/salas/${encodeURIComponent(room)}`, { replace: true })
        return
      }
      if (res.data.role === 'viewer') {
        setDisplayName(res.data.displayName)
        setExpiresAt(res.data.expiresAt || res.data.roomSummary?.expiresAt || null)
        setActive(true)
        setAdmitPending((meta.data.joinMode || res.data.joinMode) === 'ask')
        setBooting(false)
        return
      }
    }

    setNeedsJoin(true)
    setBooting(false)
  }

  async function enter() {
    if (!profileName) {
      setMissing('Defina seu apelido antes de entrar.')
      return
    }
    setControllerDenied(false)
    await action.run({ pending: 'Entrando…', success: 'Pronto' }, async () => {
      try {
        const data = await apiOrThrow<SessionInfo>(`/api/rooms/${encodeURIComponent(room)}/join`, {
          method: 'POST',
          body: JSON.stringify({
            role: joinRole,
            controllerPassword: joinRole === 'controller' ? controllerPassword : undefined,
            displayName: profileName,
          }),
        })
        if (data.role === 'host') {
          navigate(`/salas/${encodeURIComponent(room)}`, { replace: true })
          return
        }
        setDisplayName(data.displayName)
        setExpiresAt(data.expiresAt || data.roomSummary?.expiresAt || null)
        setMissing('')
        setDenied('')
        setNeedsJoin(false)
        setActive(true)
        setAdmitPending(data.status === 'pending')
      } catch (e: unknown) {
        const err = e as Error & { code?: string }
        if (err.code === 'controller_unauthorized') {
          setControllerDenied(true)
          setJoinRole('viewer')
          throw new Error('Não autorizado como controlador. Você pode entrar como espectador.')
        }
        throw e
      }
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
      if (msg.expiresAt !== undefined) setExpiresAt(msg.expiresAt)
      setCanShareScreen(Boolean(msg.canShareScreen))
      if (msg.admitStatus === 'pending') {
        setAdmitPending(true)
        voiceAwaitRosterRef.current = false
        await voiceRef.current?.setEnabled(false)
        return
      }
      setAdmitPending(false)
      syncSlots(normalizeSlots(msg.slots))
      if (msg.voiceState) voiceRef.current?.applyVoiceState(msg.voiceState)
      // Liga a voz só após o roster — evita descartar offers dos peers já na sala.
      if (ve) {
        if (rosterRef.current.length > 0) {
          voiceRef.current?.setMembers(rosterRef.current.map((m) => m.peerId))
          voiceAwaitRosterRef.current = false
          await voiceRef.current?.setEnabled(true)
        } else {
          voiceAwaitRosterRef.current = true
        }
      } else {
        voiceAwaitRosterRef.current = false
        await voiceRef.current?.setEnabled(false)
      }
      return
    }
    if (msg.type === 'admit_result') {
      if (msg.accepted) {
        setAdmitPending(false)
        setDenied('')
        syncSlots(normalizeSlots(msg.slots))
        toast.success('Você entrou na sala')
        if (voiceEnabledRef.current) {
          if (rosterRef.current.length > 0) {
            voiceRef.current?.setMembers(rosterRef.current.map((m) => m.peerId))
            voiceAwaitRosterRef.current = false
            await voiceRef.current?.setEnabled(true)
          } else {
            voiceAwaitRosterRef.current = true
          }
        }
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
    if (msg.type === 'role_changed') {
      toast.message(msg.message || 'Seu papel na sala mudou.')
      if (msg.role === 'host') {
        navigate(`/salas/${encodeURIComponent(room)}`, { replace: true })
      }
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
      if (voiceAwaitRosterRef.current && voiceEnabledRef.current) {
        voiceAwaitRosterRef.current = false
        await voiceRef.current?.setEnabled(true)
      }
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
      if (admitPendingRef.current) return
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
      const mine =
        Boolean(deviceId && msg.message.authorDeviceId === deviceId) ||
        msg.message.authorName === (profileName || displayName)
      if (!mine && sideRef.current !== 'chat') {
        toast.message(msg.message.authorName, {
          id: `chat-${msg.message.id}`,
          description: msg.message.body,
          action: {
            label: 'Abrir',
            onClick: () => setSide('chat'),
          },
        })
      }
      return
    }
    if (msg.type === 'room_updated') {
      setRoomActive(msg.active)
      if (msg.expiresAt !== undefined) setExpiresAt(msg.expiresAt)
      if (typeof msg.voiceEnabled === 'boolean') {
        setVoiceEnabled(msg.voiceEnabled)
        if (!admitPendingRef.current) {
          voiceAwaitRosterRef.current = false
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
    voiceAwaitRosterRef.current = false
    voiceRef.current?.teardown()
    setChatFeed([])
    setRoster([])
    setSpeakingIds([])
    setSelfPeerId('')
    setVoiceEnabled(false)
    setCanShareScreen(false)
    setLocalSharing(false)
    setWaiting(true)
    setSide('closed')
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

  function toggleSide(next: Exclude<SidePanel, 'closed'>) {
    setSide((cur) => (cur === next ? 'closed' : next))
  }

  function onSideResizePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault()
    const startX = e.clientX
    const startW = sideWidthRef.current
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)

    function onMove(ev: PointerEvent) {
      const next = Math.min(SIDE_MAX, Math.max(SIDE_MIN, startW + (startX - ev.clientX)))
      sideWidthRef.current = next
      setSideWidth(next)
    }

    function onUp(ev: PointerEvent) {
      el.releasePointerCapture(ev.pointerId)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      try {
        localStorage.setItem(SIDE_WIDTH_KEY, String(sideWidthRef.current))
      } catch {
        /* ignore */
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
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
                    ? 'Esta sala expirou ou foi encerrada.'
                    : needsJoin
                      ? 'Escolha como entrar: espectador ou controlador.'
                      : 'Entre com o link desta sala.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {roomActive && !missing && needsJoin ? (
              <>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={joinRole === 'viewer' ? 'default' : 'outline'}
                    className="flex-1"
                    onClick={() => setJoinRole('viewer')}
                  >
                    Espectador
                  </Button>
                  <Button
                    type="button"
                    variant={joinRole === 'controller' ? 'default' : 'outline'}
                    className="flex-1"
                    onClick={() => setJoinRole('controller')}
                  >
                    Controlador
                  </Button>
                </div>
                {joinRole === 'controller' && !user ? (
                  <div className="space-y-2">
                    <Label htmlFor="ctrl-pass">Senha de controlador</Label>
                    <Input
                      id="ctrl-pass"
                      type="password"
                      value={controllerPassword}
                      onChange={(e) => setControllerPassword(e.target.value)}
                      placeholder="Se você foi designado"
                    />
                  </div>
                ) : null}
                {joinRole === 'controller' && user ? (
                  <p className="text-xs text-muted-foreground">
                    Dono entra sem senha. Designado precisa da senha de controlador.
                  </p>
                ) : null}
                {joinRole === 'controller' && user ? (
                  <div className="space-y-2">
                    <Label htmlFor="ctrl-pass-user">Senha de controlador (se designado)</Label>
                    <Input
                      id="ctrl-pass-user"
                      type="password"
                      value={controllerPassword}
                      onChange={(e) => setControllerPassword(e.target.value)}
                    />
                  </div>
                ) : null}
                {controllerDenied ? (
                  <p className="text-sm text-destructive">
                    Não autorizado como controlador. Entre como espectador.
                  </p>
                ) : null}
                <Button
                  type="button"
                  disabled={action.busy || !profileName}
                  className="w-full"
                  onClick={() => void enter()}
                >
                  Entrar
                </Button>
              </>
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
            <CardTitle>Aguardando o controlador…</CardTitle>
            <CardDescription>
              Você pediu para entrar em {room}. Quando o controlador aceitar, a transmissão aparece aqui.
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
  const selfName = profileName || displayName
  const selfSpeaking = speakingIds.includes(selfPeerId) && !voiceMuted
  const sideOpen = side !== 'closed'

  return (
    <div
      className="relative flex h-full min-h-0 flex-col bg-background"
      onPointerDownCapture={() => resumeMediaPlayback()}
    >
      <header className="absolute inset-x-0 top-0 z-20 flex items-center gap-3 px-3 py-2.5 sm:px-4">
        <div className="min-w-0 rounded-md bg-background/80 px-2.5 py-1.5 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-mono text-sm font-medium">{room}</h1>
            <RoomExpiryCountdown expiresAt={expiresAt} />
          </div>
          {voiceEnabled ? (
            <SpeakingHint
              speakingIds={speakingIds}
              selfPeerId={selfPeerId}
              selfMuted={voiceMuted}
              roster={roster}
            />
          ) : (
            <p className="truncate text-xs text-muted-foreground">{selfName}</p>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1 bg-black">
          <div className="absolute inset-0 pt-14 pb-24 sm:pb-28">
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

          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3 pb-4 sm:pb-5">
            <div className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-border bg-card/95 px-2 py-2 shadow-lg backdrop-blur-sm sm:gap-2 sm:px-3">
              {voiceEnabled ? (
                <ControlButton
                  label={
                    voiceForceMuted
                      ? 'Mic bloqueado'
                      : voiceMuted
                        ? 'Ativar mic'
                        : selfSpeaking
                          ? 'Falando'
                          : 'Mutar mic'
                  }
                  active={!voiceMuted && !voiceForceMuted}
                  disabled={voiceForceMuted || action.busy}
                  onClick={() => void toggleSelfMute()}
                >
                  {voiceMuted || voiceForceMuted ? (
                    <MicOff className="size-5" />
                  ) : (
                    <Mic className="size-5" />
                  )}
                </ControlButton>
              ) : null}

              {canShareScreen ? (
                <ControlButton
                  label={localSharing ? 'Parar tela' : 'Compartilhar tela'}
                  active={localSharing}
                  disabled={!localSharing && (slotBusy || action.busy)}
                  onClick={() => {
                    if (localSharing) stopSharing()
                    else void shareScreen()
                  }}
                >
                  {localSharing ? (
                    <ScreenShareOff className="size-5" />
                  ) : (
                    <ScreenShare className="size-5" />
                  )}
                </ControlButton>
              ) : null}

              {voiceEnabled || canShareScreen ? <IslandDivider /> : null}

              <ControlButton
                label="Pessoas"
                active={side === 'people'}
                onClick={() => toggleSide('people')}
              >
                <Users className="size-5" />
              </ControlButton>

              <ControlButton
                label="Mensagens"
                active={side === 'chat'}
                onClick={() => toggleSide('chat')}
              >
                <MessageSquare className="size-5" />
              </ControlButton>

              <ControlButton
                label="Áudio"
                active={side === 'audio'}
                onClick={() => toggleSide('audio')}
              >
                <Headphones className="size-5" />
              </ControlButton>

              <IslandDivider />

              <ControlButton label="Sair" danger onClick={() => void leave()}>
                <PhoneOff className="size-5" />
              </ControlButton>
            </div>
          </div>
        </div>

        {sideOpen ? (
          <>
            <button
              type="button"
              aria-label="Fechar painel"
              className="absolute inset-0 z-30 bg-black/40 md:hidden"
              onClick={() => setSide('closed')}
            />
            <aside
              className={cn(
                'relative z-40 flex shrink-0 flex-col border-l border-border bg-card',
                'max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:w-full max-md:max-w-sm',
                'md:w-[var(--viewer-side-w)]',
              )}
              style={{ ['--viewer-side-w' as string]: `${sideWidth}px` }}
            >
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Redimensionar painel"
                onPointerDown={onSideResizePointerDown}
                className={cn(
                  'absolute inset-y-0 -left-1 z-50 hidden w-3 cursor-col-resize touch-none md:block',
                  'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border',
                  'hover:after:bg-primary/60 active:after:w-0.5 active:after:bg-primary',
                )}
              >
                <div className="absolute top-1/2 left-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border" />
              </div>

              <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
                {(
                  [
                    ['people', 'Pessoas', Users],
                    ['chat', 'Chat', MessageSquare],
                    ['audio', 'Áudio', Headphones],
                  ] as const
                ).map(([id, label, Icon]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setSide(id)}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
                      side === id
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )}
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </button>
                ))}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  aria-label="Fechar"
                  onClick={() => setSide('closed')}
                >
                  <X className="size-4" />
                </Button>
              </div>

              {side === 'people' ? (
                <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">
                    Na sala · {roster.length}
                  </p>
                  {!roster.length ? (
                    <p className="px-1.5 py-2 text-xs text-muted-foreground">Ninguém na sala.</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {roster.map((m) => {
                        const talking = speakingIds.includes(m.peerId)
                        const isSelf = m.peerId === selfPeerId
                        return (
                          <li
                            key={m.peerId}
                            className="flex items-center gap-2.5 rounded-md px-1.5 py-2"
                          >
                            <div className="relative shrink-0">
                              <Avatar size="sm">
                                <AvatarFallback>{initials(m.displayName)}</AvatarFallback>
                              </Avatar>
                              {talking && !(isSelf && voiceMuted) ? (
                                <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-card" />
                              ) : null}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm">
                                {m.displayName}
                                {isSelf ? (
                                  <span className="text-muted-foreground"> (você)</span>
                                ) : null}
                              </p>
                              <p className="truncate text-xs text-muted-foreground">
                                {m.role === 'host'
                                  ? 'Host'
                                  : talking
                                    ? 'Falando'
                                    : voiceEnabled
                                      ? 'Na sala'
                                      : 'Espectador'}
                              </p>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              ) : null}

              {side === 'chat' ? (
                <div className="min-h-0 flex-1">
                  <RoomChat
                    items={chatFeed}
                    selfName={selfName}
                    selfDeviceId={deviceId}
                    onSend={(body) => sendRef.current({ type: 'chat', body })}
                  />
                </div>
              ) : null}

              {side === 'audio' ? (
                <AudioSettingsPanel
                  voice={voiceRef.current}
                  voiceEnabled={voiceEnabled}
                  onError={(message) => action.fail(message)}
                />
              ) : null}
            </aside>
          </>
        ) : null}
      </div>
    </div>
  )
}
