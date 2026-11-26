import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyHostMute,
  applySelfMute,
  canPublishScreen,
  canRelayScreen,
  canRelaySignal,
  claimSlot,
  createTestRoom,
  denyPending,
  detachClient,
  kickViewer,
  mockWs,
  pendingList,
  promotePending,
  resetVoiceMutes,
  resolveHostJoin,
  roster,
  setScreenAllow,
  slotList,
  testClient,
  voiceState,
} from './live-room'

describe('live-room resolveHostJoin', () => {
  it('kicks previous host when a new host joins', () => {
    const room = createTestRoom()
    const prevWs = mockWs()
    room.host = testClient({
      ws: prevWs,
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Host1',
    })
    room.slotOwners.set(0, 'h1')

    const result = resolveHostJoin(room, {
      sessionRole: 'host',
      incomingWs: mockWs(),
    })

    assert.equal(result.kicked, true)
    assert.equal(room.host, null)
    assert.equal(room.slotOwners.size, 0)
    assert.equal((prevWs.msgs[0] as { type?: string })?.type, 'error')
    assert.equal(prevWs.readyState, 3)
  })
})

describe('live-room admit', () => {
  it('promotes pending to viewer', () => {
    const room = createTestRoom()
    room.host = testClient({
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Host',
    })
    const viewerWs = mockWs()
    room.pending.set(
      'p1',
      testClient({
        ws: viewerWs,
        peerId: 'p1',
        role: 'pending',
        roomSlug: 'test',
        displayName: 'Ana',
        deviceId: 'd1',
      }),
    )

    const result = promotePending(room, 'p1')
    assert.equal(result.ok, true)
    assert.equal(room.pending.size, 0)
    assert.equal(room.viewers.get('p1')?.role, 'viewer')
    assert.equal(room.admittedDevices.has('d1'), true)
    assert.equal(
      viewerWs.msgs.some(
        (m) =>
          (m as { type?: string; accepted?: boolean }).type === 'admit_result' &&
          (m as { accepted?: boolean }).accepted,
      ),
      true,
    )
    assert.deepEqual(pendingList(room), [])
  })

  it('denies pending and closes socket', () => {
    const room = createTestRoom()
    room.host = testClient({
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Host',
    })
    const viewerWs = mockWs()
    room.pending.set(
      'p1',
      testClient({
        ws: viewerWs,
        peerId: 'p1',
        role: 'pending',
        roomSlug: 'test',
        displayName: 'Ana',
        sessionId: 'sess1',
      }),
    )

    const result = denyPending(room, 'p1')
    assert.equal(result.ok, true)
    assert.equal(room.pending.size, 0)
    assert.equal((viewerWs.msgs[0] as { accepted?: boolean })?.accepted, false)
    assert.equal(viewerWs.readyState, 3)
  })
})

describe('live-room roster', () => {
  it('lists host and viewers', () => {
    const room = createTestRoom()
    room.host = testClient({
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Host',
    })
    room.viewers.set(
      'v1',
      testClient({
        ws: mockWs(),
        peerId: 'v1',
        role: 'viewer',
        roomSlug: 'test',
        displayName: 'V',
      }),
    )

    const members = roster(room)
    assert.deepEqual(
      members.map((m) => ({ peerId: m.peerId, role: m.role })),
      [
        { peerId: 'h1', role: 'host' },
        { peerId: 'v1', role: 'viewer' },
      ],
    )
  })
})

describe('live-room detachClient', () => {
  it('clears host and notifies viewers', () => {
    const live = new Map()
    const room = createTestRoom()
    live.set('test', room)
    const viewerWs = mockWs()
    const host = testClient({
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Host',
    })
    room.host = host
    room.slotOwners.set(0, 'h1')
    room.viewers.set(
      'v1',
      testClient({
        ws: viewerWs,
        peerId: 'v1',
        role: 'viewer',
        roomSlug: 'test',
        displayName: 'V',
      }),
    )

    detachClient(live, host)

    assert.equal(room.host, null)
    assert.equal(room.slotOwners.size, 0)
    assert.equal(viewerWs.msgs.some((m) => (m as { type?: string }).type === 'host_left'), true)
  })
})

describe('live-room voice relay', () => {
  it('allows viewer↔viewer when voice is enabled', () => {
    const room = createTestRoom()
    room.voiceEnabled = true
    const a = testClient({
      ws: mockWs(),
      peerId: 'v1',
      role: 'viewer',
      roomSlug: 'test',
      displayName: 'A',
    })
    const b = testClient({
      ws: mockWs(),
      peerId: 'v2',
      role: 'viewer',
      roomSlug: 'test',
      displayName: 'B',
    })
    assert.equal(canRelaySignal(room, a, b, 'voice'), true)
  })

  it('blocks voice relay when voice is disabled', () => {
    const room = createTestRoom()
    room.voiceEnabled = false
    const host = testClient({
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'H',
    })
    const viewer = testClient({
      ws: mockWs(),
      peerId: 'v1',
      role: 'viewer',
      roomSlug: 'test',
      displayName: 'V',
    })
    assert.equal(canRelaySignal(room, host, viewer, 'voice'), false)
  })
})

