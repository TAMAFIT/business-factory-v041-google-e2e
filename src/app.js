import { loadBusinessConfig } from './config.js';
import { createBookingApi } from './api.js';
import { bookingSource, initializeLine, prefillFromLineProfile } from './line.js';

const $ = selector => document.querySelector(selector);

function option(value, label) {
  const node = document.createElement('option');
  node.value = value;
  node.textContent = label;
  return node;
}

function populateSelect(select, items, placeholder) {
  select.innerHTML = '';
  select.append(option('', placeholder));
  for (const item of items) select.append(option(item.id, item.name));
}

function renderContact(config) {
  const business = config.business;
  $('#address').textContent = business.address || '住所未設定';
  const actions = $('#contactActions');
  actions.innerHTML = '';
  const links = [
    ['LINE', business.lineUrl || config.integrations.line.friendUrl],
    ['地図', business.mapsUrl],
    ['メール', business.email ? `mailto:${business.email}` : '']
  ].filter(([, href]) => href);
  for (const [label, href] of links) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    if (!href.startsWith('mailto:')) { a.target = '_blank'; a.rel = 'noopener'; }
    actions.append(a);
  }
}

function renderBusiness(config, api, lineContext) {
  const { business, booking, copy } = config;
  document.title = `${business.name}｜予約`;
  $('#businessName').textContent = business.name;
  $('#businessType').textContent = business.typeLabel || 'BOOKING';
  $('#headline').textContent = copy?.headline || '空き状況を確認して予約できます。';
  const meta = $('#businessMeta');
  meta.innerHTML = '';
  const badges = [
    `${booking.slotDurationMinutes}分枠`,
    `${booking.daysVisible}日先まで`,
    api.isMock ? 'デモモード' : '予約API接続済み'
  ];
  if (lineContext?.ready) badges.push(lineContext.inClient ? 'LINE内で起動中' : 'LIFF接続済み');
  for (const text of badges) {
    const span = document.createElement('span');
    span.textContent = text;
    meta.append(span);
  }
  const status = $('#connectionStatus');
  status.textContent = api.isMock ? 'モック動作中' : 'API接続済み';
  if (!api.isMock) status.classList.add('live');
  renderContact(config);
}

function minBookingDate(minLeadHours = 0) {
  const date = new Date(Date.now() + minLeadHours * 3600000);
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

async function main() {
  const app = $('#app');
  const form = $('#bookingForm');
  const dateInput = $('#date');
  const timeSelect = $('#time');
  const message = $('#formMessage');
  const submit = $('#submitButton');

  try {
    const config = await loadBusinessConfig();
    const api = createBookingApi(config);
    const lineContext = await initializeLine(config);
    renderBusiness(config, api, lineContext);
    populateSelect($('#menu'), config.booking.menus, 'メニューを選択');
    populateSelect($('#staff'), config.booking.staff, '担当を選択');
    dateInput.min = minBookingDate(config.booking.minLeadHours || 0);
    prefillFromLineProfile(form, lineContext);

    dateInput.addEventListener('change', async () => {
      timeSelect.disabled = true;
      timeSelect.innerHTML = '<option value="">空き状況を確認中...</option>';
      message.textContent = '';
      try {
        const slots = await api.getAvailability(dateInput.value);
        timeSelect.innerHTML = '';
        timeSelect.append(option('', slots.length ? '時間を選択' : '空き枠なし'));
        for (const slot of slots) timeSelect.append(option(slot, slot));
        timeSelect.disabled = slots.length === 0;
      } catch (error) {
        timeSelect.innerHTML = '<option value="">取得に失敗しました</option>';
        message.className = 'form-message error';
        message.textContent = '空き状況を取得できませんでした。設定またはAPIを確認してください。';
        console.error(error);
      }
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      message.className = 'form-message';
      message.textContent = '送信中です...';
      const data = new FormData(form);
      const payload = {
        type: config.booking.type,
        menuId: data.get('menu'),
        staffId: data.get('staff'),
        date: data.get('date'),
        time: data.get('time'),
        name: String(data.get('name') || '').trim(),
        kana: String(data.get('kana') || '').trim(),
        email: String(data.get('email') || '').trim(),
        phone: String(data.get('phone') || '').trim(),
        source: bookingSource(lineContext)
      };
      try {
        const result = await api.submitBooking(payload);
        if (result?.success === false) throw new Error(result.message || 'booking rejected');
        message.className = 'form-message success';
        message.textContent = api.isMock
          ? 'モック予約を受け付けました。本番データは送信されていません。'
          : '予約を受け付けました。';
        if (api.isMock) console.info('Mock booking payload', payload);
      } catch (error) {
        message.className = 'form-message error';
        message.textContent = '予約送信に失敗しました。時間を置いて再度お試しください。';
        console.error(error);
      } finally {
        submit.disabled = false;
      }
    });

    app.setAttribute('aria-busy', 'false');
  } catch (error) {
    app.innerHTML = '<section class="card hero"><h1>設定エラー</h1><p class="lead">business.config.jsonを確認してください。</p></section>';
    app.setAttribute('aria-busy', 'false');
    console.error(error);
  }
}

main();
