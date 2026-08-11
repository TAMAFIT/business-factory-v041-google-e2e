import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingSource, initializeLine, prefillFromLineProfile } from '../src/line.js';

function lineConfig(overrides = {}) {
  return {
    integrations: {
      line: {
        enabled: true,
        mode: 'liff',
        liffId: 'test-liff-id',
        scopes: ['openid', 'profile'],
        ...overrides
      }
    }
  };
}

test('disabled LINE config avoids touching LIFF SDK', async () => {
  const result = await initializeLine({ integrations: { line: { enabled: false } } }, null);
  assert.equal(result.enabled, false);
  assert.equal(result.ready, false);
});

test('LIFF runtime initializes and exposes only minimal profile fields', async () => {
  let initArg = null;
  const fakeLiff = {
    async init(arg) { initArg = arg; },
    isInClient() { return true; },
    isLoggedIn() { return true; },
    async getProfile() {
      return {
        userId: 'must-not-leak-user-id',
        displayName: 'Test User',
        pictureUrl: 'https://example.test/user.png',
        statusMessage: 'hello'
      };
    }
  };

  const result = await initializeLine(lineConfig(), fakeLiff);
  assert.deepEqual(initArg, { liffId: 'test-liff-id' });
  assert.equal(result.ready, true);
  assert.equal(result.inClient, true);
  assert.equal(result.loggedIn, true);
  assert.equal(result.profile.displayName, 'Test User');
  assert.equal('userId' in result.profile, false);
  assert.equal(bookingSource(result), 'line-liff');
});

test('external browser LIFF is tagged separately', async () => {
  const fakeLiff = {
    async init() {},
    isInClient() { return false; },
    isLoggedIn() { return false; }
  };
  const result = await initializeLine(lineConfig({ scopes: ['openid'] }), fakeLiff);
  assert.equal(result.ready, true);
  assert.equal(bookingSource(result), 'liff-external-browser');
});

test('LINE display name prefills only an empty name input', () => {
  const input = { value: '' };
  const form = { querySelector: selector => selector === '[name="name"]' ? input : null };
  const context = { profile: { displayName: 'LINE User' } };
  assert.equal(prefillFromLineProfile(form, context), true);
  assert.equal(input.value, 'LINE User');
  input.value = 'Typed Name';
  assert.equal(prefillFromLineProfile(form, context), false);
  assert.equal(input.value, 'Typed Name');
});
