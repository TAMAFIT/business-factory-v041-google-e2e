import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPT_API = 'https://script.googleapis.com/v1';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const CONFIG_PATH = 'business.config.json';
const GAS_CODE_PATH = 'gas/Code.gs';
const GAS_MANIFEST_PATH = 'gas/appsscript.json';

export const REQUIRED_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/script.projects',
  'https://www.googleapis.com/auth/script.deployments'
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function validateProvisioningConfig(config) {
  if (!config?.business?.name) throw new Error('business.name is required');
  const booking = config.booking || {};
  if (!booking.timeZone) throw new Error('booking.timeZone is required');
  if (!Number.isFinite(Number(booking.slotDurationMinutes)) || Number(booking.slotDurationMinutes) <= 0) {
    throw new Error('booking.slotDurationMinutes must be positive');
  }
  if (!booking.weeklyHours || typeof booking.weeklyHours !== 'object') {
    throw new Error('booking.weeklyHours is required');
  }
  if (!Array.isArray(booking.menus) || booking.menus.length === 0) throw new Error('booking.menus is required');
  return config;
}

export function buildRuntimeConfig(config, calendarId) {
  validateProvisioningConfig(config);
  return {
    businessName: config.business.name,
    calendarId,
    timeZone: config.booking.timeZone,
    slotDurationMinutes: Number(config.booking.slotDurationMinutes),
    minLeadHours: Number(config.booking.minLeadHours || 0),
    weeklyHours: clone(config.booking.weeklyHours),
    menus: config.booking.menus.map(menu => ({
      id: String(menu.id),
      name: String(menu.name),
      durationMinutes: Number(menu.durationMinutes || config.booking.slotDurationMinutes)
    }))
  };
}

export function renderGasCode(template, runtimeConfig) {
  const token = '__BUSINESS_CONFIG_JSON__';
  if (!template.includes(token)) throw new Error(`GAS template is missing ${token}`);
  return template.replace(token, JSON.stringify(JSON.stringify(runtimeConfig)));
}

export function renderManifest(template, timeZone) {
  const rendered = template.replace('__TIME_ZONE__', String(timeZone));
  const manifest = JSON.parse(rendered);
  if (!manifest.webapp) throw new Error('GAS manifest must define webapp');
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function extractWebAppUrl(deployment) {
  const entry = (deployment?.entryPoints || []).find(item => item.entryPointType === 'WEB_APP' && item.webApp?.url);
  return entry?.webApp?.url || '';
}

export async function checkWebAppHealth(webAppUrl, fetchImpl = fetch, { attempts = 8, delayMs = 2000 } = {}) {
  if (!webAppUrl) return { ok: false, reason: 'no-webapp-url', status: null };
  const healthUrl = new URL(webAppUrl);
  healthUrl.searchParams.set('action', 'health');
  let lastStatus = null;
  let lastReason = 'unreachable';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(healthUrl, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache',
          'User-Agent': 'Business-Factory-Google-Provisioner'
        }
      });
      lastStatus = response.status;
      const text = await response.text();
      let payload = null;
      try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
      if (response.ok && payload?.ok === true && payload?.service === 'business-booking-gas') {
        return { ok: true, status: response.status, reason: 'healthy' };
      }
      lastReason = response.ok ? 'unexpected-response' : `http-${response.status}`;
    } catch (error) {
      lastReason = error?.message || String(error);
    }
    if (attempt < attempts && delayMs > 0) await sleep(delayMs);
  }

  return { ok: false, status: lastStatus, reason: lastReason };
}

async function googleRequest(token, url, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || text || response.statusText;
    const error = new Error(`Google API ${response.status}: ${message}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function ensureCalendar({ token, config, fetchImpl }) {
  const existingId = String(config.integrations?.googleCalendar?.calendarId || '').trim();
  if (existingId) {
    console.log(`REUSE calendar: ${existingId}`);
    return existingId;
  }

  const summary = config.integrations?.googleCalendar?.summary || `${config.business.name} 予約`;
  const calendar = await googleRequest(token, `${CALENDAR_API}/calendars`, {
    method: 'POST',
    body: JSON.stringify({
      summary,
      description: `Business Factory booking calendar for ${config.business.name}`,
      timeZone: config.booking.timeZone
    })
  }, fetchImpl);

  if (!calendar?.id) throw new Error('Calendar API did not return a calendar id');
  console.log(`CREATED calendar: ${calendar.id}`);
  return calendar.id;
}

async function ensureScriptProject({ token, config, fetchImpl }) {
  const existingId = String(config.integrations?.googleProvisioning?.scriptId || '').trim();
  if (existingId) {
    console.log(`REUSE Apps Script project: ${existingId}`);
    return existingId;
  }

  const title = config.integrations?.googleProvisioning?.scriptTitle || `${config.business.name} Booking API`;
  const project = await googleRequest(token, `${SCRIPT_API}/projects`, {
    method: 'POST',
    body: JSON.stringify({ title })
  }, fetchImpl);
  if (!project?.scriptId) throw new Error('Apps Script API did not return scriptId');
  console.log(`CREATED Apps Script project: ${project.scriptId}`);
  return project.scriptId;
}

async function uploadScriptContent({ token, scriptId, gasCode, manifest, fetchImpl }) {
  await googleRequest(token, `${SCRIPT_API}/projects/${encodeURIComponent(scriptId)}/content`, {
    method: 'PUT',
    body: JSON.stringify({
      files: [
        { name: 'Code', type: 'SERVER_JS', source: gasCode },
        { name: 'appsscript', type: 'JSON', source: manifest }
      ]
    })
  }, fetchImpl);
  console.log(`UPDATED Apps Script content: ${scriptId}`);
}

async function createVersion({ token, scriptId, fetchImpl }) {
  const version = await googleRequest(token, `${SCRIPT_API}/projects/${encodeURIComponent(scriptId)}/versions`, {
    method: 'POST',
    body: JSON.stringify({ description: `Business Factory ${new Date().toISOString()}` })
  }, fetchImpl);
  if (!Number.isInteger(version?.versionNumber)) throw new Error('Apps Script API did not return versionNumber');
  console.log(`CREATED Apps Script version: ${version.versionNumber}`);
  return version.versionNumber;
}

async function ensureDeployment({ token, config, scriptId, versionNumber, fetchImpl }) {
  const existingId = String(config.integrations?.googleProvisioning?.deploymentId || '').trim();
  const description = config.integrations?.googleProvisioning?.deploymentDescription || 'Business Factory booking web app';

  if (existingId) {
    const deployment = await googleRequest(
      token,
      `${SCRIPT_API}/projects/${encodeURIComponent(scriptId)}/deployments/${encodeURIComponent(existingId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          deploymentConfig: {
            scriptId,
            versionNumber,
            manifestFileName: 'appsscript',
            description
          }
        })
      },
      fetchImpl
    );
    console.log(`UPDATED deployment: ${existingId}`);
    return deployment;
  }

  const deployment = await googleRequest(token, `${SCRIPT_API}/projects/${encodeURIComponent(scriptId)}/deployments`, {
    method: 'POST',
    body: JSON.stringify({
      versionNumber,
      manifestFileName: 'appsscript',
      description
    })
  }, fetchImpl);
  if (!deployment?.deploymentId) throw new Error('Apps Script API did not return deploymentId');
  console.log(`CREATED deployment: ${deployment.deploymentId}`);
  return deployment;
}

