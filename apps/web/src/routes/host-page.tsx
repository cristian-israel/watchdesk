import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react'
import {
  Check,
  Copy,
  Link2,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  ScreenShare,
  ScreenShareOff,
  Settings2,
  UserX,
  Users,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useNavigate, useParams } from 'react-router'
import { useActionDialog } from '@/actions/action-dialog'
import { RoomChat } from '@/components/room-chat'
import { StageBoard, type StageItem } from '@/components/stage-board'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, apiOrThrow, type JoinMode, type SessionInfo } from '@/lib/api'
import { cn } from '@/lib/utils'
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
import { MAX_SLOTS, ScreenShareSession, normalizeSlots } from '@/lib/screen-share'
import { VoiceMesh } from '@/lib/voice-mesh'
import {
  type PendingMember,
  type RosterMember,
  type SignalInbound,
  type SignalOutbound,
  type SlotInfo,
  type VoicePeerState,
} from '@/lib/signal'

type ShareEntry = {
  stream: MediaStream
  state: 'connecting' | 'live'
}

type RemoteShare = {
  info: SlotInfo
  stream: MediaStream
}

type SidePanel = 'closed' | 'people' | 'chat' | 'settings'

const SIDE_MIN = 260
const SIDE_MAX = 560
const SIDE_DEFAULT = 320
const SIDE_WIDTH_KEY = 'watchdesk.hostSideWidth'

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

