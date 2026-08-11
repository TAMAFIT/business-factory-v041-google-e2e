import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REQUIRED_GOOGLE_SCOPES,
  buildRuntimeConfig,
  checkWebAppHealth,
  extractWebAppUrl,
  provisionGoogle,
  renderGasCode,
  renderManifest,
  validateProvisioningConfig
} from '../scripts/google-provision.mjs';

const sampleConfig = {
  version: 1,
  business: { name: 'Test Studio' },
  booking: {
    timeZone: 'Asia/Tokyo',
    slotDurationMinutes: 60,
    minLeadHours: 2,
    weeklyHours: {
      '0': [],
      '1': [{ start: '10:00', end: '20:00' }],
      '2': [{ start: '10:00', end: '20:00' }],
      '3': [{ start: '10:00', end: '20:00' }],
      '4': [{ start: '10:00', end: '20:00' }],
      '5': [{ start: '10:00', end: '20:00' }],
      '6': []
    },
    menus: [{ id: 'trial', name: 'Trial', durationMinutes: 60 }]
  },
  integrations: {
    bookingApi: { enabled: false, provider: 'gas', baseUrl: '', availabilityParam: 'date', availabilityResponseKey: 'availableSlots' },
    googleCalendar: { enabled: false, calendarId: '', summary: 'Test Studio Reservations' },
    googleProvisioning: { status: 'not-provisioned', scriptId: '', deploymentId: '', webAppUrl: '' }
  },
  development: { mockMode: true, mockSlots: ['10:00'] }
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('required Google scopes cover Calendar, project and deployment management', () => {
  assert.ok(REQUIRED_GOOGLE_SCOPES.includes('https://www.googleapis.com/auth/calendar'));
  assert.ok(REQUIRED_GOOGLE_SCOPES.includes('https://www.googleapis.com/auth/script.projects'));
  assert.ok(REQUIRED_GOOGLE_SCOPES.includes('https://www.googleapis.com/auth/script.deployments'));
});

test('runtime config and GAS templates render without credentials', () => {
  validateProvisioningConfig(sampleConfig);
  const runtime = buildRuntimeConfig(sampleConfig, 'calendar-id@example.com');
  assert.equal(runtime.calendarId, 'calendar-id@example.com');
  assert.equal(runtime.timeZone, 'Asia/Tokyo');

  const code = renderGasCode('const CONFIG = JSON.parse(__BUSINESS_CONFIG_JSON__);', runtime);
  assert.equal(code.includes('__BUSINESS_CONFIG_JSON__'), false);
  assert.ok(code.includes('calendar-id@example.com'));

  const manifest = renderManifest('{"timeZone":"__TIME_ZONE__","webapp":{"access":"ANYONE_ANONYMOUS","executeAs":"USER_DEPLOYING"}}', 'Asia/Tokyo');
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.timeZone, 'Asia/Tokyo');
  assert.equal(parsed.webapp.access, 'ANYONE_ANONYMOUS');
});

test('extractWebAppUrl selects WEB_APP entry point', () => {
  const url = extractWebAppUrl({
    entryPoints: [
      { entryPointType: 'EXECUTION_API', executionApi: {} },
      { entryPointType: 'WEB_APP', webApp: { url: 'https://script.google.com/macros/s/test/exec' } }
    ]
  });
  assert.equal(url, 'https://script.google.com/macros/s/test/exec');
});

test('healthcheck requires expected public JSON response', async () => {
  const healthy = await checkWebAppHealth(
    'https://script.google.com/macros/s/test/exec',
    async () => jsonResponse({ ok: true, service: 'business-booking-gas' }),
    { attempts: 1, delayMs: 0 }
  );
  assert.equal(healthy.ok, true);

  const loginPage = await checkWebAppHealth(
    'https://script.google.com/macros/s/test/exec',
    async () => new Response('<html>authorization required</html>', { status: 200 }),
    { attempts: 1, delayMs: 0 }
  );
  assert.equal(loginPage.ok, false);
  assert.equal(loginPage.reason, 'unexpected-response');
});

test('dry-run requires no token and makes no writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-google-dry-'));
  fs.writeFileSync(path.join(root, 'business.config.json'), JSON.stringify(sampleConfig, null, 2));
  const before = fs.readFileSync(path.join(root, 'business.config.json'), 'utf8');
  const result = await provisionGoogle({ root, dryRun: true });
  const after = fs.readFileSync(path.join(root, 'business.config.json'), 'utf8');
  assert.equal(result.plan.calendar, 'create');
  assert.equal(result.plan.script, 'create');
  assert.equal(result.plan.deployment, 'create');
  assert.equal(before, after);
});