function updateConfig(config, { calendarId, scriptId, deploymentId, webAppUrl, health }) {
  const next = clone(config);
  const live = Boolean(webAppUrl && health?.ok);
  next.integrations = next.integrations || {};
  next.integrations.googleCalendar = {
    ...(next.integrations.googleCalendar || {}),
    enabled: true,
    calendarId
  };
  next.integrations.bookingApi = {
    ...(next.integrations.bookingApi || {}),
    enabled: live,
    provider: 'gas',
    baseUrl: webAppUrl,
    availabilityParam: next.integrations.bookingApi?.availabilityParam || 'date',
    availabilityResponseKey: next.integrations.bookingApi?.availabilityResponseKey || 'availableSlots'
  };
  next.integrations.googleProvisioning = {
    ...(next.integrations.googleProvisioning || {}),
    scriptId,
    deploymentId,
    webAppUrl,
    status: live ? 'live' : webAppUrl ? 'authorization-required' : 'deployment-created',
    healthcheck: {
      ok: Boolean(health?.ok),
      status: health?.status ?? null,
      reason: health?.reason || 'not-checked'
    },
    updatedAt: new Date().toISOString()
  };
  next.development = { ...(next.development || {}), mockMode: !live };
  return next;
}

export async function provisionGoogle({
  root = process.cwd(),
  token = process.env.GOOGLE_ACCESS_TOKEN,
  fetchImpl = fetch,
  dryRun = false,
  writeConfig = true,
  healthcheckOptions
} = {}) {
  const configPath = path.join(root, CONFIG_PATH);
  const codePath = path.join(root, GAS_CODE_PATH);
  const manifestPath = path.join(root, GAS_MANIFEST_PATH);
  const config = validateProvisioningConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  const plan = {
    calendar: config.integrations?.googleCalendar?.calendarId ? 'reuse' : 'create',
    script: config.integrations?.googleProvisioning?.scriptId ? 'reuse' : 'create',
    deployment: config.integrations?.googleProvisioning?.deploymentId ? 'update' : 'create',
    requiredScopes: REQUIRED_GOOGLE_SCOPES
  };

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, plan }, null, 2));
    return { dryRun: true, plan };
  }
  if (!token) throw new Error('GOOGLE_ACCESS_TOKEN is required. Do not store access tokens in git.');

  const calendarId = await ensureCalendar({ token, config, fetchImpl });
  const scriptId = await ensureScriptProject({ token, config, fetchImpl });
  const runtime = buildRuntimeConfig(config, calendarId);
  const gasCode = renderGasCode(fs.readFileSync(codePath, 'utf8'), runtime);
  const manifest = renderManifest(fs.readFileSync(manifestPath, 'utf8'), config.booking.timeZone);

  await uploadScriptContent({ token, scriptId, gasCode, manifest, fetchImpl });
  const versionNumber = await createVersion({ token, scriptId, fetchImpl });
  const deployment = await ensureDeployment({ token, config, scriptId, versionNumber, fetchImpl });
  const deploymentId = deployment.deploymentId || config.integrations?.googleProvisioning?.deploymentId || '';
  const webAppUrl = extractWebAppUrl(deployment);
  const health = await checkWebAppHealth(webAppUrl, fetchImpl, healthcheckOptions);
  const nextConfig = updateConfig(config, { calendarId, scriptId, deploymentId, webAppUrl, health });

  if (writeConfig) fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  const result = {
    calendarId,
    scriptId,
    deploymentId,
    webAppUrl,
    health,
    authorizationStatus: health.ok ? 'authorized-live' : webAppUrl ? 'authorization-required' : 'deployment-created-no-webapp-url',
    plan
  };
  console.log(JSON.stringify(result, null, 2));
  return { ...result, config: nextConfig };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run');
  provisionGoogle({ dryRun }).catch(error => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}
