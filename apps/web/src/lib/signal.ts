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
}

export type SignalInbound =
  | {
      type: 'welcome'
      peerId: string
      role: 'host' | 'viewer'
      room: string
      displayName: string
      slots: number[]
      viewers?: { peerId: string; displayName: string }[]
      iceServers: RTCIceServer[]
      maxViewers: number
      active: boolean
    }
  | { type: 'error'; message: string }
  | { type: 'viewer_joined'; peerId: string; displayName: string }
  | { type: 'viewer_left'; peerId: string; displayName?: string }
  | { type: 'host_joined'; peerId: string; displayName: string }
  | { type: 'host_left' }
  | { type: 'slots'; slots: number[] }
  | { type: 'offer'; from: string; slot: number; sdp: string }
  | { type: 'answer'; from: string; slot: number; sdp: string }
  | { type: 'ice'; from: string; slot: number; candidate: RTCIceCandidateInit | null }
  | { type: 'chat'; message: ChatMessage }
  | { type: 'chat_history'; messages: ChatMessage[] }
  | { type: 'roster'; members: RosterMember[] }
  | { type: 'auth_changed'; message: string }
  | { type: 'room_updated'; active: boolean; maxViewers: number }

export type SignalOutbound =
  | { type: 'hello' }
  | { type: 'slot_add'; slot: number }
  | { type: 'slot_remove'; slot: number }
  | { type: 'offer'; to: string; slot: number; sdp: string }
  | { type: 'answer'; to: string; slot: number; sdp: string }
  | { type: 'ice'; to: string; slot: number; candidate: RTCIceCandidateInit | null }
  | { type: 'chat'; body: string }

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