describe('live-room viewer screen share', () => {
  it('viewer cannot publish without allow', () => {
    const room = createTestRoom()
    const viewer = testClient({
      ws: mockWs(),
      peerId: 'v1',
      role: 'viewer',
      roomSlug: 'test',
      displayName: 'V',
    })
    room.viewers.set('v1', viewer)
    assert.equal(canPublishScreen(room, viewer), false)
    assert.equal(claimSlot(room, 0, viewer).ok, false)
  })

  it('viewer can claim slot after host allows', () => {
    const room = createTestRoom()
    room.host = testClient({
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'H',
    })
    const viewer = testClient({
      ws: mockWs(),
      peerId: 'v1',
      role: 'viewer',
      roomSlug: 'test',
      displayName: 'V',
    })
    room.viewers.set('v1', viewer)
    assert.equal(setScreenAllow(room, 'v1', true).ok, true)
    assert.equal(canPublishScreen(room, viewer), true)
    assert.equal(claimSlot(room, 0, viewer).ok, true)
    assert.deepEqual(slotList(room), [{ slot: 0, peerId: 'v1', displayName: 'V' }])
  })

  it('revoke releases slots and blocks offer', () => {
    const room = createTestRoom()
    const host = testClient({
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'H',
    })
    const viewer = testClient({
      ws: mockWs(),
      peerId: 'v1',
      role: 'viewer',
      roomSlug: 'test',
      displayName: 'V',
    })
    const other = testClient({
      ws: mockWs(),
      peerId: 'v2',
      role: 'viewer',
      roomSlug: 'test',
      displayName: 'O',
    })
    room.host = host
    room.viewers.set('v1', viewer)
    room.viewers.set('v2', other)
    setScreenAllow(room, 'v1', true)
    claimSlot(room, 0, viewer)
    assert.equal(canRelayScreen(room, viewer, other, 0, 'offer'), true)
    assert.equal(canRelayScreen(room, other, viewer, 0, 'answer'), true)
    setScreenAllow(room, 'v1', false)
    assert.equal(room.slotOwners.size, 0)
    assert.equal(canPublishScreen(room, viewer), false)
    assert.equal(canRelayScreen(room, viewer, other, 0, 'offer'), false)
  })
})

describe('live-room voice mute', () => {
  it('host can force mute a viewer', () => {
    const room = createTestRoom()
    room.voiceEnabled = true
    room.host = testClient({
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'H',
    })
    room.viewers.set(
      'v1',
      testClient({
        ws: mockWs(),
        peerId: 'v1',
        role: 'viewer',
        roomSlug: 'test',
        displayName: 'V',
        muted: false,
      }),
    )

    const result = applyHostMute(room, 'v1', true)
    assert.equal(result.ok, true)
    assert.equal(room.viewers.get('v1')?.forceMuted, true)
    assert.equal(room.viewers.get('v1')?.muted, true)
  })

  it('self_mute is ignored under forceMuted', () => {
    const client = testClient({
      ws: mockWs(),
      peerId: 'v1',
      role: 'viewer',
      roomSlug: 'test',
      displayName: 'V',
      muted: true,
      forceMuted: true,
    })
    const result = applySelfMute(client, false)
    assert.equal(result.ok, false)
    assert.equal(client.muted, true)
  })

  it('resetVoiceMutes clears force mute when voice turns off', () => {
    const room = createTestRoom()
    room.voiceEnabled = false
    room.host = testClient({
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'H',
      muted: false,
      forceMuted: true,
    })
    room.viewers.set(
      'v1',
      testClient({
        ws: mockWs(),
        peerId: 'v1',
        role: 'viewer',
        roomSlug: 'test',
        displayName: 'V',
        muted: false,
        forceMuted: true,
      }),
    )

    resetVoiceMutes(room)
    const peers = voiceState(room)
    assert.deepEqual(peers, [
      { peerId: 'h1', muted: true, forceMuted: false },
      { peerId: 'v1', muted: true, forceMuted: false },
    ])
  })
})

describe('live-room kickViewer', () => {
  it('removes one viewer, slots and admit, keeps others', () => {
    const room = createTestRoom()
    room.host = testClient({
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'H',
    })
    const targetWs = mockWs()
    room.viewers.set(
      'v1',
      testClient({
        ws: targetWs,
        peerId: 'v1',
        role: 'viewer',
        roomSlug: 'test',
        displayName: 'Alvo',
        deviceId: 'd1',
      }),
    )
    room.viewers.set(
      'v2',
      testClient({
        ws: mockWs(),
        peerId: 'v2',
        role: 'viewer',
        roomSlug: 'test',
        displayName: 'Outro',
        deviceId: 'd2',
      }),
    )
    room.admittedDevices.add('d1')
    room.admittedDevices.add('d2')
    room.screenAllowed.add('v1')
    room.slotOwners.set(0, 'v1')
    room.slotOwners.set(1, 'h1')

    const result = kickViewer(room, 'v1', 'Removido')
    assert.equal(result.ok, true)
    assert.equal(room.viewers.has('v1'), false)
    assert.equal(room.viewers.has('v2'), true)
    assert.equal(room.admittedDevices.has('d1'), false)
    assert.equal(room.admittedDevices.has('d2'), true)
    assert.equal(room.screenAllowed.has('v1'), false)
    assert.equal(room.slotOwners.has(0), false)
    assert.equal(room.slotOwners.get(1), 'h1')
    assert.equal((targetWs.msgs[0] as { type?: string })?.type, 'auth_changed')
    assert.equal(targetWs.readyState, 3)
  })
})
