export async function loadBusinessConfig(url = './business.config.json') {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`business.config.json load failed: ${response.status}`);
  const config = await response.json();
  validateBusinessConfig(config);
  applyTheme(config.theme || {});
  return config;
}

export function validateBusinessConfig(config) {
  if (!config || typeof config !== 'object') throw new Error('config must be an object');
  if (config.version !== 1) throw new Error('unsupported config version');
  if (!config.business?.name) throw new Error('business.name is required');
  if (!config.booking?.timeZone) throw new Error('booking.timeZone is required');
  if (!config.booking?.weeklyHours || typeof config.booking.weeklyHours !== 'object') throw new Error('booking.weeklyHours is required');
  if (!Array.isArray(config.booking?.menus) || config.booking.menus.length === 0) throw new Error('booking.menus is required');
  if (!Array.isArray(config.booking?.staff) || config.booking.staff.length === 0) throw new Error('booking.staff is required');

  const api = config.integrations?.bookingApi;
  if (api?.enabled && !api.baseUrl) throw new Error('bookingApi.baseUrl is required when enabled');

  const calendar = config.integrations?.googleCalendar;
  if (calendar?.enabled && !calendar.calendarId) throw new Error('googleCalendar.calendarId is required when enabled');

  const line = config.integrations?.line;
  if (line?.enabled) {
    if (line.mode !== 'liff') throw new Error('line.mode must be liff when enabled');
    if (!line.liffId) throw new Error('line.liffId is required when enabled');
    if (!line.liffUrl) throw new Error('line.liffUrl is required when enabled');
    if (!line.endpointUrl) throw new Error('line.endpointUrl is required when enabled');
  }

  return config;
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme.accent) root.style.setProperty('--accent', theme.accent);
  if (theme.accentDark) root.style.setProperty('--accent-dark', theme.accentDark);
}
