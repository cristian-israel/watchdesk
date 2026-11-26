import type { SignalOutbound, SlotInfo } from '@/lib/signal'
import { peerKey } from '@/lib/signal'

export const MAX_SLOTS = 19

export type ScreenShareSend = (msg: SignalOutbound) => void

type PubLink = {
  pc: RTCPeerConnection
  peerId: string
  slot: number
}

type SubLink = {
  pc: RTCPeerConnection
  from: string
  slot: number
}

export type ScreenShareOptions = {
  send: ScreenShareSend
  iceServers: () => RTCIceServer[]
  selfPeerId: () => string
  /** Called when a remote slot stream arrives or updates. */
  onRemoteStream: (slot: SlotInfo, stream: MediaStream) => void
  /** Called when a remote slot should be removed from UI. */
  onRemoteSlotRemoved: (slot: number) => void
  /** Current admitted peer ids excluding self (for publishing offers). */
  memberIds: () => string[]
}

/**
 * Publish local screen slots to all members and subscribe to remote slots.
 */
export class ScreenShareSession {
  private pubs = new Map<string, PubLink>()
  private subs = new Map<string, SubLink>()
  private localShares = new Map<number, MediaStream>()
  private remoteSlots = new Map<number, SlotInfo>()
  private readonly opts: ScreenShareOptions

  constructor(opts: ScreenShareOptions) {
    this.opts = opts
  }

  get localSlotCount() {
    return this.localShares.size
  }

  getLocalSlots() {
    return [...this.localShares.keys()].sort((a, b) => a - b)
  }

  getLocalStream(slot: number) {
    return this.localShares.get(slot)
  }

  listLocalShares() {
    return this.getLocalSlots()
      .map((slot) => {
        const stream = this.localShares.get(slot)
        return stream ? { slot, stream } : null
      })
      .filter((x): x is { slot: number; stream: MediaStream } => Boolean(x))
  }

  async publish(stream: MediaStream) {
    const [track] = stream.getVideoTracks()
    if (track && 'contentHint' in track) track.contentHint = 'detail'

    for (let slot = 0; slot < MAX_SLOTS; slot++) {
      if (this.localShares.has(slot) || this.remoteSlots.has(slot)) continue
      this.localShares.set(slot, stream)
      this.opts.send({ type: 'slot_add', slot })
      track?.addEventListener('ended', () => this.stopSlot(slot))
      await this.offerSlotToAll(slot, stream)
      return slot
    }
    stream.getTracks().forEach((t) => t.stop())
    throw new Error('Limite de telas atingido.')
  }

  stopSlot(slot: number, notify = true) {
    const stream = this.localShares.get(slot)
    if (!stream) return
    this.localShares.delete(slot)
    if (notify) this.opts.send({ type: 'slot_remove', slot })
    for (const key of [...this.pubs.keys()]) {
      if (key.endsWith(`:${slot}`)) this.closePub(key)
    }
    stream.getTracks().forEach((t) => t.stop())
  }

  stopAllLocal(notify = true) {
    for (const slot of [...this.localShares.keys()]) this.stopSlot(slot, notify)
  }

  /** Apply authoritative slot list from server. */
  applySlots(slots: SlotInfo[]) {
    const self = this.opts.selfPeerId()
    const wanted = new Map(slots.map((s) => [s.slot, s]))

    for (const slot of [...this.remoteSlots.keys()]) {
      if (!wanted.has(slot)) {
        this.remoteSlots.delete(slot)
        this.closeSubsForSlot(slot)
        this.opts.onRemoteSlotRemoved(slot)
      }
    }

    for (const info of slots) {
      if (info.peerId === self) {
        this.remoteSlots.delete(info.slot)
        continue
      }
      const prev = this.remoteSlots.get(info.slot)
      this.remoteSlots.set(info.slot, info)
      if (!prev || prev.peerId !== info.peerId) {
        this.closeSubsForSlot(info.slot)
        // Wait for offer from publisher
      }
    }

    // Drop local shares that server no longer lists for us (revoked)
    for (const slot of [...this.localShares.keys()]) {
      const info = wanted.get(slot)
      if (!info || info.peerId !== self) {
        this.stopSlot(slot, false)
      }
    }
  }

  async onMemberJoined(peerId: string) {
    for (const [slot, stream] of this.localShares) {
      await this.ensurePub(peerId, slot, stream)
    }
  }

