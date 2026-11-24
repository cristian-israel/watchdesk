'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTestRoom,
  mockWs,
  resolveHostJoin,
  roster,
  detachClient,
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

  it('does nothing when same host reconnects on same ws', () => {
    const room = createTestRoom();
    const ws = mockWs();
    room.host = {
      ws,
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Host',
    };

    const result = resolveHostJoin(room, {
      sessionRole: 'host',
      incomingWs: ws,
    });

    assert.equal(result.kicked, false);
    assert.equal(room.host.peerId, 'h1');
  });

  it('ignores viewer sessions', () => {
    const room = createTestRoom();
    room.host = {
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Host',
    };

    const result = resolveHostJoin(room, {
      sessionRole: 'viewer',
      incomingWs: mockWs(),
    });

    assert.equal(result.kicked, false);
    assert.equal(room.host.peerId, 'h1');
  });
});

describe('live-room roster', () => {
  it('lists host and viewers without seats or panels', () => {
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
    assert.equal(members.every((m) => m.seat === undefined), true);
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
