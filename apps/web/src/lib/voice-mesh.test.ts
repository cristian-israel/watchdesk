import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  VOICE_ANSWER_TIMEOUT_MS,
  VOICE_RECONNECT_BASE_MS,
  VoiceMesh,
} from './voice-mesh'

type MockPc = {
  connectionState: RTCPeerConnectionState
  signalingState: RTCSignalingState
  localDescription: RTCSessionDescriptionInit | null
  remoteDescription: RTCSessionDescriptionInit | null
  currentRemoteDescription: RTCSessionDescriptionInit | null
  ontrack: ((ev: Event) => void) | null
  onicecandidate: ((ev: { candidate: { toJSON: () => RTCIceCandidateInit } | null }) => void) | null
  onnegotiationneeded: (() => void) | null
  onconnectionstatechange: (() => void) | null
  addTrack: ReturnType<typeof vi.fn>
  getSenders: ReturnType<typeof vi.fn>
  createOffer: ReturnType<typeof vi.fn>
  createAnswer: ReturnType<typeof vi.fn>
  setLocalDescription: ReturnType<typeof vi.fn>
  setRemoteDescription: ReturnType<typeof vi.fn>
  addIceCandidate: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  _fireConnection: (state: RTCPeerConnectionState) => void
}

const pcs: MockPc[] = []

function makeTrack() {
  return {
    kind: 'audio',
    enabled: true,
    stop: vi.fn(),
  } as unknown as MediaStreamTrack
}

function installRtcMock() {
  pcs.length = 0
  class FakePC {
    connectionState: RTCPeerConnectionState = 'new'
    signalingState: RTCSignalingState = 'stable'
    localDescription: RTCSessionDescriptionInit | null = null
    remoteDescription: RTCSessionDescriptionInit | null = null
    currentRemoteDescription: RTCSessionDescriptionInit | null = null
    ontrack: ((ev: Event) => void) | null = null
    onicecandidate: ((ev: unknown) => void) | null = null
    onnegotiationneeded: (() => void) | null = null
    onconnectionstatechange: (() => void) | null = null
    addTrack = vi.fn()
    getSenders = vi.fn(() => [])
    createOffer = vi.fn(async () => ({ type: 'offer' as const, sdp: 'offer-sdp' }))
    createAnswer = vi.fn(async () => ({ type: 'answer' as const, sdp: 'answer-sdp' }))
    setLocalDescription = vi.fn(async (desc: RTCSessionDescriptionInit) => {
      this.localDescription = desc
      this.signalingState = desc.type === 'offer' ? 'have-local-offer' : 'stable'
    })
    setRemoteDescription = vi.fn(async (desc: RTCSessionDescriptionInit) => {
      this.remoteDescription = desc
      this.currentRemoteDescription = desc
      this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable'
    })
    addIceCandidate = vi.fn(async () => undefined)
    close = vi.fn(() => {
      this.connectionState = 'closed'
      this.onconnectionstatechange?.()
    })
    _fireConnection(state: RTCPeerConnectionState) {
      this.connectionState = state
      this.onconnectionstatechange?.()
    }
    constructor() {
      pcs.push(this as unknown as MockPc)
    }
  }
  vi.stubGlobal('RTCPeerConnection', FakePC)
}

describe('VoiceMesh', () => {
  let sent: unknown[]

  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    installRtcMock()
    const track = makeTrack()
    const stream = {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    } as unknown as MediaStream
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => stream),
      },
    })
    vi.stubGlobal(
      'AudioContext',
      class {
        createMediaStreamSource() {
          return { connect: vi.fn(), disconnect: vi.fn() }
        }
        createAnalyser() {
          return {
            fftSize: 256,
            smoothingTimeConstant: 0.5,
            getByteTimeDomainData: vi.fn(),
          }
        }
        close = vi.fn(async () => undefined)
        resume = vi.fn(async () => undefined)
      },
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  function createMesh(selfId = 'aaa') {
    const mesh = new VoiceMesh({
      send: (msg) => {
        sent.push(msg)
      },
      iceServers: () => [{ urls: 'stun:stun.l.google.com:19302' }],
    })
    mesh.setSelfPeerId(selfId)
    return mesh
  }

  it('enfileira offer com voz desligada e responde após setEnabled', async () => {
    const mesh = createMesh('bbb')
    await mesh.handleOffer('aaa', 'remote-offer')
    expect(mesh.getPendingOfferCount()).toBe(1)
    expect(sent.filter((m) => (m as { type: string }).type === 'voice_answer')).toHaveLength(0)

    mesh.setMembers(['aaa'])
    await mesh.setEnabled(true)

    expect(mesh.getPendingOfferCount()).toBe(0)
    const answers = sent.filter((m) => (m as { type: string }).type === 'voice_answer')
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({ type: 'voice_answer', to: 'aaa', sdp: 'answer-sdp' })
    mesh.teardown()
  })

  it('enfileira ICE antes do PC e aplica depois do remote description', async () => {
    const mesh = createMesh('aaa')
    mesh.setMembers(['bbb'])
    await mesh.setEnabled(true)
    expect(pcs.length).toBe(1)

    const early: RTCIceCandidateInit = { candidate: 'early', sdpMid: '0' }
    await mesh.handleIce('bbb', early)
    expect(pcs[0].addIceCandidate).not.toHaveBeenCalled()

    await mesh.handleAnswer('bbb', 'answer-sdp')
    expect(pcs[0].addIceCandidate).toHaveBeenCalledWith(early)
    mesh.teardown()
  })

  it('recria peer após connectionState failed', async () => {
    const mesh = createMesh('aaa')
    mesh.setMembers(['bbb'])
    await mesh.setEnabled(true)
    expect(mesh.getPeerCount()).toBe(1)
    const first = pcs[0]

    first._fireConnection('failed')
    expect(mesh.getPeerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(VOICE_RECONNECT_BASE_MS)
    expect(mesh.getPeerCount()).toBe(1)
    expect(pcs.length).toBeGreaterThan(1)
    mesh.teardown()
  })

  it('reenvia offer se a answer não chegar a tempo', async () => {
    const mesh = createMesh('aaa')
    mesh.setMembers(['bbb'])
    await mesh.setEnabled(true)

    const offers = () =>
      sent.filter((m) => (m as { type: string }).type === 'voice_offer') as {
        type: string
        to: string
      }[]
    expect(offers().length).toBeGreaterThanOrEqual(1)

    await vi.advanceTimersByTimeAsync(VOICE_ANSWER_TIMEOUT_MS)
    expect(offers().length).toBeGreaterThanOrEqual(2)
    mesh.teardown()
  })
})
