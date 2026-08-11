import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REFRESH_SECRET_NAMES = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN'
];

function value(source, key) {
  return String(source?.[key] || '').trim();
}

export function hasGoogleRefreshCredentials(source = process.env) {
  return GOOGLE_REFRESH_SECRET_NAMES.every(name => Boolean(value(source, name)));
}

export async function exchangeGoogleRefreshToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch
} = {}) {
  const credentials = {
    clientId: String(clientId || '').trim(),
    clientSecret: String(clientSecret || '').trim(),
    refreshToken: String(refreshToken || '').trim()
  };
  const missing = Object.entries(credentials).filter(([, entry]) => !entry).map(([key]) => key);
  if (missing.length) throw new Error(`Google OAuth refresh credentials are incomplete: ${missing.join(', ')}`);

  const body = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: credentials.refreshToken,
    grant_type: 'refresh_token'
  });
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const reason = payload?.error_description || payload?.error || response.statusText || 'token refresh failed';
    throw new Error(`Google OAuth token refresh failed (${response.status}): ${reason}`);
  }
  const accessToken = String(payload?.access_token || '').trim();
  if (!accessToken) throw new Error('Google OAuth token refresh succeeded without an access_token');
  return {
    accessToken,
    tokenType: String(payload?.token_type || 'Bearer'),
    expiresIn: Number(payload?.expires_in || 0) || null
  };
}

export async function resolveGoogleAccessToken({ source = process.env, fetchImpl = fetch } = {}) {
  if (hasGoogleRefreshCredentials(source)) {
    const refreshed = await exchangeGoogleRefreshToken({
      clientId: value(source, 'GOOGLE_OAUTH_CLIENT_ID'),
      clientSecret: value(source, 'GOOGLE_OAUTH_CLIENT_SECRET'),
      refreshToken: value(source, 'GOOGLE_REFRESH_TOKEN'),
      fetchImpl
    });
    return { ...refreshed, mode: 'refresh-token' };
  }

  const legacy = value(source, 'GOOGLE_ACCESS_TOKEN');
  if (legacy) return { accessToken: legacy, tokenType: 'Bearer', expiresIn: null, mode: 'legacy-access-token' };

  throw new Error(`Google OAuth connection is not configured. Add ${GOOGLE_REFRESH_SECRET_NAMES.join(', ')} as Actions secrets.`);
}

export function writeAccessTokenToGitHubEnv(accessToken, envFile = process.env.GITHUB_ENV) {
  if (!envFile) throw new Error('GITHUB_ENV is not available');
  const token = String(accessToken || '').trim();
  if (!token || token.includes('\n') || token.includes('\r')) throw new Error('Invalid Google access token');
  fs.appendFileSync(path.resolve(envFile), `GOOGLE_ACCESS_TOKEN=${token}\n`, { encoding: 'utf8' });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  resolveGoogleAccessToken()
    .then(result => {
      writeAccessTokenToGitHubEnv(result.accessToken);
      console.log(`Google OAuth access token prepared via ${result.mode}. Token value was not printed.`);
    })
    .catch(error => {
      console.error(error.message || String(error));
      process.exitCode = 1;
    });
}
