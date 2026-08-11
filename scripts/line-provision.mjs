import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CONFIG_PATH = 'business.config.json';
const LIFF_API = 'https://api.line.me/liff/v1/apps';
const TOKEN_API = 'https://api.line.me/v2/oauth/accessToken';
const ALLOWED_SCOPES = new Set(['openid', 'email', 'profile', 'chat_message.write']);
const ALLOWED_VIEWS = new Set(['compact', 'tall', 'full']);
const ALLOWED_BOT_PROMPTS = new Set(['normal', 'aggressive', 'none']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function validateEndpointUrl(value) {
  if (!value) return { ok: false, reason: 'endpoint-url-required' };
  let url;
  try { url = new URL(value); } catch { return { ok: false, reason: 'invalid-endpoint-url' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: 'endpoint-must-use-https' };
  if (url.hash) return { ok: false, reason: 'endpoint-must-not-have-fragment' };
  return { ok: true, url: url.toString() };
}

export function buildLiffPayload(config) {
  const line = config.integrations?.line || {};
  if (line.mode !== 'liff') throw new Error('integrations.line.mode must be liff');
  const endpoint = validateEndpointUrl(line.endpointUrl);
  if (!endpoint.ok) throw new Error(endpoint.reason);

  const viewType = String(line.viewType || 'full').toLowerCase();
  if (!ALLOWED_VIEWS.has(viewType)) throw new Error(`unsupported LIFF view type: ${viewType}`);

  const scopes = Array.isArray(line.scopes) && line.scopes.length ? line.scopes.map(String) : ['openid', 'profile'];
  for (const scope of scopes) {
    if (!ALLOWED_SCOPES.has(scope)) throw new Error(`unsupported LIFF scope: ${scope}`);
  }

  const botPrompt = String(line.botPrompt || 'none');
  if (!ALLOWED_BOT_PROMPTS.has(botPrompt)) throw new Error(`unsupported LIFF botPrompt: ${botPrompt}`);

  const description = String(line.description || `${config.business?.name || 'Booking'} 予約`).trim();
  if (!description) throw new Error('LIFF description is required');
  if (/line/i.test(description)) throw new Error('LIFF description must not contain LINE');

  return {
    view: {
      type: viewType,
      url: endpoint.url,
      moduleMode: Boolean(line.moduleMode)
    },
    description,
    features: { qrCode: false },
    scope: scopes,
    botPrompt
  };
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function lineRequest(token, url, options = {}, fetchImpl = fetch, { allowNotFound = false } = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await parseResponse(response);
  if (allowNotFound && response.status === 404) return { status: 404, payload: null };
  if (!response.ok) {
    const message = payload?.message || payload?.error_description || JSON.stringify(payload) || response.statusText;
    const error = new Error(`LINE API ${response.status}: ${message}`);
    error.status = response.status;
    throw error;
  }
  return { status: response.status, payload };
}

export async function issueShortLivedChannelAccessToken({ channelId, channelSecret, fetchImpl = fetch }) {
  if (!channelId || !channelSecret) throw new Error('LINE Login channel ID and channel secret are required');
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: channelId,
    client_secret: channelSecret
  });
  const response = await fetchImpl(TOKEN_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const payload = await parseResponse(response);
  if (!response.ok || !payload?.access_token) {
    throw new Error(`LINE token issuance failed (${response.status}): ${payload?.error_description || payload?.error || 'unknown error'}`);
  }
  return payload.access_token;
}

async function resolveChannelAccessToken({ token, channelId, channelSecret, fetchImpl }) {
  if (token) return token;
  return issueShortLivedChannelAccessToken({ channelId, channelSecret, fetchImpl });
}

export async function checkEndpoint(endpointUrl, fetchImpl = fetch) {
  const endpoint = validateEndpointUrl(endpointUrl);
  if (!endpoint.ok) return { ok: false, reason: endpoint.reason, status: null };
  try {
    const response = await fetchImpl(endpoint.url, {
      method: 'GET',
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    return {
      ok: response.ok,
      status: response.status,
      reason: response.ok ? 'healthy' : `http-${response.status}`
    };
  } catch (error) {
    return { ok: false, status: null, reason: error?.message || String(error) };
  }
}

async function listLiffApps(token, fetchImpl) {
  const result = await lineRequest(token, LIFF_API, { method: 'GET' }, fetchImpl, { allowNotFound: true });
  if (result.status === 404) return [];
  return Array.isArray(result.payload?.apps) ? result.payload.apps : [];
}

async function createLiffApp(token, payload, fetchImpl) {
  const result = await lineRequest(token, LIFF_API, {
    method: 'POST',
    body: JSON.stringify(payload)
  }, fetchImpl);
  if (!result.payload?.liffId) throw new Error('LINE LIFF Server API did not return liffId');
  return result.payload.liffId;
}

async function updateLiffApp(token, liffId, payload, fetchImpl) {
  await lineRequest(token, `${LIFF_API}/${encodeURIComponent(liffId)}`, {
    method: 'PUT',
    body: JSON.stringify(payload)
  }, fetchImpl);
  return liffId;
}

function updateConfig(config, { liffId, endpointHealth }) {
  const next = clone(config);
  next.integrations.line = {
    ...(next.integrations.line || {}),
    enabled: true,
    mode: 'liff',
    status: 'live',
    liffId,
    liffUrl: `https://liff.line.me/${liffId}`,
    endpointHealth,
    updatedAt: new Date().toISOString()
  };
  return next;
}

export async function provisionLine({
  root = process.cwd(),
  token = process.env.LINE_LIFF_CHANNEL_ACCESS_TOKEN,
  channelId = process.env.LINE_LOGIN_CHANNEL_ID,
  channelSecret = process.env.LINE_LOGIN_CHANNEL_SECRET,
  fetchImpl = fetch,
  dryRun = false,
  writeConfig = true
} = {}) {
  const configPath = path.join(root, CONFIG_PATH);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const line = config.integrations?.line || {};
  const endpoint = validateEndpointUrl(line.endpointUrl);
  const plan = {
    mode: line.mode || 'liff',
    operation: line.liffId ? 'update' : 'create',
    endpointReady: endpoint.ok,
    endpointReason: endpoint.ok ? 'configured' : endpoint.reason,
    credentialSource: token ? 'channel-access-token-secret' : channelId && channelSecret ? 'channel-id-secret-pair' : 'missing'
  };

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, plan }, null, 2));
    return { dryRun: true, plan };
  }

  const payload = buildLiffPayload(config);
  const endpointHealth = await checkEndpoint(payload.view.url, fetchImpl);
  if (!endpointHealth.ok) throw new Error(`LIFF endpoint is not publicly healthy: ${endpointHealth.reason}`);

  const accessToken = await resolveChannelAccessToken({ token, channelId, channelSecret, fetchImpl });
  let apps = await listLiffApps(accessToken, fetchImpl);
  let liffId = String(line.liffId || '').trim();

  if (liffId) {
    const existing = apps.find(app => app.liffId === liffId);
    if (!existing) {
      throw new Error('Configured liffId is not present on this LINE Login channel; refusing to create a duplicate');
    }
    await updateLiffApp(accessToken, liffId, payload, fetchImpl);
  } else {
    liffId = await createLiffApp(accessToken, payload, fetchImpl);
  }

  apps = await listLiffApps(accessToken, fetchImpl);
  const verified = apps.find(app => app.liffId === liffId);
  if (!verified) throw new Error('LIFF app was not visible after create/update verification');
  if (String(verified.view?.url || '') !== payload.view.url) {
    throw new Error('LIFF endpoint verification mismatch');
  }

  const nextConfig = updateConfig(config, { liffId, endpointHealth });
  if (writeConfig) fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);

  const result = {
    status: 'live',
    operation: plan.operation,
    liffId,
    liffUrl: `https://liff.line.me/${liffId}`,
    endpointUrl: payload.view.url,
    endpointHealth,
    plan
  };
  console.log(JSON.stringify(result, null, 2));
  return { ...result, config: nextConfig };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  provisionLine({ dryRun }).catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
