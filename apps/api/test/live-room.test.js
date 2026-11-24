'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTestRoom,
  mockWs,
  resolveHostJoin,
  applyControlMode,
  roster,
  canControlRoom,
  seatOf,
} = require('../src/live-room');

describe('live-room resolveHostJoin', () => {
  it('demote web host to panel when companion joins', () => {
    const room = createTestRoom();
    const webWs = mockWs();
    room.host = {
      ws: webWs,
      peerId: 'web1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Web',
      controlMode: 'view',
      clientKind: 'web',
    };
    room.slots.add(0);

    const companionWs = mockWs();
    const result = resolveHostJoin(room, {
      sessionRole: 'host',
      helloKind: 'companion',
      incomingWs: companionWs,
    });

    assert.equal(result.joinAsPanel, false);
    assert.equal(room.host, null);
    assert.equal(room.panels.get('web1')?.role, 'panel');
    assert.equal(room.slots.size, 0);
    assert.equal(webWs.msgs[0]?.type, 'host_role');
    assert.equal(webWs.msgs[0]?.seat, 'controller');
  });

  it('web joins as panel while companion transmits', () => {
    const room = createTestRoom();
    room.host = {
      ws: mockWs(),
      peerId: 'comp1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'App',
      controlMode: 'view',
      clientKind: 'companion',
    };
    room.transmitMode = 'companion';

    const result = resolveHostJoin(room, {
      sessionRole: 'host',
      helloKind: 'web',
      incomingWs: mockWs(),
    });

    assert.equal(result.joinAsPanel, true);
    assert.equal(room.host.peerId, 'comp1');
  });

  it('second companion kicks first companion', () => {
    const room = createTestRoom();
    const first = mockWs();
    room.host = {
      ws: first,
      peerId: 'c1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'C1',
      controlMode: 'view',
      clientKind: 'companion',
    };

    const result = resolveHostJoin(room, {
      sessionRole: 'host',
      helloKind: 'companion',
      incomingWs: mockWs(),
    });

    assert.equal(result.joinAsPanel, false);
    assert.equal(room.host, null);
    assert.equal(first.msgs[0]?.type, 'error');
    assert.equal(first.readyState, 3);
  });
});

describe('live-room applyControlMode', () => {
  it('blocks interact in Watch mode (web transmit)', () => {
    const room = createTestRoom();
    room.transmitMode = 'web';
    room.viewers.set('v1', {
      ws: mockWs(),
      peerId: 'v1',
      role: 'viewer',
      roomSlug: 'test',
      displayName: 'Viewer',
      controlMode: 'view',
      clientKind: 'web',
    });

    const result = applyControlMode(room, 'v1', 'interact', { deviceId: 'd1', role: 'host' });
    assert.equal(result.ok, false);
    assert.match(result.message, /Assist/);
    assert.equal(room.viewers.get('v1').controlMode, 'view');
  });

  it('allows interact in Assist mode (companion)', () => {
    const room = createTestRoom();
    room.transmitMode = 'companion';
    room.viewers.set('v1', {
      ws: mockWs(),
      peerId: 'v1',
      role: 'viewer',
      roomSlug: 'test',
      displayName: 'Viewer',
      controlMode: 'view',
      clientKind: 'web',
    });

    const result = applyControlMode(room, 'v1', 'interact', { deviceId: 'd1', role: 'host' });
    assert.equal(result.ok, true);
    assert.equal(room.pilotPeerId, 'v1');
    assert.equal(room.viewers.get('v1').controlMode, 'interact');
  });
});

describe('live-room seats', () => {
  it('roster exposes seat aliases', () => {
    const room = createTestRoom();
    room.host = {
      ws: mockWs(),
      peerId: 'h1',
      role: 'host',
      roomSlug: 'test',
      displayName: 'Host',
      controlMode: 'view',
      clientKind: 'companion',
    };
    room.panels.set('p1', {
      ws: mockWs(),
      peerId: 'p1',
      role: 'panel',
      roomSlug: 'test',
      displayName: 'Panel',
      controlMode: 'view',
      clientKind: 'web',
    });
    room.viewers.set('v1', {
      ws: mockWs(),
      peerId: 'v1',
      role: 'viewer',
      roomSlug: 'test',
      displayName: 'V',
      controlMode: 'view',
      clientKind: 'web',
    });

    const members = roster(room);
    assert.equal(members.find((m) => m.peerId === 'h1').seat, 'transmitter');
    assert.equal(members.find((m) => m.peerId === 'p1').seat, 'controller');
    assert.equal(members.find((m) => m.peerId === 'v1').seat, 'viewer');
    assert.equal(seatOf(room.host), 'transmitter');
    assert.equal(canControlRoom(room.host), true);
    assert.equal(canControlRoom(room.panels.get('p1')), true);
    assert.equal(canControlRoom(room.viewers.get('v1')), false);
  });
});
