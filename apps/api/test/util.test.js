'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ROOM_RE,
  hashEqHex,
  shaHex,
  normalizeName,
  validateKey,
  KEY_MIN_CREATE,
  KEY_MIN_LOGIN,
  parseCookies,
  cookieHeader,
  createRateLimiter,
  iceServers,
  originAllowed,
} = require('../src/util');

test('ROOM_RE aceita slug válido', () => {
  assert.equal(ROOM_RE.test('casa'), true);
  assert.equal(ROOM_RE.test('a_b-1'), true);
  assert.equal(ROOM_RE.test(''), false);
  assert.equal(ROOM_RE.test('sala com espaço'), false);
});

test('hashEqHex compara hashes de mesmo tamanho', () => {
  const a = shaHex('segredo');
  const b = shaHex('segredo');
  const c = shaHex('outro');
  assert.equal(hashEqHex(a, b), true);
  assert.equal(hashEqHex(a, c), false);
  assert.equal(hashEqHex(a, a.slice(0, 10)), false);
});

test('normalizeName trim e limite', () => {
  assert.equal(normalizeName('  Cris  '), 'Cris');
  assert.equal(normalizeName(''), null);
  assert.equal(normalizeName('x'.repeat(81)), null);
});

test('validateKey: criação mín. 8, login mín. 4', () => {
  assert.equal(validateKey('1234567', KEY_MIN_CREATE), false);
  assert.equal(validateKey('12345678', KEY_MIN_CREATE), true);
  assert.equal(validateKey('1234', KEY_MIN_LOGIN), true);
  assert.equal(validateKey('123', KEY_MIN_LOGIN), false);
});

test('parseCookies decodifica e ignora valor quebrado', () => {
  const req = { headers: { cookie: 'wd_device=abc; wd_session=%E0%A4%A' } };
  const out = parseCookies(req);
  assert.equal(out.wd_device, 'abc');
  assert.equal(out.wd_session, '%E0%A4%A');
});

test('cookieHeader inclui Secure só em https', () => {
  const http = cookieHeader('wd_session', 'tok', 60, { headers: {} });
  assert.equal(http.includes('Secure'), false);
  const https = cookieHeader('wd_session', 'tok', 60, {
    headers: { 'x-forwarded-proto': 'https' },
  });
  assert.equal(https.includes('Secure'), true);
  assert.equal(https.includes('HttpOnly'), true);
  assert.equal(https.includes('SameSite=Lax'), true);
});

test('rate limiter bloqueia após 8 falhas', () => {
  const { blocked, noteFailure } = createRateLimiter({ max: 8, windowMs: 60_000 });
  assert.equal(blocked('1.1.1.1'), false);
  for (let i = 0; i < 8; i++) noteFailure('1.1.1.1');
  assert.equal(blocked('1.1.1.1'), true);
  assert.equal(blocked('2.2.2.2'), false);
});

test('iceServers só STUN sem secret', () => {
  const servers = iceServers({ turnSecret: '', turnHost: '', publicHost: '', turnPort: 3478 });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].urls, 'stun:stun.l.google.com:19302');
});

test('iceServers inclui TURN com secret e host', () => {
  const servers = iceServers(
    { turnSecret: 's', turnHost: '', publicHost: '1.2.3.4', turnPort: 3478 },
    'peer1',
    3600,
  );
  assert.equal(servers.length, 2);
  assert.ok(Array.isArray(servers[1].urls));
  assert.ok(servers[1].username.includes(':peer1'));
  assert.ok(servers[1].credential);
});

test('originAllowed: localhost, mesmo host, sem origin', () => {
  assert.equal(originAllowed({ headers: {} }), true);
  assert.equal(
    originAllowed({ headers: { origin: 'http://localhost:7130', host: 'localhost:7030' } }),
    true,
  );
  assert.equal(
    originAllowed({ headers: { origin: 'https://watchdesk.example', host: 'watchdesk.example' } }),
    true,
  );
  assert.equal(
    originAllowed({ headers: { origin: 'https://evil.example', host: 'watchdesk.example' } }),
    false,
  );
});

test('originAllowed: PUBLIC_ORIGIN quando Host é FRONTIER_ALIAS', () => {
  const req = {
    headers: {
      origin: 'https://watchdesk-giganet.ilumea.com.br',
      host: 'watchdesk',
    },
  };
  assert.equal(originAllowed(req, '10.254.1.32'), false);
  assert.equal(
    originAllowed(req, '10.254.1.32', 'https://watchdesk-giganet.ilumea.com.br'),
    true,
  );
  assert.equal(
    originAllowed(req, '10.254.1.32', 'https://outro.ilumea.com.br'),
    false,
  );
});
