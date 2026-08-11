import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildLiffPayload,
  issueShortLivedChannelAccessToken,
  provisionLine,
  validateEndpointUrl
} from '../scripts/line-provision.mjs';

function sampleConfig() {
  return {
    version: 1,
    business: { name: 'Test Studio' },
    integrations: {
      line: {
        enabled: false,
        mode: 'liff',
        status: 'not-provisioned',
        liffId: '',
        liffUrl: '',
        endpointUrl: 'https://example.test/booking/',
        friendUrl: '',
        viewType: 'full',
        moduleMode: false,
        scopes: ['openid', 'profile'],
        botPrompt: 'none',
        description: 'Test Studio Booking'
      }
    }
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('LIFF endpoint must be HTTPS and contain no fragment', () => {
  assert.equal(validateEndpointUrl('https://example.test/booking/').ok, true);
  assert.equal(validateEndpointUrl('http://example.test/booking/').reason, 'endpoint-must-use-https');
  assert.equal(validateEndpointUrl('https://example.test/booking/#x').reason, 'endpoint-must-not-have-fragment');
});

test('LIFF payload contains only supported public configuration', () => {
  const payload = buildLiffPayload(sampleConfig());
  assert.equal(payload.view.type, 'full');
  assert.equal(payload.view.url, 'https://example.test/booking/');
  assert.deepEqual(payload.scope, ['openid', 'profile']);
  assert.equal(payload.botPrompt, 'none');
  assert.equal(JSON.stringify(payload).includes('secret'), false);
});

test('channel ID and secret can mint a short-lived access token without returning credentials', async () => {
  const calls = [];
  const token = await issueShortLivedChannelAccessToken({
    channelId: 'test-channel-id',
    channelSecret: 'test-channel-secret',
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), body: String(options.body || '') });
      return jsonResponse({ access_token: 'test-channel-access-token', expires_in: 2592000, token_type: 'Bearer' });
    }
  });
  assert.equal(token, 'test-channel-access-token');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].body.includes('client_id=test-channel-id'));
  assert.ok(calls[0].body.includes('client_secret=test-channel-secret'));
});

test('dry-run needs no LINE secret and writes nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-line-dry-'));
  const config = sampleConfig();
  const configPath = path.join(root, 'business.config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const before = fs.readFileSync(configPath, 'utf8');
  const result = await provisionLine({ root, dryRun: true });
  const after = fs.readFileSync(configPath, 'utf8');
  assert.equal(result.plan.operation, 'create');
  assert.equal(result.plan.endpointReady, true);
  assert.equal(result.plan.credentialSource, 'missing');
  assert.equal(before, after);
});

test('provisioner creates and verifies LIFF app then persists only public identifiers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-line-live-'));
  const configPath = path.join(root, 'business.config.json');
  fs.writeFileSync(configPath, JSON.stringify(sampleConfig(), null, 2));

  let created = false;
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ url: target, method: options.method || 'GET', authorization: options.headers?.Authorization || '' });

    if (target === 'https://example.test/booking/') {
      return new Response('<!doctype html><title>booking</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    if (target === 'https://api.line.me/v2/oauth/accessToken') {
      return jsonResponse({ access_token: 'test-channel-access-token', expires_in: 2592000, token_type: 'Bearer' });
    }
    if (target === 'https://api.line.me/liff/v1/apps' && (options.method || 'GET') === 'GET') {
      if (!created) return new Response('', { status: 404 });
      return jsonResponse({ apps: [{ liffId: 'test-liff-id', view: { type: 'full', url: 'https://example.test/booking/', moduleMode: false } }] });
    }
    if (target === 'https://api.line.me/liff/v1/apps' && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      assert.equal(payload.view.url, 'https://example.test/booking/');
      created = true;
      return jsonResponse({ liffId: 'test-liff-id' }, 201);
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${target}`);
  };

  const result = await provisionLine({
    root,
    channelId: 'test-channel-id',
    channelSecret: 'test-channel-secret',
    fetchImpl: fakeFetch
  });

  assert.equal(result.status, 'live');
  assert.equal(result.operation, 'create');
  assert.equal(result.liffId, 'test-liff-id');
  assert.equal(result.liffUrl, 'https://liff.line.me/test-liff-id');

  const written = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(written.integrations.line.enabled, true);
  assert.equal(written.integrations.line.status, 'live');
  assert.equal(written.integrations.line.liffId, 'test-liff-id');
  assert.equal(written.integrations.line.liffUrl, 'https://liff.line.me/test-liff-id');
  const raw = JSON.stringify(written);
  assert.equal(raw.includes('test-channel-secret'), false);
  assert.equal(raw.includes('test-channel-access-token'), false);

  const lineApiCalls = calls.filter(call => call.url.startsWith('https://api.line.me/liff/'));
  assert.ok(lineApiCalls.every(call => call.authorization === 'Bearer test-channel-access-token'));
});

test('configured LIFF ID must exist on selected channel before update', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-line-mismatch-'));
  const config = sampleConfig();
  config.integrations.line.liffId = 'expected-id';
  fs.writeFileSync(path.join(root, 'business.config.json'), JSON.stringify(config, null, 2));

  const fakeFetch = async (url, options = {}) => {
    const target = String(url);
    if (target === 'https://example.test/booking/') return new Response('ok', { status: 200 });
    if (target === 'https://api.line.me/liff/v1/apps' && (options.method || 'GET') === 'GET') {
      return jsonResponse({ apps: [{ liffId: 'different-id', view: { url: 'https://example.test/booking/' } }] });
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${target}`);
  };

  await assert.rejects(
    provisionLine({ root, token: 'test-token', fetchImpl: fakeFetch }),
    /refusing to create a duplicate/
  );
});
