'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTestRoom,
  mockWs,
  resolveHostJoin,
  roster,
  detachClient,
  promotePending,
  denyPending,
  pendingList,
} = require('../src/live-room');

describe('live-room resolveHostJoin', () => {
  it('kicks previous host when a new host joins', () => {
    const room = createTestRoom();
    const prevWs = mockWs();
    room.host = {
      ws: prevWs,
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Host1',
    };
    room.slots.add(0);

    const result = resolveHostJoin(room, {
      sessionRole: 'host',
      incomingWs: mockWs(),
    });

    assert.equal(result.kicked, true);
    assert.equal(room.host, null);
    assert.equal(room.slots.size, 0);
    assert.equal(prevWs.msgs[0]?.type, 'error');
    assert.equal(prevWs.readyState, 3);
  });
});

describe('live-room admit', () => {
  it('promotes pending to viewer', () => {
    const room = createTestRoom();
    room.host = {
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Host',
    };
    const viewerWs = mockWs();
    room.pending.set('p1', {
      ws: viewerWs,
      peerId: 'p1',
      role: 'pending',
      roomSlug: 'test',
      displayName: 'Ana',
      deviceId: 'd1',
    });

    const result = promotePending(room, 'p1');
    assert.equal(result.ok, true);
    assert.equal(room.pending.size, 0);
    assert.equal(room.viewers.get('p1')?.role, 'viewer');
    assert.equal(room.admittedDevices.has('d1'), true);
    assert.equal(viewerWs.msgs.some((m) => m.type === 'admit_result' && m.accepted), true);
    assert.deepEqual(pendingList(room), []);
  });

  it('denies pending and closes socket', () => {
    const room = createTestRoom();
    room.host = {
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Host',
    };
    const viewerWs = mockWs();
    room.pending.set('p1', {
      ws: viewerWs,
      peerId: 'p1',
      role: 'pending',
      roomSlug: 'test',
      displayName: 'Ana',
      sessionId: 'sess1',
    });

    const result = denyPending(room, 'p1');
    assert.equal(result.ok, true);
    assert.equal(room.pending.size, 0);
    assert.equal(viewerWs.msgs[0]?.accepted, false);
    assert.equal(viewerWs.readyState, 3);
  });
});

describe('live-room roster', () => {
  it('lists host and viewers', () => {
    const room = createTestRoom();
    room.host = {
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Host',
    };
    room.viewers.set('v1', {
      ws: mockWs(),
      peerId: 'v1',
      role: 'viewer',
      roomSlug: 'test',
      displayName: 'V',
    });

    const members = roster(room);
    assert.deepEqual(
      members.map((m) => ({ peerId: m.peerId, role: m.role })),
      [
        { peerId: 'h1', role: 'host' },
        { peerId: 'v1', role: 'viewer' },
      ],
    );
  });
});

describe('live-room detachClient', () => {
  it('clears host and notifies viewers', () => {
    const live = new Map();
    const room = createTestRoom();
    live.set('test', room);
    const viewerWs = mockWs();
    const host = {
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Host',
    };
    room.host = host;
    room.slots.add(0);
    room.viewers.set('v1', {
      ws: viewerWs,
      peerId: 'v1',
      role: 'viewer',
      roomSlug: 'test',
      displayName: 'V',
    });

    detachClient(live, host);

    assert.equal(room.host, null);
    assert.equal(room.slots.size, 0);
    assert.equal(viewerWs.msgs.some((m) => m.type === 'host_left'), true);
  });
});
