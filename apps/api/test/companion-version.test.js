'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cmpSemver, companionLatest } = require('../src/companion-version');

test('cmpSemver ordena versões', () => {
  assert.equal(cmpSemver('0.1.0', '0.1.1'), -1);
  assert.equal(cmpSemver('1.0.0', '0.9.9'), 1);
  assert.equal(cmpSemver('0.1.0', '0.1.0'), 0);
});

test('companionLatest lê env', () => {
  const prev = process.env.COMPANION_VERSION;
  process.env.COMPANION_VERSION = '9.9.9';
  assert.equal(companionLatest().version, '9.9.9');
  if (prev === undefined) delete process.env.COMPANION_VERSION;
  else process.env.COMPANION_VERSION = prev;
});