test('provisioner enables live API only after public healthcheck succeeds', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-google-live-'));
  fs.mkdirSync(path.join(root, 'gas'));
  fs.writeFileSync(path.join(root, 'business.config.json'), JSON.stringify(sampleConfig, null, 2));
  fs.writeFileSync(path.join(root, 'gas/Code.gs'), 'const CONFIG = JSON.parse(__BUSINESS_CONFIG_JSON__);');
  fs.writeFileSync(path.join(root, 'gas/appsscript.json'), '{"timeZone":"__TIME_ZONE__","webapp":{"access":"ANYONE_ANONYMOUS","executeAs":"USER_DEPLOYING"}}');

  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET', headers: options.headers, body: options.body });
    if (String(url).includes('script.google.com/macros/s/test/exec')) {
      return jsonResponse({ ok: true, service: 'business-booking-gas' });
    }
    if (String(url).endsWith('/calendar/v3/calendars')) return jsonResponse({ id: 'calendar-test-id' });
    if (String(url).endsWith('/v1/projects') && options.method === 'POST') return jsonResponse({ scriptId: 'script-test-id' });
    if (String(url).includes('/content') && options.method === 'PUT') return jsonResponse({});
    if (String(url).endsWith('/versions') && options.method === 'POST') return jsonResponse({ versionNumber: 7 });
    if (String(url).endsWith('/deployments') && options.method === 'POST') {
      return jsonResponse({
        deploymentId: 'deployment-test-id',
        entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: 'https://script.google.com/macros/s/test/exec' } }]
      });
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  };

  const result = await provisionGoogle({
    root,
    token: 'short-lived-test-token',
    fetchImpl: fakeFetch,
    healthcheckOptions: { attempts: 1, delayMs: 0 }
  });
  assert.equal(result.authorizationStatus, 'authorized-live');
  assert.equal(result.health.ok, true);

  const written = JSON.parse(fs.readFileSync(path.join(root, 'business.config.json'), 'utf8'));
  assert.equal(written.integrations.googleCalendar.enabled, true);
  assert.equal(written.integrations.googleCalendar.calendarId, 'calendar-test-id');
  assert.equal(written.integrations.bookingApi.enabled, true);
  assert.equal(written.integrations.bookingApi.baseUrl, 'https://script.google.com/macros/s/test/exec');
  assert.equal(written.integrations.googleProvisioning.scriptId, 'script-test-id');
  assert.equal(written.integrations.googleProvisioning.deploymentId, 'deployment-test-id');
  assert.equal(written.integrations.googleProvisioning.status, 'live');
  assert.equal(written.development.mockMode, false);
  const googleApiCalls = calls.filter(call => !call.url.includes('script.google.com/macros/s/test/exec'));
  assert.ok(googleApiCalls.every(call => call.headers.Authorization === 'Bearer short-lived-test-token'));
  assert.equal(JSON.stringify(written).includes('short-lived-test-token'), false);
});

test('unhealthy or authorization-gated web app stays in mock mode', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'business-google-auth-'));
  fs.mkdirSync(path.join(root, 'gas'));
  fs.writeFileSync(path.join(root, 'business.config.json'), JSON.stringify(sampleConfig, null, 2));
  fs.writeFileSync(path.join(root, 'gas/Code.gs'), 'const CONFIG = JSON.parse(__BUSINESS_CONFIG_JSON__);');
  fs.writeFileSync(path.join(root, 'gas/appsscript.json'), '{"timeZone":"__TIME_ZONE__","webapp":{"access":"ANYONE_ANONYMOUS","executeAs":"USER_DEPLOYING"}}');

  const fakeFetch = async (url, options = {}) => {
    if (String(url).includes('script.google.com/macros/s/test/exec')) {
      return new Response('<html>authorization required</html>', { status: 200 });
    }
    if (String(url).endsWith('/calendar/v3/calendars')) return jsonResponse({ id: 'calendar-test-id' });
    if (String(url).endsWith('/v1/projects') && options.method === 'POST') return jsonResponse({ scriptId: 'script-test-id' });
    if (String(url).includes('/content') && options.method === 'PUT') return jsonResponse({});
    if (String(url).endsWith('/versions') && options.method === 'POST') return jsonResponse({ versionNumber: 7 });
    if (String(url).endsWith('/deployments') && options.method === 'POST') {
      return jsonResponse({
        deploymentId: 'deployment-test-id',
        entryPoints: [{ entryPointType: 'WEB_APP', webApp: { url: 'https://script.google.com/macros/s/test/exec' } }]
      });
    }
    throw new Error(`Unexpected request: ${options.method || 'GET'} ${url}`);
  };

  const result = await provisionGoogle({
    root,
    token: 'short-lived-test-token',
    fetchImpl: fakeFetch,
    healthcheckOptions: { attempts: 1, delayMs: 0 }
  });
  const written = JSON.parse(fs.readFileSync(path.join(root, 'business.config.json'), 'utf8'));
  assert.equal(result.authorizationStatus, 'authorization-required');
  assert.equal(result.health.ok, false);
  assert.equal(written.integrations.bookingApi.enabled, false);
  assert.equal(written.integrations.googleProvisioning.status, 'authorization-required');
  assert.equal(written.development.mockMode, true);
});
