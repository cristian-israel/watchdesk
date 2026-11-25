import type { SignalOutbound, VoicePeerState } from '@/lib/signal'

export type VoiceMeshSend = (msg: SignalOutbound) => void

export type VoiceMeshOptions = {
  send: VoiceMeshSend
  iceServers: () => RTCIceServer[]
  onLocalMuteChange?: (muted: boolean, forceMuted: boolean) => void
  onPeersChange?: (peers: VoicePeerState[]) => void
}

/**
 * Mesh P2P de áudio. O peer com peerId lexicograficamente menor cria o offer.
 */
export class VoiceMesh {
  private selfPeerId = ''
  private enabled = false
  private localStream: MediaStream | null = null
  private muted = true
  private forceMuted = false
  private peers = new Map<
    string,
    { pc: RTCPeerConnection; audio: HTMLAudioElement }
  >()
  private memberIds = new Set<string>()
  private readonly opts: VoiceMeshOptions

  constructor(opts: VoiceMeshOptions) {
    this.opts = opts
  }

  get isMuted() {
    return this.muted
  }

  get isForceMuted() {
    return this.forceMuted
  }

  get isEnabled() {
    return this.enabled
  }

  setSelfPeerId(peerId: string) {
    this.selfPeerId = peerId
  }

  setIceServers(_servers: RTCIceServer[]) {
    /* ice lido via opts.iceServers() a cada novo PC */
  }

  async setEnabled(enabled: boolean) {
    if (this.enabled === enabled) {
      if (enabled) await this.syncPeers()
      return
    }
    this.enabled = enabled
    if (!enabled) {
      this.teardownMedia()
      this.closeAllPeers()
      this.muted = true
      this.forceMuted = false
      this.opts.onLocalMuteChange?.(true, false)
      return
    }
    await this.ensureLocalStream()
    await this.syncPeers()
  }

  setMembers(peerIds: string[]) {
    this.memberIds = new Set(peerIds.filter((id) => id && id !== this.selfPeerId))
    if (this.enabled) void this.syncPeers()
  }

  applyVoiceState(peers: VoicePeerState[]) {
    this.opts.onPeersChange?.(peers)
    const self = peers.find((p) => p.peerId === this.selfPeerId)
    if (self) {
      this.forceMuted = self.forceMuted
      this.muted = self.forceMuted ? true : self.muted
      this.applyLocalTrackEnabled()
      this.opts.onLocalMuteChange?.(this.muted, this.forceMuted)
    }
  }

  async setMuted(muted: boolean) {
    if (!this.enabled) return
    if (this.forceMuted && !muted) return
    await this.ensureLocalStream()
    this.muted = muted
    this.applyLocalTrackEnabled()
    this.opts.send({ type: 'self_mute', muted })
    this.opts.onLocalMuteChange?.(this.muted, this.forceMuted)
  }

  async handleOffer(from: string, sdp: string) {
    if (!this.enabled || !this.selfPeerId) return
    const pc = await this.ensurePeer(from, false)
    await pc.setRemoteDescription({ type: 'offer', sdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    this.opts.send({ type: 'voice_answer', to: from, sdp: answer.sdp || '' })
  }

  async handleAnswer(from: string, sdp: string) {
    const link = this.peers.get(from)
    if (!link) return
    if (!link.pc.currentRemoteDescription) {
      await link.pc.setRemoteDescription({ type: 'answer', sdp })
    }
  }

  async handleIce(from: string, candidate: RTCIceCandidateInit | null) {
    const link = this.peers.get(from)
    if (!link || !candidate) return
    try {
      await link.pc.addIceCandidate(candidate)
    } catch {
      /* race */
    }
  }

  teardown() {
    this.enabled = false
    this.teardownMedia()
    this.closeAllPeers()
    this.memberIds.clear()
    this.selfPeerId = ''
    this.muted = true
    this.forceMuted = false
  }

  private applyLocalTrackEnabled() {
    const track = this.localStream?.getAudioTracks()[0]
    if (track) track.enabled = !this.muted && !this.forceMuted
  }

  private async ensureLocalStream() {
    if (this.localStream) return this.localStream
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Este endereço não permite microfone. Use localhost ou HTTPS.')
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    })
    const track = stream.getAudioTracks()[0]
    if (track) track.enabled = false
    this.localStream = stream
    this.applyLocalTrackEnabled()
    for (const { pc } of this.peers.values()) {
      for (const t of stream.getTracks()) {
        if (!pc.getSenders().some((s) => s.track === t)) {
          pc.addTrack(t, stream)
        }
      }
    }
    return stream
  }

  private teardownMedia() {
    if (!this.localStream) return
    for (const t of this.localStream.getTracks()) t.stop()
    this.localStream = null
  }

  private closeAllPeers() {
    for (const peerId of [...this.peers.keys()]) this.closePeer(peerId)
  }

  private closePeer(peerId: string) {
    const link = this.peers.get(peerId)
    if (!link) return
    this.peers.delete(peerId)
    try {
      link.pc.close()
    } catch {
      /* ok */
    }
    link.audio.pause()
    link.audio.srcObject = null
    link.audio.remove()
  }

  private async syncPeers() {
    if (!this.enabled || !this.selfPeerId) return
    for (const peerId of [...this.peers.keys()]) {
      if (!this.memberIds.has(peerId)) this.closePeer(peerId)
    }
    for (const peerId of this.memberIds) {
      const shouldOffer = this.selfPeerId < peerId
      await this.ensurePeer(peerId, shouldOffer)
    }
  }

  private async ensurePeer(peerId: string, createOffer: boolean) {
    let link = this.peers.get(peerId)
    if (link) return link.pc

    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers() })
    const audio = document.createElement('audio')
    audio.autoplay = true
    audio.setAttribute('playsinline', 'true')
    document.body.appendChild(audio)

    this.peers.set(peerId, { pc, audio })

    if (this.localStream) {
      for (const t of this.localStream.getTracks()) {
        pc.addTrack(t, this.localStream)
      }
    } else if (this.enabled) {
      try {
        const stream = await this.ensureLocalStream()
        for (const t of stream.getTracks()) {
          pc.addTrack(t, stream)
        }
      } catch {
        /* mic permission — ainda recebe áudio remoto */
      }
    }

    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track])
      audio.srcObject = stream
      void audio.play().catch(() => {
        /* autoplay */
      })
    }
    pc.onicecandidate = (ev) => {
      this.opts.send({
        type: 'voice_ice',
        to: peerId,
        candidate: ev.candidate ? ev.candidate.toJSON() : null,
      })
    }
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) {
        this.closePeer(peerId)
      }
    }

    if (createOffer) {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.opts.send({ type: 'voice_offer', to: peerId, sdp: offer.sdp || '' })
    }

    return pc
  }
}
