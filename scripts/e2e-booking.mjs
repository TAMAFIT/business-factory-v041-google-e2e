import fs from 'node:fs';

const config = JSON.parse(fs.readFileSync('business.config.json', 'utf8'));
const apiUrl = String(config.integrations?.bookingApi?.baseUrl || '').trim();
const timeZone = config.booking?.timeZone || 'Asia/Tokyo';
const daysVisible = Number(config.booking?.daysVisible || 14);

if (!config.integrations?.bookingApi?.enabled || config.development?.mockMode || !apiUrl) {
  throw new Error('Booking API is not live; refusing to create a real E2E booking.');
}

function dateInTimeZone(offsetDays) {
  const now = new Date();
  const shifted = new Date(now.getTime() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(shifted);
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Expected JSON from booking API, got HTTP ${response.status}`); }
  if (!response.ok) throw new Error(`Booking API HTTP ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

let selected = null;
for (let offset = 1; offset <= daysVisible; offset += 1) {
  const date = dateInTimeZone(offset);
  const url = new URL(apiUrl);
  url.searchParams.set(config.integrations.bookingApi.availabilityParam || 'date', date);
  const result = await jsonFetch(url);
  const slots = result?.[config.integrations.bookingApi.availabilityResponseKey || 'availableSlots'];
  if (Array.isArray(slots) && slots.length) {
    selected = { date, time: slots[0] };
    break;
  }
}

if (!selected) throw new Error(`No available slot found in the next ${daysVisible} days.`);

const marker = `Business Factory E2E ${Date.now()}`;
const menu = config.booking.menus[0];
const staff = config.booking.staff[0];
const payload = {
  type: config.booking.type || 'trial',
  menuId: menu.id,
  staffId: staff.id,
  date: selected.date,
  time: selected.time,
  name: marker,
  kana: 'E2E TEST',
  email: 'e2e@example.invalid',
  phone: '0000000000',
  source: 'business-factory-e2e'
};

const result = await jsonFetch(apiUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain;charset=utf-8' },
  body: JSON.stringify(payload)
});

if (result?.success !== true || !result?.bookingId) {
  throw new Error(`Booking API rejected E2E booking: ${JSON.stringify(result)}`);
}

const output = {
  ok: true,
  marker,
  bookingId: result.bookingId,
  date: selected.date,
  time: selected.time,
  menuName: menu.name,
  calendarId: config.integrations.googleCalendar.calendarId
};

fs.writeFileSync('.e2e-booking-result.json', `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
