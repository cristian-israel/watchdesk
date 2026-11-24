export type ChatMessage = {
  id: number
  authorName: string
  authorDeviceId?: string
  role: 'host' | 'viewer'
  body: string
  createdAt: string
}

export type ControlMode = 'view' | 'interact'

export type RosterMember = {
  peerId: string
  role: 'host' | 'viewer'
  displayName: string
  controlMode?: ControlMode
  clientKind?: 'web' | 'companion'
}

export type SignalInbound =
  | {
      type: 'welcome'
      peerId: string
      role: 'host' | 'viewer'
      room: string
      displayName: string
      slots: number[]
      viewers?: { peerId: string; displayName: string; controlMode?: ControlMode }[]
      iceServers: RTCIceServer[]
      maxViewers: number
      active: boolean
      controlMode?: ControlMode
      pilotPeerId?: string | null
      transmitMode?: 'web' | 'companion'
      companion?: {
        version: string
        minVersion: string
        downloadUrl: string
        downloadUrlLinux?: string
        notes?: string
        mandatory?: boolean
      }
    }
  | { type: 'error'; message: string }
  | { type: 'viewer_joined'; peerId: string; displayName: string; controlMode?: ControlMode }
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
  | { type: 'control_changed'; peerId: string; mode: ControlMode; displayName: string }

export type SignalOutbound =
  | { type: 'hello'; clientKind?: 'web' | 'companion'; version?: string }
  | { type: 'slot_add'; slot: number }
  | { type: 'slot_remove'; slot: number }
  | { type: 'offer'; to: string; slot: number; sdp: string }
  | { type: 'answer'; to: string; slot: number; sdp: string }
  | { type: 'ice'; to: string; slot: number; candidate: RTCIceCandidateInit | null }
  | { type: 'chat'; body: string }
  | { type: 'set_control'; peerId: string; mode: ControlMode }

/** Eventos de input no DataChannel (viewer → companion). Coords 0–1. */
export type RemoteInputEvent =
  | { type: 'move'; x: number; y: number }
  | { type: 'down'; x: number; y: number; button: number }
  | { type: 'up'; x: number; y: number; button: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { type: 'keydown'; key: string; code: string }
  | { type: 'keyup'; key: string; code: string }

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
