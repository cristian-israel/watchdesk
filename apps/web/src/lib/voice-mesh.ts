import { readAudioInputId, readAudioOutputId } from '@/lib/media-devices'
import type { SignalOutbound, VoicePeerState } from '@/lib/signal'
import { isSpeaking, rmsFromTimeDomain } from '@/lib/speaking'

export type VoiceMeshSend = (msg: SignalOutbound) => void

export type VoiceMeshOptions = {
  send: VoiceMeshSend
  iceServers: () => RTCIceServer[]
  onLocalMuteChange?: (muted: boolean, forceMuted: boolean) => void
  onPeersChange?: (peers: VoicePeerState[]) => void
  onSpeakingChange?: (speakingPeerIds: string[]) => void
}

type PeerLink = {
  pc: RTCPeerConnection
  audio: HTMLAudioElement
  analyser: AnalyserNode | null
  source: MediaStreamAudioSourceNode | null
  lastSpokeAt: number
  speaking: boolean
}

type LocalAnalyser = {
  analyser: AnalyserNode
  source: MediaStreamAudioSourceNode
  lastSpokeAt: number
  speaking: boolean
}

const POLL_MS = 80

/** True se a instância tem API atual (evita ref velha após HMR). */
export function voiceMeshSupportsDevices(voice: unknown): boolean {
  return Boolean(
    voice &&
      typeof voice === 'object' &&
      typeof (voice as VoiceMesh).setInputDevice === 'function',
  )
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
  private peers = new Map<string, PeerLink>()
  private memberIds = new Set<string>()
  private audioCtx: AudioContext | null = null
  private localAnalyser: LocalAnalyser | null = null
  private pollTimer: number | undefined
  private lastSpeakingKey = ''
  private inputDeviceId = ''
  private outputDeviceId = ''
  private readonly opts: VoiceMeshOptions
  private readonly levelBuf = new Uint8Array(256)

  constructor(opts: VoiceMeshOptions) {
    this.opts = opts
    this.inputDeviceId = readAudioInputId()
    this.outputDeviceId = readAudioOutputId()
  }

  getInputDeviceId() {
    return this.inputDeviceId
  }

  getOutputDeviceId() {
    return this.outputDeviceId
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
      this.stopSpeakingPoll()
      this.teardownMedia()
      this.closeAllPeers()
      this.muted = true
      this.forceMuted = false
      this.emitSpeaking([])
      this.opts.onLocalMuteChange?.(true, false)
      return
    }
    await this.ensureLocalStream()
    await this.syncPeers()
    this.startSpeakingPoll()
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

  /** Re-tenta play dos áudios remotos após gesto do usuário. */
  resumePlayback() {
    for (const { audio } of this.peers.values()) {
      void audio.play().catch(() => {
        /* autoplay */
      })
    }
    void this.audioCtx?.resume().catch(() => {
      /* ok */
    })
  }

  /** Preferência de mic; se a voz já estiver ligada, troca a track ao vivo. */
  async setInputDevice(deviceId: string) {
    const next = deviceId || ''
    if (this.inputDeviceId === next && this.localStream) return
    this.inputDeviceId = next
    if (!this.enabled) return
    await this.replaceLocalStream()
  }

  /** Preferência de saída; aplica setSinkId em todos os áudios remotos. */
  async setOutputDevice(deviceId: string) {
    this.outputDeviceId = deviceId || ''
    await this.applyOutputSinkToAll()
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
    this.stopSpeakingPoll()
    this.teardownMedia()
    this.closeAllPeers()
    this.memberIds.clear()
    this.selfPeerId = ''
    this.muted = true
    this.forceMuted = false
    this.emitSpeaking([])
  }

  private emitSpeaking(ids: string[]) {
    const key = ids.slice().sort().join(',')
    if (key === this.lastSpeakingKey) return
    this.lastSpeakingKey = key
    this.opts.onSpeakingChange?.(ids)
  }

  private ensureAudioCtx() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext()
    }
    return this.audioCtx
  }

  private attachLocalAnalyser(stream: MediaStream) {
    this.detachLocalAnalyser()
    try {
      const ctx = this.ensureAudioCtx()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.5
      source.connect(analyser)
      this.localAnalyser = { analyser, source, lastSpokeAt: 0, speaking: false }
    } catch {
      this.localAnalyser = null
    }
  }

  private detachLocalAnalyser() {
    if (!this.localAnalyser) return
    try {
      this.localAnalyser.source.disconnect()
    } catch {
      /* ok */
    }
    this.localAnalyser = null
  }

  private attachRemoteAnalyser(link: PeerLink, stream: MediaStream) {
    this.detachRemoteAnalyser(link)
    if (!stream.getAudioTracks().length) return
    try {
      const ctx = this.ensureAudioCtx()
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.5
      source.connect(analyser)
      link.source = source
      link.analyser = analyser
    } catch {
      link.source = null
      link.analyser = null
    }
  }

  private detachRemoteAnalyser(link: PeerLink) {
    if (link.source) {
      try {
        link.source.disconnect()
      } catch {
        /* ok */
      }
    }
    link.source = null
    link.analyser = null
    link.speaking = false
    link.lastSpokeAt = 0
  }

  private startSpeakingPoll() {
    this.stopSpeakingPoll()
    this.pollTimer = window.setInterval(() => this.pollSpeaking(), POLL_MS)
  }

  private stopSpeakingPoll() {
    if (this.pollTimer !== undefined) {
      window.clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  private readRms(analyser: AnalyserNode) {
    analyser.getByteTimeDomainData(this.levelBuf)
    return rmsFromTimeDomain(this.levelBuf)
  }

  private pollSpeaking() {
    if (!this.enabled) return
    const now = Date.now()
    const speaking: string[] = []

    const local = this.localAnalyser
    if (local && !this.muted && !this.forceMuted && this.selfPeerId) {
      const rms = this.readRms(local.analyser)
      const next = isSpeaking(rms, local.speaking, local.lastSpokeAt, now)
      if (next) local.lastSpokeAt = now
      local.speaking = next
      if (next) speaking.push(this.selfPeerId)
    } else if (local) {
      local.speaking = false
    }

    for (const [peerId, link] of this.peers) {
      if (!link.analyser) continue
      const rms = this.readRms(link.analyser)
      const next = isSpeaking(rms, link.speaking, link.lastSpokeAt, now)
      if (next) link.lastSpokeAt = now
      link.speaking = next
      if (next) speaking.push(peerId)
    }

    this.emitSpeaking(speaking)
  }

  private applyLocalTrackEnabled() {
    const track = this.localStream?.getAudioTracks()[0]
    if (track) track.enabled = !this.muted && !this.forceMuted
  }

  private audioConstraints(): MediaTrackConstraints | true {
    if (!this.inputDeviceId) return true
    return { deviceId: { exact: this.inputDeviceId } }
  }

  private async acquireMicStream() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Este endereço não permite microfone. Use localhost ou HTTPS.')
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: this.audioConstraints(),
        video: false,
      })
    } catch (err) {
      // deviceId sumiu / inválido — cai no default
      if (this.inputDeviceId) {
        this.inputDeviceId = ''
        return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      }
      throw err
    }
  }

  private async ensureLocalStream() {
    if (this.localStream) return this.localStream
    const stream = await this.acquireMicStream()
    const track = stream.getAudioTracks()[0]
    if (track) track.enabled = false
    this.localStream = stream
    this.applyLocalTrackEnabled()
    this.attachLocalAnalyser(stream)
    for (const { pc } of this.peers.values()) {
      for (const t of stream.getTracks()) {
        if (!pc.getSenders().some((s) => s.track === t)) {
          pc.addTrack(t, stream)
        }
      }
    }
    return stream
  }

  private async replaceLocalStream() {
    const stream = await this.acquireMicStream()
    const newTrack = stream.getAudioTracks()[0]
    if (!newTrack) {
      for (const t of stream.getTracks()) t.stop()
      throw new Error('Microfone indisponível.')
    }
    newTrack.enabled = !this.muted && !this.forceMuted

    const prev = this.localStream
    this.localStream = stream
    this.attachLocalAnalyser(stream)

    for (const { pc } of this.peers.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === 'audio')
      if (sender) {
        try {
          await sender.replaceTrack(newTrack)
        } catch {
          try {
            pc.addTrack(newTrack, stream)
          } catch {
            /* ok */
          }
        }
      } else {
        try {
          pc.addTrack(newTrack, stream)
        } catch {
          /* ok */
        }
      }
    }

    if (prev) {
      for (const t of prev.getTracks()) t.stop()
    }
  }

  private async applyOutputSink(audio: HTMLAudioElement) {
    const sinkId = this.outputDeviceId
    const el = audio as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>
    }
    if (typeof el.setSinkId !== 'function') return
    try {
      await el.setSinkId(sinkId)
    } catch {
      /* device inválido — mantém default */
    }
  }

  private async applyOutputSinkToAll() {
    await Promise.all([...this.peers.values()].map((p) => this.applyOutputSink(p.audio)))
  }

  private teardownMedia() {
    this.detachLocalAnalyser()
    if (this.localStream) {
      for (const t of this.localStream.getTracks()) t.stop()
      this.localStream = null
    }
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {
        /* ok */
      })
      this.audioCtx = null
    }
  }

  private closeAllPeers() {
    for (const peerId of [...this.peers.keys()]) this.closePeer(peerId)
  }

  private closePeer(peerId: string) {
    const link = this.peers.get(peerId)
    if (!link) return
    this.peers.delete(peerId)
    this.detachRemoteAnalyser(link)
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
    void this.applyOutputSink(audio)

    const entry: PeerLink = {
      pc,
      audio,
      analyser: null,
      source: null,
      lastSpokeAt: 0,
      speaking: false,
    }
    this.peers.set(peerId, entry)

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
      this.attachRemoteAnalyser(entry, stream)
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
