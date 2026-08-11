import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_TOKEN_ENDPOINT,
  exchangeGoogleRefreshToken,
  hasGoogleRefreshCredentials,
  resolveGoogleAccessToken
} from '../scripts/google-oauth.mjs';

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('detects complete stable Google refresh credentials', () => {
  assert.equal(hasGoogleRefreshCredentials({
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    GOOGLE_REFRESH_TOKEN: 'refresh-token'
  }), true);
  assert.equal(hasGoogleRefreshCredentials({ GOOGLE_OAUTH_CLIENT_ID: 'client-id' }), false);
});

test('refresh exchange posts OAuth refresh_token grant without leaking credentials', async () => {
  let captured;
  const result = await exchangeGoogleRefreshToken({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    refreshToken: 'refresh-token',
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return response({ access_token: 'fresh-access-token', expires_in: 3600, token_type: 'Bearer' });
    }
  });
  assert.equal(captured.url, GOOGLE_TOKEN_ENDPOINT);
  assert.equal(captured.options.method, 'POST');
  const form = new URLSearchParams(String(captured.options.body));
  assert.equal(form.get('client_id'), 'client-id');
  assert.equal(form.get('client_secret'), 'client-secret');
  assert.equal(form.get('refresh_token'), 'refresh-token');
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(result.accessToken, 'fresh-access-token');
  assert.equal(result.expiresIn, 3600);
});

test('refresh credentials are preferred over a legacy short-lived access token', async () => {
  const result = await resolveGoogleAccessToken({
    source: {
      GOOGLE_OAUTH_CLIENT_ID: 'client-id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
      GOOGLE_REFRESH_TOKEN: 'refresh-token',
      GOOGLE_ACCESS_TOKEN: 'legacy-token'
    },
    fetchImpl: async () => response({ access_token: 'refreshed-token', expires_in: 3600, token_type: 'Bearer' })
  });
  assert.equal(result.mode, 'refresh-token');
  assert.equal(result.accessToken, 'refreshed-token');
});

test('legacy access token remains a migration fallback', async () => {
  const result = await resolveGoogleAccessToken({ source: { GOOGLE_ACCESS_TOKEN: 'legacy-token' } });
  assert.equal(result.mode, 'legacy-access-token');
  assert.equal(result.accessToken, 'legacy-token');
});

test('OAuth failure message never includes supplied secret values', async () => {
  await assert.rejects(
    exchangeGoogleRefreshToken({
      clientId: 'client-id-sensitive',
      clientSecret: 'client-secret-sensitive',
      refreshToken: 'refresh-token-sensitive',
      fetchImpl: async () => response({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400)
    }),
    error => {
      const message = String(error?.message || error);
      assert.match(message, /invalid_grant|expired|revoked/i);
      assert.equal(message.includes('client-secret-sensitive'), false);
      assert.equal(message.includes('refresh-token-sensitive'), false);
      return true;
    }
  );
});
