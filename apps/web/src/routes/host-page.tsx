import { FormEvent, useEffect, useRef, useState } from 'react'
import {
  Check,
  Copy,
  Link2,
  LogOut,
  Mic,
  MicOff,
  MonitorUp,
  PanelRightClose,
  PanelRightOpen,
  ScreenShare,
  ScreenShareOff,
  Settings2,
  Users,
} from 'lucide-react'
import { usePanelRef } from 'react-resizable-panels'
import { toast } from 'sonner'
import { useNavigate, useParams } from 'react-router'
import { useActionDialog } from '@/actions/action-dialog'
import { RoomChat } from '@/components/room-chat'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
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

type RemoteTile = {
  info: SlotInfo
  video: HTMLVideoElement
  tile: HTMLDivElement
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0] || ''}${parts[1]![0] || ''}`.toUpperCase()
}

function Pill({
  children,
  tone = 'muted',
}: {
  children: import('react').ReactNode
  tone?: 'muted' | 'success' | 'warning' | 'live'
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'muted' && 'bg-muted text-muted-foreground',
        tone === 'success' && 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
        tone === 'warning' && 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
        tone === 'live' && 'bg-primary/15 text-primary',
      )}
    >
      {tone === 'live' ? <span className="size-1.5 animate-pulse rounded-full bg-primary" /> : null}
      {children}
    </span>
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
  const [remoteShareCount, setRemoteShareCount] = useState(0)
  const [linkCopied, setLinkCopied] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [chatMinimized, setChatMinimized] = useState(false)
  const chatPanelRef = usePanelRef()
  const chatPersistTimer = useRef<number | undefined>(undefined)

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
  const remoteGridRef = useRef<HTMLDivElement>(null)
  const remoteTilesRef = useRef(new Map<number, RemoteTile>())
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
    const grid = remoteGridRef.current
    if (!grid) return
    let entry = remoteTilesRef.current.get(info.slot)
    if (!entry) {
      const tile = document.createElement('div')
      tile.className =
        'relative overflow-hidden rounded-xl border border-border bg-black ring-1 ring-foreground/10'
      tile.innerHTML =
        '<video autoplay playsinline class="block aspect-video w-full bg-black object-contain"></video>' +
        '<span class="tag absolute left-2.5 top-2.5 rounded-full bg-black/65 px-2 py-0.5 text-xs text-white"></span>'
      const video = tile.querySelector('video') as HTMLVideoElement
      grid.appendChild(tile)
      entry = { info, video, tile }
      remoteTilesRef.current.set(info.slot, entry)
      setRemoteShareCount(remoteTilesRef.current.size)
    }
    entry.info = info
    const tag = entry.tile.querySelector('.tag') as HTMLElement
    tag.textContent = info.displayName || `Tela ${info.slot + 1}`
    entry.video.srcObject = stream
    if (stream.getAudioTracks().length) entry.video.muted = false
    else entry.video.muted = true
    void entry.video.play().catch(() => {
      /* autoplay */
    })
  }

  function removeRemoteTile(slot: number) {
    const entry = remoteTilesRef.current.get(slot)
    if (!entry) return
    remoteTilesRef.current.delete(slot)
    entry.tile.remove()
    setRemoteShareCount(remoteTilesRef.current.size)
  }

  function clearRemoteTiles() {
    for (const slot of [...remoteTilesRef.current.keys()]) removeRemoteTile(slot)
    setRemoteShareCount(0)
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
      // Drop local share UI entries removed by server
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
  const viewers = roster.filter((m) => m.role === 'viewer')
  const link = viewerInviteUrl(room)
  const hostName = profileName || displayName
  const selfSpeaking = speakingIds.includes(selfPeerId) && !voiceMuted
  const slotBudget = shares.size >= MAX_SLOTS

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-card px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate font-mono text-sm font-semibold tracking-tight">{room}</h1>
            <Pill tone={active ? 'live' : 'warning'}>{active ? 'Ao vivo' : 'Pausada'}</Pill>
            <Pill>{joinMode === 'open' ? 'Pública' : 'Com aceite'}</Pill>
            {voiceEnabled ? <Pill tone="success">Voz</Pill> : null}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {hostName} · {viewers.length}/{maxViewers}
            {localShareCount ? ` · ${localShareCount} tela(s)` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copy(link)}
            className="gap-1.5"
          >
            {linkCopied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
            {linkCopied ? 'Copiado' : 'Convite'}
          </Button>
          <Button
            type="button"
            variant={showSettings ? 'default' : 'outline'}
            size="sm"
            onClick={() => setShowSettings((v) => !v)}
            className="gap-1.5"
          >
            <Settings2 className="size-3.5" />
            Sala
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void logout()}>
            <LogOut className="size-3.5" />
          </Button>
        </div>
      </header>

      {showSettings ? (
        <div className="shrink-0 border-b border-border bg-muted/30 px-3 py-2.5">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
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
                {active ? 'Desativar' : 'Reativar'}
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
                      success: joinMode === 'ask' ? 'Sala pública' : 'Entrada com aceite',
                    },
                  )
                }
              >
                {joinMode === 'ask' ? 'Pública' : 'Com aceite'}
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
                <Label htmlFor="max" className="text-xs">
                  Máx.
                </Label>
                <Input
                  id="max"
                  type="number"
                  min={1}
                  max={8}
                  value={newMax}
                  onChange={(e) => setNewMax(Number(e.target.value))}
                  className="h-8 w-16"
                />
              </div>
              <Button type="submit" size="sm" variant="outline">
                Salvar
              </Button>
            </form>
          </div>
        </div>
      ) : null}

      {/* IDE: Stage | People | Chat — painéis sempre montados; resize sem setState no drag */}
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup orientation="horizontal" className="h-full min-h-0">
          <ResizablePanel id="host-stage" defaultSize="55%" minSize="28%" className="min-h-0">
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/20 px-3 py-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={slotBudget || action.busy}
                  onClick={() => void shareScreen()}
                  className="gap-1.5"
                >
                  <MonitorUp className="size-3.5" />
                  Compartilhar
                </Button>
                {voiceEnabled ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={voiceMuted ? 'outline' : 'default'}
                    disabled={voiceForceMuted || action.busy}
                    onClick={() => void toggleSelfMute()}
                    className="gap-1.5"
                  >
                    {voiceMuted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
                    {voiceForceMuted
                      ? 'Bloqueado'
                      : voiceMuted
                        ? 'Mic'
                        : selfSpeaking
                          ? 'Falando'
                          : 'Mutar'}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void patchRoom(
                        { voiceEnabled: true },
                        { pending: 'Ativando…', success: 'Voz ligada' },
                      )
                    }
                    className="gap-1.5"
                  >
                    <Mic className="size-3.5" />
                    Ligar voz
                  </Button>
                )}
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                {sorted.length ? (
                  <ul className="flex flex-col gap-2">
                    {sorted.map(([slot, e]) => (
                      <li
                        key={slot}
                        className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                            <MonitorUp className="size-4" />
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">Tela {slot + 1}</p>
                            <p className="text-xs text-muted-foreground">
                              {e.state === 'live' ? 'No ar' : 'Conectando…'} · você
                            </p>
                          </div>
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={() => stopSlot(slot)}>
                          Parar
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div
                  ref={remoteGridRef}
                  className="grid content-start gap-3 empty:hidden [grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))]"
                />

                {!sorted.length && !remoteShareCount ? (
                  <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border bg-muted/15 px-6 text-center">
                    <ScreenShare className="size-8 text-muted-foreground/70" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Palco vazio</p>
                      <p className="max-w-sm text-xs text-muted-foreground">
                        Compartilhe uma tela ou libere um espectador na coluna Pessoas.
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel
            id="host-people"
            defaultSize="20%"
            minSize="14%"
            maxSize="36%"
            className="min-h-0"
          >
            <aside className="flex h-full min-h-0 flex-col border-l border-border bg-card">
              <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
                <div className="flex items-center gap-2">
                  <Users className="size-3.5 text-muted-foreground" />
                  <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Pessoas
                  </span>
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {viewers.length}/{maxViewers}
                </span>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
                {joinMode === 'ask' && pending.length ? (
                  <div className="space-y-1.5">
                    <p className="px-1 text-[10px] font-semibold tracking-wide text-amber-600 uppercase dark:text-amber-400">
                      Pedidos
                    </p>
                    {pending.map((p) => (
                      <div key={p.peerId} className="rounded-lg border border-border p-2">
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

                <ul className="space-y-0.5">
                  <li className="flex items-center gap-2 rounded-md px-1.5 py-1.5">
                    <Avatar size="sm">
                      <AvatarFallback>{initials(hostName)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm">
                        {hostName}{' '}
                        <span className="text-muted-foreground">(você)</span>
                      </p>
                      <p className="text-[11px] text-muted-foreground">
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
                      Sala vazia — envie o convite.
                    </li>
                  ) : (
                    viewers.map((v) => {
                      const vs = voicePeers.find((p) => p.peerId === v.peerId)
                      const talking = speakingIds.includes(v.peerId)
                      const canScreen = screenAllowed.has(v.peerId)
                      return (
                        <li key={v.peerId} className="rounded-md px-1.5 py-1.5 hover:bg-muted/60">
                          <div className="flex items-center gap-2">
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
                              <p className="truncate text-[11px] text-muted-foreground">
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
                          <div className="mt-1.5 flex flex-wrap gap-1 pl-7">
                            {voiceEnabled ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-6 gap-1 px-1.5 text-[11px]"
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
                              className="h-6 gap-1 px-1.5 text-[11px]"
                              onClick={() => setViewerScreenAllow(v.peerId, !canScreen)}
                            >
                              {canScreen ? (
                                <ScreenShareOff className="size-3" />
                              ) : (
                                <ScreenShare className="size-3" />
                              )}
                              {canScreen ? 'Revogar' : 'Tela'}
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
                    className="h-7 w-full text-xs text-destructive hover:text-destructive"
                    onClick={() => void kickAllViewers()}
                  >
                    Remover todos
                  </Button>
                ) : null}
              </div>

              <div className="shrink-0 space-y-1.5 border-t border-border p-2">
                <Label className="text-[10px] text-muted-foreground">Convite</Label>
                <div className="flex gap-1.5">
                  <Input readOnly value={link} className="h-7 font-mono text-[10px]" />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 px-2"
                    onClick={() => void copy(link)}
                  >
                    <Copy className="size-3" />
                  </Button>
                </div>
              </div>
            </aside>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel
            id="host-chat"
            panelRef={chatPanelRef}
            defaultSize="25%"
            minSize="16%"
            maxSize="42%"
            collapsible
            collapsedSize={44}
            collapsedThreshold={24}
            className="min-h-0"
            onResize={() => {
              const collapsed = chatPanelRef.current?.isCollapsed() ?? false
              if (chatPersistTimer.current) window.clearTimeout(chatPersistTimer.current)
              chatPersistTimer.current = window.setTimeout(() => {
                setChatMinimized(collapsed)
              }, 100)
            }}
          >
            {chatMinimized ? (
              <div className="flex h-full flex-col items-center border-l border-border bg-card py-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label="Abrir chat"
                  onClick={() => {
                    setChatMinimized(false)
                    chatPanelRef.current?.expand()
                  }}
                >
                  <PanelRightOpen className="size-4" />
                </Button>
              </div>
            ) : (
              <div className="flex h-full min-h-0 flex-col border-l border-border bg-card/50">
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
                  <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Mensagens
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Minimizar chat"
                    onClick={() => {
                      setChatMinimized(true)
                      chatPanelRef.current?.collapse()
                    }}
                  >
                    <PanelRightClose className="size-3.5" />
                  </Button>
                </div>
                <div className="min-h-0 flex-1">
                  <RoomChat
                    items={chatFeed}
                    selfName={hostName}
                    selfDeviceId={deviceId}
                    onSend={(body) => sendRef.current({ type: 'chat', body })}
                  />
                </div>
              </div>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  )
}