function ControlButton({
  label,
  active,
  danger,
  disabled,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex size-11 shrink-0 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-40',
        danger
          ? 'bg-destructive text-white hover:bg-destructive/90'
          : active
            ? 'bg-primary text-primary-foreground hover:bg-primary/90'
            : 'bg-muted text-foreground hover:bg-muted/80',
      )}
    >
      {children}
    </button>
  )
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
  const [screenAllowed, setScreenAllowed] = useState<Set<string>>(() => new Set())
  const [localShareCount, setLocalShareCount] = useState(0)
  const [remotes, setRemotes] = useState<Map<number, RemoteShare>>(() => new Map())
  const [linkCopied, setLinkCopied] = useState(false)
  const [side, setSide] = useState<SidePanel>('closed')
  const [sideWidth, setSideWidth] = useState(readSideWidth)

  const sideRef = useRef(side)
  sideRef.current = side
  const sideWidthRef = useRef(sideWidth)
  sideWidthRef.current = sideWidth
  const panelRef = useRef(false)
  const sharesRef = useRef(shares)
  sharesRef.current = shares
  panelRef.current = panel
  const rosterRef = useRef(roster)
  rosterRef.current = roster
  const selfPeerIdRef = useRef('')
  selfPeerIdRef.current = selfPeerId

  const iceRef = useRef<RTCIceServer[]>([{ urls: 'stun:stun.l.google.com:19302' }])
  const viewersRef = useRef(new Map<string, string>())
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

  const screenRef = useRef<ScreenShareSession | null>(null)
  if (!screenRef.current) {
    screenRef.current = new ScreenShareSession({
      send: (msg) => sendRef.current(msg),
      iceServers: () => iceRef.current,
      selfPeerId: () => selfPeerIdRef.current,
      memberIds: () => [...viewersRef.current.keys()],
      onRemoteStream: (info, stream) => ensureRemoteTile(info, stream),
      onRemoteSlotRemoved: (slot) => removeRemoteTile(slot),
    })
  }

  function ensureRemoteTile(info: SlotInfo, stream: MediaStream) {
    setRemotes((prev) => {
      const next = new Map(prev)
      next.set(info.slot, { info, stream })
      return next
    })
  }

  function removeRemoteTile(slot: number) {
    setRemotes((prev) => {
      if (!prev.has(slot)) return prev
      const next = new Map(prev)
      next.delete(slot)
      return next
    })
  }

  function clearRemoteTiles() {
    setRemotes(new Map())
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
      screenRef.current?.teardown()
      clearRemoteTiles()
      voiceRef.current?.teardown()
      setShares(new Map())
      setLocalShareCount(0)
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

  async function onSignal(msg: SignalInbound) {
    if (msg.type === 'welcome') {
      iceRef.current = msg.iceServers?.length ? msg.iceServers : iceRef.current
      setActive(msg.active)
      setMaxViewers(msg.maxViewers)
      setNewMax(msg.maxViewers)
      if (msg.joinMode) setJoinMode(msg.joinMode)
      setSelfPeerId(msg.peerId)
      selfPeerIdRef.current = msg.peerId
      voiceRef.current?.setSelfPeerId(msg.peerId)
      const ve = Boolean(msg.voiceEnabled)
      setVoiceEnabled(ve)
      setScreenAllowed(new Set(msg.screenAllowed || []))
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
      const slots = normalizeSlots(msg.slots, msg.peerId, msg.displayName)
      screenRef.current?.applySlots(slots)
      for (const peerId of viewersRef.current.keys()) {
        await screenRef.current?.onMemberJoined(peerId)
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
      await screenRef.current?.onMemberJoined(msg.peerId)
      return
    }
    if (msg.type === 'viewer_left') {
      viewersRef.current.delete(msg.peerId)
      setScreenAllowed((prev) => {
        const next = new Set(prev)
        next.delete(msg.peerId)
        return next
      })
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
    if (msg.type === 'slots') {
      const slots = normalizeSlots(msg.slots)
      screenRef.current?.applySlots(slots)
      setShares((prev) => {
        const next = new Map(prev)
        for (const slot of [...next.keys()]) {
          const info = slots.find((s) => s.slot === slot)
          if (!info || info.peerId !== selfPeerIdRef.current) next.delete(slot)
        }
        return next
      })
      setLocalShareCount(screenRef.current?.localSlotCount || 0)
      return
    }
    if (msg.type === 'offer') {
      await screenRef.current?.handleOffer(msg.from, msg.slot, msg.sdp)
      return
    }
    if (msg.type === 'answer') {
      await screenRef.current?.handleAnswer(msg.from, msg.slot, msg.sdp)
      const share = sharesRef.current.get(msg.slot)
      if (share && share.state !== 'live') {
        setShares((prev) => new Map(prev).set(msg.slot, { ...share, state: 'live' }))
      }
      return
    }
    if (msg.type === 'ice') {
      await screenRef.current?.handleIce(msg.from, msg.slot, msg.candidate)
      return
    }
    if (msg.type === 'screen_allowed') {
      setScreenAllowed(new Set(msg.peerIds))
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
    if (msg.type === 'roster') {
      setRoster(msg.members)
      const next = new Map(
        msg.members.filter((m) => m.role === 'viewer').map((m) => [m.peerId, m.displayName]),
      )
      for (const peerId of [...viewersRef.current.keys()]) {
        if (!next.has(peerId)) screenRef.current?.onMemberLeft(peerId)
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
      const slot = await screenRef.current!.publish(stream)
      setShares((prev) => new Map(prev).set(slot, { stream, state: 'live' }))
      setLocalShareCount(screenRef.current?.localSlotCount || 0)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') return
      action.fail(err instanceof Error ? err.message : 'Falha ao compartilhar.')
    }
  }

  function stopSlot(slot: number) {
    screenRef.current?.stopSlot(slot, true)
    setShares((prev) => {
      const next = new Map(prev)
      next.delete(slot)
      return next
    })
    setLocalShareCount(screenRef.current?.localSlotCount || 0)
  }

  function setViewerScreenAllow(peerId: string, allow: boolean) {
    sendRef.current({ type: 'screen_allow', peerId, allow })
  }

  function kickViewer(peerId: string) {
    sendRef.current({ type: 'kick', peerId })
    screenRef.current?.onMemberLeft(peerId)
    viewersRef.current.delete(peerId)
    setScreenAllowed((prev) => {
      const next = new Set(prev)
      next.delete(peerId)
      return next
    })
    setRoster((prev) => prev.filter((m) => m.peerId !== peerId))
  }

  async function logout() {
    screenRef.current?.teardown()
    clearRemoteTiles()
    setShares(new Map())
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
      for (const peerId of [...viewersRef.current.keys()]) {
        screenRef.current?.onMemberLeft(peerId)
      }
      viewersRef.current.clear()
      setScreenAllowed(new Set())
      clearRemoteTiles()
      setRoster((prev) => prev.filter((m) => m.role !== 'viewer'))
      setPending([])
    })
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setLinkCopied(true)
      toast.success('Link copiado')
      window.setTimeout(() => setLinkCopied(false), 1800)
    } catch {
      toast.error('Não foi possível copiar o link')
    }
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

  if (!panel) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-4 pb-20 sm:pb-0">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Transmitir — {room}</CardTitle>
            <CardDescription>
              {denied || 'Não foi possível abrir o painel nesta sala.'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button type="button" variant="outline" onClick={() => navigate('/salas')}>
              Voltar às salas
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const sorted = [...shares.entries()].sort((a, b) => a[0] - b[0])
  const remoteList = [...remotes.entries()].sort((a, b) => a[0] - b[0])
  const viewers = roster.filter((m) => m.role === 'viewer')
  const link = viewerInviteUrl(room)
  const hostName = profileName || displayName
  const selfSpeaking = speakingIds.includes(selfPeerId) && !voiceMuted
  const slotBudget = shares.size >= MAX_SLOTS
  const stageItems: StageItem[] = [
    ...sorted.map(([slot, entry]) => ({
      slot,
      label: `Você · Tela ${slot + 1}${entry.state !== 'live' ? ' · conectando…' : ''}`,
      stream: entry.stream,
      muted: true,
      onStop: () => stopSlot(slot),
    })),
    ...remoteList.map(([slot, entry]) => ({
      slot,
      label: entry.info.displayName || `Tela ${slot + 1}`,
      stream: entry.stream,
      muted: entry.stream.getAudioTracks().length === 0,
    })),
  ]
  const sideOpen = side !== 'closed'

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      {/* Top strip */}
      <header className="absolute inset-x-0 top-0 z-20 flex items-center gap-3 px-3 py-2.5 sm:px-4">
        <div className="min-w-0 rounded-md bg-background/80 px-2.5 py-1.5 backdrop-blur-sm">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-mono text-sm font-medium">{room}</h1>
            <span
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                active ? 'bg-primary' : 'bg-amber-500',
              )}
            />
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {active ? 'Ao vivo' : 'Pausada'}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {hostName} · {viewers.length}/{maxViewers}
            {localShareCount ? ` · ${localShareCount} tela(s)` : ''}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {pending.length ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="gap-1.5"
              onClick={() => setSide('people')}
            >
              <Users className="size-3.5" />
              {pending.length} pedido{pending.length > 1 ? 's' : ''}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="gap-1.5 bg-background/80 backdrop-blur-sm"
            onClick={() => void copy(link)}
          >
            {linkCopied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
            <span className="hidden sm:inline">{linkCopied ? 'Copiado' : 'Convite'}</span>
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Stage */}
        <div className="relative min-h-0 min-w-0 flex-1 bg-black">
          <div className="absolute inset-0 pt-14 pb-24 sm:pb-28">
            <StageBoard
              items={stageItems}
              empty={
                <div className="flex flex-col items-center justify-center gap-2 px-6 text-center">
                  <MonitorUp className="size-10 text-white/25" />
                  <p className="text-sm text-white/60">Nada no ar</p>
                  <p className="max-w-xs text-xs text-white/40">
                    Compartilhe a tela ou libere um espectador em Pessoas.
                  </p>
                </div>
              }
            />
          </div>

          {/* Bottom controls */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-3 pb-4 sm:pb-5">
            <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-card/95 px-2 py-2 shadow-lg backdrop-blur-sm sm:gap-2.5 sm:px-3">
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
              ) : (
                <ControlButton
                  label="Ligar voz"
                  disabled={action.busy}
                  onClick={() =>
                    void patchRoom(
                      { voiceEnabled: true },
                      { pending: 'Ativando…', success: 'Voz ligada' },
                    )
                  }
                >
                  <Mic className="size-5" />
                </ControlButton>
              )}

              <ControlButton
                label={localShareCount ? 'Compartilhar outra tela' : 'Compartilhar tela'}
                active={localShareCount > 0}
                disabled={slotBudget || action.busy}
                onClick={() => void shareScreen()}
              >
                <ScreenShare className="size-5" />
              </ControlButton>

              <ControlButton
                label="Pessoas"
                active={side === 'people'}
                onClick={() => toggleSide('people')}
              >
                <span className="relative">
                  <Users className="size-5" />
                  {pending.length ? (
                    <span className="absolute -top-1 -right-1 size-2 rounded-full bg-amber-500" />
                  ) : null}
                </span>
              </ControlButton>

              <ControlButton
                label="Mensagens"
                active={side === 'chat'}
                onClick={() => toggleSide('chat')}
              >
                <MessageSquare className="size-5" />
              </ControlButton>

              <ControlButton
                label="Sala"
                active={side === 'settings'}
                onClick={() => toggleSide('settings')}
              >
                <Settings2 className="size-5" />
              </ControlButton>

              <ControlButton label="Sair" danger onClick={() => void logout()}>
                <PhoneOff className="size-5" />
              </ControlButton>
            </div>
          </div>
        </div>

        {/* Side panel */}
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
                'absolute inset-y-0 right-0 w-full max-w-sm',
                'md:static md:max-w-none md:w-[var(--host-side-w)]',
              )}
              style={{ ['--host-side-w' as string]: `${sideWidth}px` }}
            >
              {/* Resize handle — desktop */}
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Redimensionar painel"
                onPointerDown={onSideResizePointerDown}
                className={cn(
                  'absolute inset-y-0 left-0 z-10 hidden w-2 cursor-col-resize touch-none md:block',
                  'after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-border',
                  'hover:after:bg-primary/50 active:after:bg-primary',
                )}
              >
                <div className="absolute top-1/2 left-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border" />
              </div>
              <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
                {(
                  [
                    ['people', 'Pessoas', Users],
                    ['chat', 'Chat', MessageSquare],
                    ['settings', 'Sala', Settings2],
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
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                    {joinMode === 'ask' && pending.length ? (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-muted-foreground">Pedidos</p>
                        {pending.map((p) => (
                          <div key={p.peerId} className="rounded-lg border border-border p-2.5">
                            <div className="mb-2 flex items-center gap-2">
                              <Avatar size="sm">
                                <AvatarFallback>{initials(p.displayName)}</AvatarFallback>
                              </Avatar>
                              <span className="truncate text-sm">{p.displayName}</span>
                            </div>
                            <div className="flex gap-1.5">
                              <Button
                                type="button"
                                size="sm"
                                className="h-7 flex-1"
                                onClick={() => admit(p.peerId, true)}
                              >
                                Aceitar
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 flex-1"
                                onClick={() => admit(p.peerId, false)}
                              >
                                Recusar
                              </Button>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}

                    <div className="space-y-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        Na sala · {viewers.length}/{maxViewers}
                      </p>
                      <ul className="space-y-0.5">
                        <li className="flex items-center gap-2.5 rounded-md px-1.5 py-2">
                          <Avatar size="sm">
                            <AvatarFallback>{initials(hostName)}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm">
                              {hostName}{' '}
                              <span className="text-muted-foreground">(você)</span>
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {voiceEnabled
                                ? voiceMuted
                                  ? 'Mudo'
                                  : selfSpeaking
                                    ? 'Falando'
                                    : 'Mic ligado'
                                : 'Host'}
                            </p>
                          </div>
                        </li>
                        {!viewers.length ? (
                          <li className="px-1.5 py-2 text-xs text-muted-foreground">
                            Ninguém na sala. Envie o convite.
                          </li>
                        ) : (
                          viewers.map((v) => {
                            const vs = voicePeers.find((p) => p.peerId === v.peerId)
                            const talking = speakingIds.includes(v.peerId)
                            const canScreen = screenAllowed.has(v.peerId)
                            return (
                              <li
                                key={v.peerId}
                                className="rounded-md px-1.5 py-2 hover:bg-muted/50"
                              >
                                <div className="flex items-center gap-2.5">
                                  <div className="relative shrink-0">
                                    <Avatar size="sm">
                                      <AvatarFallback>{initials(v.displayName)}</AvatarFallback>
                                    </Avatar>
                                    {talking && !vs?.muted ? (
                                      <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-emerald-500 ring-2 ring-card" />
                                    ) : null}
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm">{v.displayName}</p>
                                    <p className="truncate text-xs text-muted-foreground">
                                      {voiceEnabled
                                        ? vs?.forceMuted
                                          ? 'Mutado'
                                          : vs?.muted
                                            ? 'Mudo'
                                            : talking
                                              ? 'Falando'
                                              : 'Mic ligado'
                                        : canScreen
                                          ? 'Pode compartilhar'
                                          : 'Espectador'}
                                    </p>
                                  </div>
                                </div>
                                <div className="mt-1.5 flex flex-wrap gap-1 pl-9">
                                  {voiceEnabled ? (
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="h-7 gap-1 px-2 text-xs"
                                      onClick={() => hostMutePeer(v.peerId, !vs?.forceMuted)}
                                    >
                                      {vs?.forceMuted ? (
                                        <Mic className="size-3" />
                                      ) : (
                                        <MicOff className="size-3" />
                                      )}
                                      {vs?.forceMuted ? 'Liberar' : 'Mutar'}
                                    </Button>
                                  ) : null}
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1 px-2 text-xs"
                                    onClick={() => setViewerScreenAllow(v.peerId, !canScreen)}
                                  >
                                    {canScreen ? (
                                      <ScreenShareOff className="size-3" />
                                    ) : (
                                      <ScreenShare className="size-3" />
                                    )}
                                    {canScreen ? 'Revogar' : 'Tela'}
                                  </Button>
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
                                    onClick={() => kickViewer(v.peerId)}
                                  >
                                    <UserX className="size-3" />
                                    Remover
                                  </Button>
                                </div>
                              </li>
                            )
                          })
                        )}
                      </ul>
                      {viewers.length ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="mt-1 w-full text-destructive hover:text-destructive"
                          onClick={() => void kickAllViewers()}
                        >
                          Remover todos
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className="shrink-0 space-y-1.5 border-t border-border p-3">
                    <Label className="text-xs text-muted-foreground">Convite</Label>
                    <div className="flex gap-1.5">
                      <Input readOnly value={link} className="h-8 font-mono text-xs" />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0 px-2"
                        onClick={() => void copy(link)}
                      >
                        <Copy className="size-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ) : null}

              {side === 'chat' ? (
                <div className="min-h-0 flex-1">
                  <RoomChat
                    items={chatFeed}
                    selfName={hostName}
                    selfDeviceId={deviceId}
                    onSend={(body) => sendRef.current({ type: 'chat', body })}
                  />
                </div>
              ) : null}

              {side === 'settings' ? (
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Sala</p>
                    <div className="flex flex-col gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="justify-start"
                        disabled={action.busy}
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
                        className="justify-start"
                        disabled={action.busy}
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
                        className="justify-start"
                        disabled={action.busy}
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
                  </div>

                  <form
                    className="space-y-2"
                    onSubmit={(e: FormEvent) => {
                      e.preventDefault()
                      void patchRoom(
                        { maxViewers: newMax },
                        { pending: 'Salvando…', success: 'Limite atualizado' },
                      )
                    }}
                  >
                    <Label htmlFor="max" className="text-xs text-muted-foreground">
                      Máx. espectadores
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="max"
                        type="number"
                        min={1}
                        max={8}
                        value={newMax}
                        onChange={(e) => setNewMax(Number(e.target.value))}
                        className="h-8 w-20"
                      />
                      <Button type="submit" size="sm" variant="outline" disabled={action.busy}>
                        Salvar
                      </Button>
                    </div>
                  </form>

                  <div className="border-t border-border pt-3">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-start gap-2 text-muted-foreground"
                      onClick={() => void logout()}
                    >
                      <LogOut className="size-3.5" />
                      Sair do painel
                    </Button>
                  </div>
                </div>
              ) : null}
            </aside>
          </>
        ) : null}
      </div>
    </div>
  )
}