  onMemberLeft(peerId: string) {
    for (const key of [...this.pubs.keys()]) {
      if (key.startsWith(`${peerId}:`)) this.closePub(key)
    }
    for (const key of [...this.subs.keys()]) {
      if (key.startsWith(`${peerId}:`)) this.closeSub(key)
    }
  }

  async handleOffer(from: string, slot: number, sdp: string) {
    const self = this.opts.selfPeerId()
    if (from === self) return
    const info = this.remoteSlots.get(slot) || {
      slot,
      peerId: from,
      displayName: from,
    }
    this.remoteSlots.set(slot, { ...info, peerId: from })

    const pc = await this.ensureSub(from, slot, info)
    await pc.setRemoteDescription({ type: 'offer', sdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    this.opts.send({ type: 'answer', to: from, slot, sdp: answer.sdp || '' })
  }

  async handleAnswer(from: string, slot: number, sdp: string) {
    const link = this.pubs.get(peerKey(from, slot))
    if (!link) return
    if (!link.pc.currentRemoteDescription) {
      await link.pc.setRemoteDescription({ type: 'answer', sdp })
    }
  }

  async handleIce(from: string, slot: number, candidate: RTCIceCandidateInit | null) {
    if (!candidate) return
    const pub = this.pubs.get(peerKey(from, slot))
    if (pub) {
      try {
        await pub.pc.addIceCandidate(candidate)
      } catch {
        /* race */
      }
      return
    }
    const sub = this.subs.get(peerKey(from, slot))
    if (sub) {
      try {
        await sub.pc.addIceCandidate(candidate)
      } catch {
        /* race */
      }
    }
  }

  teardown() {
    this.stopAllLocal(false)
    for (const key of [...this.pubs.keys()]) this.closePub(key)
    for (const key of [...this.subs.keys()]) this.closeSub(key)
    this.remoteSlots.clear()
  }

  private async offerSlotToAll(slot: number, stream: MediaStream) {
    for (const peerId of this.opts.memberIds()) {
      await this.ensurePub(peerId, slot, stream)
    }
  }

  private async ensurePub(peerId: string, slot: number, stream: MediaStream) {
    const key = peerKey(peerId, slot)
    if (this.pubs.has(key)) return

    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers() })
    this.pubs.set(key, { pc, peerId, slot })
    stream.getTracks().forEach((t) => pc.addTrack(t, stream))

    pc.onicecandidate = (ev) => {
      this.opts.send({
        type: 'ice',
        to: peerId,
        slot,
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
      })
    }
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this.closePub(key)
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
      /* optional */
    }

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.opts.send({ type: 'offer', to: peerId, slot, sdp: offer.sdp || '' })
  }

  private async ensureSub(from: string, slot: number, info: SlotInfo) {
    const key = peerKey(from, slot)
    let link = this.subs.get(key)
    if (link) return link.pc

    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers() })
    this.subs.set(key, { pc, from, slot })

    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track])
      this.opts.onRemoteStream(info, stream)
    }
    pc.onicecandidate = (ev) => {
      this.opts.send({
        type: 'ice',
        to: from,
        slot,
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
      })
    }
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) this.closeSub(key)
    }
    return pc
  }

  private closePub(key: string) {
    const link = this.pubs.get(key)
    if (!link) return
    this.pubs.delete(key)
    try {
      link.pc.close()
    } catch {
      /* ok */
    }
  }

  private closeSub(key: string) {
    const link = this.subs.get(key)
    if (!link) return
    this.subs.delete(key)
    try {
      link.pc.close()
    } catch {
      /* ok */
    }
  }

  private closeSubsForSlot(slot: number) {
    for (const key of [...this.subs.keys()]) {
      if (key.endsWith(`:${slot}`)) this.closeSub(key)
    }
  }
}

/** Normalize legacy number[] or SlotInfo[] from server. */
export function normalizeSlots(
  raw: SlotInfo[] | number[] | undefined,
  fallbackPeerId = '',
  fallbackName = '',
): SlotInfo[] {
  if (!raw?.length) return []
  if (typeof raw[0] === 'number') {
    return (raw as number[]).map((slot) => ({
      slot,
      peerId: fallbackPeerId,
      displayName: fallbackName || 'Host',
    }))
  }
  return raw as SlotInfo[]
}
