export type ChatMessage = {
  id: number
  authorName: string
  authorDeviceId?: string
  role: 'host' | 'viewer'
  body: string
  createdAt: string
}

export type RosterMember = {
  peerId: string
  role: 'host' | 'viewer'
  displayName: string
  deviceId?: string
}

export type PendingMember = {
  peerId: string
  displayName: string
}

export type JoinMode = 'open' | 'ask'

export type VoicePeerState = {
  peerId: string
  muted: boolean
  forceMuted: boolean
}

export type SlotInfo = {
  slot: number
  peerId: string
  displayName: string
}

export type SignalInbound =
  | {
      type: 'welcome'
      peerId: string
      role: 'host' | 'viewer'
      room: string
      displayName: string
      slots: SlotInfo[] | number[]
      viewers?: { peerId: string; displayName: string }[]
      pending?: PendingMember[]
      iceServers: RTCIceServer[]
      maxViewers: number
      active: boolean
      joinMode?: JoinMode
      voiceEnabled?: boolean
      expiresAt?: string | null
      voiceState?: VoicePeerState[]
      screenAllowed?: string[]
      canShareScreen?: boolean
      admitStatus?: 'pending' | 'admitted'
    }
  | { type: 'error'; message: string }
  | { type: 'viewer_joined'; peerId: string; displayName: string }
  | { type: 'viewer_left'; peerId: string; displayName?: string }
  | { type: 'host_joined'; peerId: string; displayName: string }
  | { type: 'host_left' }
  | { type: 'slots'; slots: SlotInfo[] | number[] }
  | { type: 'offer'; from: string; slot: number; sdp: string }
  | { type: 'answer'; from: string; slot: number; sdp: string }
  | { type: 'ice'; from: string; slot: number; candidate: RTCIceCandidateInit | null }
  | { type: 'voice_offer'; from: string; sdp: string }
  | { type: 'voice_answer'; from: string; sdp: string }
  | { type: 'voice_ice'; from: string; candidate: RTCIceCandidateInit | null }
  | { type: 'voice_state'; peers: VoicePeerState[] }
  | { type: 'screen_allow'; allow: boolean; canShareScreen: boolean }
  | { type: 'screen_allowed'; peerIds: string[] }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'chat_history'; messages: ChatMessage[] }
  | { type: 'roster'; members: RosterMember[] }
  | { type: 'auth_changed'; message: string }
  | { type: 'role_changed'; role: 'host' | 'viewer'; message?: string }
  | {
      type: 'room_updated'
      active: boolean
      maxViewers: number
      joinMode?: JoinMode
      voiceEnabled?: boolean
      expiresAt?: string | null
    }
  | { type: 'admit_request'; peerId: string; displayName: string }
  | { type: 'admit_result'; accepted: boolean; message?: string; slots?: SlotInfo[] | number[] }
  | { type: 'pending'; pending: PendingMember[] }

export type SignalOutbound =
  | { type: 'hello' }
  | { type: 'slot_add'; slot: number }
  | { type: 'slot_remove'; slot: number }
  | { type: 'offer'; to: string; slot: number; sdp: string }
  | { type: 'answer'; to: string; slot: number; sdp: string }
  | { type: 'ice'; to: string; slot: number; candidate: RTCIceCandidateInit | null }
  | { type: 'voice_offer'; to: string; sdp: string }
  | { type: 'voice_answer'; to: string; sdp: string }
  | { type: 'voice_ice'; to: string; candidate: RTCIceCandidateInit | null }
  | { type: 'self_mute'; muted: boolean }
  | { type: 'voice_mute'; peerId: string; muted: boolean }
  | { type: 'screen_allow'; peerId: string; allow: boolean }
  | { type: 'kick'; peerId: string }
  | { type: 'chat'; body: string }
  | { type: 'admit'; peerId: string; accept: boolean }

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/api/ws`
}

export class SignalClient {
  private ws: WebSocket | null = null
  private closed = false
  onMessage: ((msg: SignalInbound) => void) | null = null
  onClose: (() => void) | null = null

  connect(hello: Extract<SignalOutbound, { type: 'hello' }> = { type: 'hello' }) {
    this.closed = false
    const ws = new WebSocket(wsUrl())
    this.ws = ws
    ws.onopen = () => this.send(hello)
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as SignalInbound
        this.onMessage?.(msg)
      } catch {
        /* ignore */
      }
    }
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null
      if (!this.closed) this.onClose?.()
    }
  }

  send(msg: SignalOutbound) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
    }
  }

  close() {
    this.closed = true
    try {
      this.ws?.close()
    } catch {
      /* ok */
    }
    this.ws = null
  }
}

export function peerKey(peerId: string, slot: number) {
  return `${peerId}:${slot}`
}
