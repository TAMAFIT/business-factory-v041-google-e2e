import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync(new URL('../business.config.json', import.meta.url), 'utf8'));

test('business config has required v0.3 structure', () => {
  assert.equal(config.version, 1);
  assert.ok(config.business.name);
  assert.ok(Array.isArray(config.booking.menus) && config.booking.menus.length > 0);
  assert.ok(Array.isArray(config.booking.staff) && config.booking.staff.length > 0);
  assert.ok(config.integrations.line);
  assert.equal(config.integrations.line.mode, 'liff');
});

test('Google integration state is safe across provisioning lifecycle', () => {
  const status = config.integrations.googleProvisioning?.status || 'not-provisioned';

  if (status === 'not-provisioned') {
    assert.equal(config.integrations.bookingApi.enabled, false);
    assert.equal(config.integrations.bookingApi.baseUrl, '');
    assert.equal(config.integrations.googleCalendar.enabled, false);
    assert.equal(config.development.mockMode, true);
  } else if (status === 'authorization-required') {
    assert.equal(config.integrations.bookingApi.enabled, false);
    assert.ok(config.integrations.bookingApi.baseUrl.startsWith('https://script.google.com/macros/s/'));
    assert.equal(config.integrations.googleCalendar.enabled, true);
    assert.ok(config.integrations.googleCalendar.calendarId);
    assert.equal(config.development.mockMode, true);
  } else if (status === 'live') {
    assert.equal(config.integrations.bookingApi.enabled, true);
    assert.ok(config.integrations.bookingApi.baseUrl.startsWith('https://script.google.com/macros/s/'));
    assert.equal(config.integrations.googleCalendar.enabled, true);
    assert.ok(config.integrations.googleCalendar.calendarId);
    assert.equal(config.development.mockMode, false);
  } else {
    assert.fail(`unsupported Google provisioning status: ${status}`);
  }

  assert.equal(config.integrations.analytics.enabled, false);
});

test('LINE integration state is safe across provisioning lifecycle', () => {
  const line = config.integrations.line;
  const status = line.status || 'not-provisioned';

  if (status === 'not-provisioned') {
    assert.equal(line.enabled, false);
    assert.equal(line.liffId, '');
    assert.equal(line.liffUrl, '');
  } else if (status === 'live') {
    assert.equal(line.enabled, true);
    assert.ok(line.liffId);
    assert.equal(line.liffUrl, `https://liff.line.me/${line.liffId}`);
    assert.ok(line.endpointUrl.startsWith('https://'));
    assert.equal(line.endpointUrl.includes('#'), false);
  } else {
    assert.fail(`unsupported LINE provisioning status: ${status}`);
  }
});

test('template does not contain TAMAFIT production identifiers or LINE credentials', () => {
  const raw = JSON.stringify(config);
  const forbidden = [
    'tamafit.takamatsu@gmail.com',
    'AKfycbwk--BBlH7rg_VF9WDfqlvcmloBydipwdK60CVEk1fvPunvSTvR5IkbMxNbyHhmSDuS',
    'lin.ee/ypLygRb',
    'AW-18078211726',
    'LINE_LOGIN_CHANNEL_SECRET',
    'LINE_LIFF_CHANNEL_ACCESS_TOKEN'
  ];
  for (const value of forbidden) {
    assert.equal(raw.includes(value), false, `production/secret value leaked: ${value}`);
  }
});
