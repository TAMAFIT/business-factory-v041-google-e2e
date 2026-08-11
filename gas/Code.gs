const CONFIG = JSON.parse(__BUSINESS_CONFIG_JSON__);

function json_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function parseLocal_(date, time) {
  return Utilities.parseDate(`${date} ${time}`, CONFIG.timeZone, 'yyyy-MM-dd HH:mm');
}

function weekdayKey_(date) {
  const midnight = parseLocal_(date, '00:00');
  return String(midnight.getDay());
}

function getCalendar_() {
  const calendar = CalendarApp.getCalendarById(CONFIG.calendarId);
  if (!calendar) throw new Error('Configured calendar is not accessible');
  return calendar;
}

function authorizeCalendar() {
  const calendar = getCalendar_();
  return {
    calendarId: CONFIG.calendarId,
    calendarName: calendar.getName()
  };
}

function getMenu_(menuId) {
  return CONFIG.menus.find(menu => menu.id === menuId) || CONFIG.menus[0];
}

function overlaps_(calendar, start, end) {
  return calendar.getEvents(start, end).length > 0;
}

function availableSlotsForDate_(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return [];
  const windows = CONFIG.weeklyHours[weekdayKey_(date)] || [];
  if (!windows.length) return [];

  const calendar = getCalendar_();
  const now = new Date();
  const earliest = new Date(now.getTime() + CONFIG.minLeadHours * 60 * 60 * 1000);
  const slots = [];

  windows.forEach(window => {
    let cursor = parseLocal_(date, window.start);
    const windowEnd = parseLocal_(date, window.end);

    while (cursor.getTime() + CONFIG.slotDurationMinutes * 60000 <= windowEnd.getTime()) {
      const end = new Date(cursor.getTime() + CONFIG.slotDurationMinutes * 60000);
      if (cursor >= earliest && !overlaps_(calendar, cursor, end)) {
        slots.push(Utilities.formatDate(cursor, CONFIG.timeZone, 'HH:mm'));
      }
      cursor = new Date(cursor.getTime() + CONFIG.slotDurationMinutes * 60000);
    }
  });

  return slots;
}

function doGet(e) {
  try {
    const params = (e && e.parameter) || {};
    if (params.action === 'health') {
      const calendar = getCalendar_();
      return json_({
        ok: true,
        service: 'business-booking-gas',
        business: CONFIG.businessName,
        calendarAccessible: true,
        calendarName: calendar.getName()
      });
    }
    return json_({ success: true, availableSlots: availableSlotsForDate_(params.date || '') });
  } catch (error) {
    return json_({ success: false, ok: false, message: String(error && error.message || error) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    if (!lock.tryLock(10000)) return json_({ success: false, message: 'Booking service is busy. Please retry.' });
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const name = String(payload.name || '').trim();
    const date = String(payload.date || '').trim();
    const time = String(payload.time || '').trim();
    const menu = getMenu_(String(payload.menuId || ''));

    if (!name || !date || !time || !menu) {
      return json_({ success: false, message: 'Missing required booking fields' });
    }

    const available = availableSlotsForDate_(date);
    if (!available.includes(time)) {
      return json_({ success: false, message: 'Selected slot is no longer available' });
    }

    const calendar = getCalendar_();
    const start = parseLocal_(date, time);
    const duration = Number(menu.durationMinutes || CONFIG.slotDurationMinutes);
    const end = new Date(start.getTime() + duration * 60000);

    if (overlaps_(calendar, start, end)) {
      return json_({ success: false, message: 'Selected slot is no longer available' });
    }

    const details = [
      `予約種別: ${payload.type || ''}`,
      `メニュー: ${menu.name}`,
      `担当: ${payload.staffId || ''}`,
      `氏名: ${name}`,
      `フリガナ: ${payload.kana || ''}`,
      `メール: ${payload.email || ''}`,
      `電話: ${payload.phone || ''}`,
      `流入: ${payload.source || ''}`
    ].join('\n');

    const event = calendar.createEvent(`【予約】${name} - ${menu.name}`, start, end, {
      description: details
    });

    return json_({ success: true, bookingId: event.getId() });
  } catch (error) {
    return json_({ success: false, message: String(error && error.message || error) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}
