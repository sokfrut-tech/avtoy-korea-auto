// AVTOY KOREA Admin Pro — Modern Web Dashboard (/admin) + Interactive Bot Control Panel (/panel) with Cars, Reviews, News & Orders.
import { cleanCarDisplayCaption, isMarketNewsRecord, parseNewsCardData, parseVehicleCardData } from "./catalog-formatter.js";

export const ADMIN_PRO_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export const ADMIN_PRO_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>AVTOY KOREA — Центр управления сайтом</title>
<style>
:root{color-scheme:dark;--bg:#070b12;--panel:#101723;--panel2:#162031;--line:#263348;--text:#f3f6fc;--muted:#93a3b8;--red:#f12f38;--green:#22c55e;--amber:#f59e0b;--blue:#3b82f6}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(ellipse at 20% 0,#17253a 0,transparent 42%),var(--bg);color:var(--text);font:14px/1.5 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:min(1280px,calc(100% - 28px));margin:0 auto;padding:22px 0 64px}
.topbar{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-bottom:18px;border-bottom:1px solid var(--line);margin-bottom:22px}
.brand{display:flex;align-items:center;gap:12px}
.brand-badge{background:var(--red);color:#fff;font-weight:900;padding:7px 11px;border-radius:10px;letter-spacing:.08em;font-size:13px}
h1{font-size:clamp(20px,3vw,26px);margin:0;line-height:1.15}
.muted{color:var(--muted);margin:3px 0 0;font-size:13px}
button{border:0;border-radius:11px;padding:10px 15px;font:700 13px inherit;cursor:pointer;background:var(--red);color:#fff;display:inline-flex;align-items:center;justify-content:center;gap:7px;transition:opacity .15s,transform .12s}
button:hover:not(:disabled){opacity:.92;transform:translateY(-1px)}
button:disabled{opacity:.5;cursor:wait}
button.sec{background:var(--panel2);color:var(--text);border:1px solid var(--line)}
button.ok{background:#15803d;color:#fff}
button.danger{background:#4c1d24;color:#fecdd3;border:1px solid #881337}
button.sm{padding:6px 10px;font-size:12px;border-radius:8px}
input,textarea,select{width:100%;border:1px solid var(--line);background:#090f19;color:var(--text);border-radius:11px;padding:11px 13px;font:inherit}
textarea{min-height:145px;resize:vertical;line-height:1.5}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--red);box-shadow:0 0 0 3px #f12f3825}
.panel{background:linear-gradient(160deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 16px 40px #0004}
#login{max-width:460px;margin:7vh auto 0}
.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-bottom:18px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
.stat b{display:block;font-size:24px;line-height:1.1;margin-top:4px}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
.tab{background:var(--panel);border:1px solid var(--line);color:var(--muted);padding:10px 16px;border-radius:999px;font-weight:700}
.tab.active{background:var(--red);border-color:var(--red);color:#fff}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:16px}
.toolbar input{max-width:340px}
.status-bar{min-height:22px;margin:0 0 14px;padding:10px 14px;border-radius:11px;background:#111c2d;border:1px solid var(--line);display:none}
.status-bar.show{display:block}
.status-bar.error{background:#35151a;border-color:#7f1d1d;color:#fecaca}
.status-bar.ok{background:#0f291e;border-color:#14532d;color:#bbf7d0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(370px,1fr));gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px;display:flex;flex-direction:column;gap:12px}
.card-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}
.card-title{font-weight:800;font-size:16px;margin:0}
.badge{display:inline-block;padding:3px 9px;border-radius:999px;font-size:11px;font-weight:800;background:#1e293b;color:#cbd5e1;white-space:nowrap}
.badge.price{background:#14532d;color:#86efac}
.badge.news{background:#1e3a8a;color:#bfdbfe}
.badge.new{background:#7c2d12;color:#fed7aa}
.badge.work{background:#1e3a8a;color:#bfdbfe}
.badge.done{background:#1f2937;color:#9ca3af}
.thumbs{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px}
.thumb{position:relative;flex:0 0 108px;height:78px;border-radius:10px;overflow:hidden;background:#05080d;border:1px solid var(--line)}
.thumb img,.thumb video{width:100%;height:100%;object-fit:cover;display:block}
.thumb-bar{position:absolute;inset:auto 0 0 0;display:flex;justify-content:space-between;padding:3px;background:linear-gradient(transparent,#000d)}
.thumb-btn{padding:2px 6px;font-size:10px;border-radius:5px;background:#1e293b;color:#fff}
.thumb-btn.cover{background:#ca8a04}
.thumb-btn.del{background:#991b1b}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto}
.order-row{display:grid;grid-template-columns:1.2fr 1fr 1.2fr auto;gap:12px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:10px}
.composer{margin-bottom:18px;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px}
[hidden]{display:none!important}
@media(max-width:900px){.stats{grid-template-columns:repeat(2,1fr)}}
@media(max-width:780px){.grid{grid-template-columns:1fr}.order-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<main>
  <header class="topbar">
    <div class="brand">
      <span class="brand-badge">AVTOY</span>
      <div>
        <h1>Центр управления AVTOY KOREA</h1>
        <p class="muted">Автомобили · Новости · Отзывы · Модерация · Заявки клиентов</p>
      </div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <a href="/" target="_blank" style="color:#93c5fd;text-decoration:none;font-weight:700;font-size:13px;margin-right:8px">Открыть сайт ↗</a>
      <button id="refresh-btn" class="sec" hidden>↻ Обновить</button>
      <button id="sync-tg-btn" class="sec" hidden title="Проверить @avtoYkorea и подтянуть новые авто без дублей">📥 Синхронизировать @avtoYkorea</button>
      <button id="sync-mirror-btn" class="sec" hidden title="Запустить облачное обновление российского зеркала GitVerse Pages">🔄 Обновить зеркало РФ</button>
      <button id="cleanup-btn" class="sec" hidden title="Убрать дубли фото, хвосты контактов и перенести новости из отзывов">✨ Автоочистка каталога</button>
      <button id="logout" class="sec" hidden>Выйти</button>
    </div>
  </header>

  <section id="login" class="panel">
    <h2 style="margin-top:0">Вход администратора</h2>
    <p class="muted">Получите одноразовый код в личном чате Telegram-бота командой /adminlink (или нажмите кнопку быстрого входа в /panel).</p>
    <form id="login-form" style="margin-top:16px">
      <label for="code" style="display:block;margin-bottom:6px;font-weight:700">Одноразовый код (8 цифр)</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]{8}" placeholder="00000000" required>
      <div style="margin-top:14px"><button type="submit" style="width:100%">Войти в панель управления</button></div>
    </form>
    <p id="login-status" class="muted" style="color:#fca5a5;margin-top:12px" role="status"></p>
  </section>

  <section id="app" hidden>
    <div id="status" class="status-bar" role="status"></div>

    <div class="stats">
      <div class="stat"><span class="muted">Авто на сайте</span><b id="st-cars">0</b></div>
      <div class="stat"><span class="muted">Новостей на сайте</span><b id="st-news">0</b></div>
      <div class="stat"><span class="muted">Отзывов на сайте</span><b id="st-reviews">0</b></div>
      <div class="stat"><span class="muted">Ждут модерации</span><b id="st-pending">0</b></div>
      <div class="stat"><span class="muted">Заявок с сайта</span><b id="st-orders">0</b></div>
    </div>

    <div class="composer" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px">
      <span style="font-weight:800;white-space:nowrap">💬 Кнопка «Бот в MAX» на сайте:</span>
      <input id="max-bot-url" type="url" style="flex:1;min-width:220px;padding:9px 12px" placeholder="https://max.ru/ваш_бот (если пусто — кнопки MAX на сайте ведут к форме связи в MAX)">
      <button type="button" id="save-max-url-btn" class="sec sm" style="padding:9px 14px">💾 Сохранить ссылку MAX</button>
    </div>

    <div class="composer" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px">
      <span style="font-weight:800;white-space:nowrap">🔍 Яндекс.Вебмастер (код):</span>
      <input id="yandex-verify-code" type="text" style="flex:1;min-width:220px;padding:9px 12px" placeholder="Код подтверждения из meta-тега yandex-verification (пример: a1b2c3d4e5f6)">
      <button type="button" id="save-yandex-btn" class="sec sm" style="padding:9px 14px">💾 Сохранить код Яндекса</button>
    </div>

    <div class="composer" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px 16px">
      <label for="auto-publish-cars" style="display:flex;gap:10px;align-items:center;cursor:pointer;font-weight:800">
        <input id="auto-publish-cars" type="checkbox" style="width:18px;height:18px">
        <span>⚡ Автопубликация новых авто (Telegram ↔ MAX ↔ Сайт) без дублей</span>
      </label>
    </div>

    <div class="tabs">
      <button type="button" class="tab active" data-tab="cars">🚘 Автомобили</button>
      <button type="button" class="tab" data-tab="news">📰 Новости</button>
      <button type="button" class="tab" data-tab="reviews">⭐ Отзывы</button>
      <button type="button" class="tab" data-tab="pending">⏳ Очередь модерации</button>
      <button type="button" class="tab" data-tab="orders">📋 Заявки клиентов</button>
    </div>

    <div id="news-composer" class="composer" hidden>
      <h3 style="margin:0 0 8px;font-size:15px">➕ Опубликовать новую новость</h3>
      <p class="muted" style="margin-bottom:10px">Первая строка станет заголовком новости на сайте. Для новости с фото или видео отправьте фото/видео с текстом напрямую в бот Telegram и нажмите «📰 Опубликовать как НОВОСТЬ».</p>
      <textarea id="new-news-text" style="min-height:95px" placeholder="Заголовок новости (первая строка)&#10;&#10;Подробности изменений утильсбора, курсов или условий доставки…"></textarea>
      <div style="margin-top:10px"><button type="button" id="publish-news-btn" class="ok">📰 Опубликовать новость на сайт</button></div>
    </div>

    <div class="toolbar">
      <input id="search" type="search" placeholder="Поиск по названию, тексту, цене, контакту или ID…">
      <select id="filter-select" style="max-width:220px" hidden>
        <option value="all">Все заявки</option>
        <option value="new">Новые</option>
        <option value="in_work">В работе</option>
        <option value="done">Завершённые</option>
      </select>
    </div>

    <div id="view-root"></div>
  </section>
</main>

<script>
const loginSec = document.getElementById('login');
const appSec = document.getElementById('app');
const statusEl = document.getElementById('status');
const loginStatus = document.getElementById('login-status');
const viewRoot = document.getElementById('view-root');
const searchInput = document.getElementById('search');
const filterSelect = document.getElementById('filter-select');
const newsComposer = document.getElementById('news-composer');
const refreshBtn = document.getElementById('refresh-btn');
const syncTgBtn = document.getElementById('sync-tg-btn');
const syncMirrorBtn = document.getElementById('sync-mirror-btn');
const cleanupBtn = document.getElementById('cleanup-btn');
const logoutBtn = document.getElementById('logout');

let state = { tab: 'cars', items: [], pending: [], orders: [] };

async function api(path, method = 'GET', body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function notify(msg, isError = false) {
  if (!msg) { statusEl.className = 'status-bar'; statusEl.textContent = ''; return; }
  statusEl.textContent = msg;
  statusEl.className = 'status-bar show ' + (isError ? 'error' : 'ok');
}

function showLogin(msg = '') {
  loginSec.hidden = false; appSec.hidden = true;
  refreshBtn.hidden = syncTgBtn.hidden = syncMirrorBtn.hidden = cleanupBtn.hidden = logoutBtn.hidden = true;
  loginStatus.textContent = msg;
}

function showApp() {
  loginSec.hidden = true; appSec.hidden = false;
  refreshBtn.hidden = syncTgBtn.hidden = syncMirrorBtn.hidden = cleanupBtn.hidden = logoutBtn.hidden = false;
  loadAll();
}

async function loadAll() {
  try {
    const data = await api('/api/admin/dashboard');
    state.items = data.items || [];
    state.pending = data.pending || [];
    state.orders = data.orders || [];
    document.getElementById('st-cars').textContent = state.items.filter(i => i.kind === 'car').length;
    document.getElementById('st-news').textContent = state.items.filter(i => i.kind === 'news').length;
    document.getElementById('st-reviews').textContent = state.items.filter(i => i.kind === 'review').length;
    document.getElementById('st-pending').textContent = state.pending.length;
    document.getElementById('st-orders').textContent = state.orders.length;
    const maxInput = document.getElementById('max-bot-url');
    if (maxInput && document.activeElement !== maxInput) maxInput.value = data.maxBotUrl || '';
    const yandexInput = document.getElementById('yandex-verify-code');
    if (yandexInput && document.activeElement !== yandexInput) yandexInput.value = data.yandexVerification || '';
    const autoPubEl = document.getElementById('auto-publish-cars');
    if (autoPubEl) autoPubEl.checked = Boolean(data.autoPublishCars);
    render();
  } catch (e) {
    if (e.message === 'Unauthorized') return showLogin('Сессия истекла. Получите новый код командой /adminlink в боте.');
    notify(e.message, true);
  }
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderPubCard(item, isPending = false) {
  const card = el('article', 'card');
  const head = el('div', 'card-head');
  const left = el('div');
  left.appendChild(el('h3', 'card-title', item.cleanTitle || item.label || 'Публикация'));
  left.appendChild(el('div', 'muted', item.id + (item.publishedAt ? ' · ' + item.publishedAt.slice(0, 10) : '')));
  head.appendChild(left);
  if (item.priceFormatted && item.kind === 'car') {
    head.appendChild(el('span', 'badge price', item.priceFormatted));
  } else if (item.kind === 'news') {
    head.appendChild(el('span', 'badge news', '📰 Новость'));
  } else {
    head.appendChild(el('span', 'badge', item.kind === 'car' ? 'Авто' : 'Отзыв'));
  }
  card.appendChild(head);

  const mediaList = Array.isArray(item.mediaItems) ? item.mediaItems : [];
  if (mediaList.length) {
    const strip = el('div', 'thumbs');
    mediaList.forEach((m, idx) => {
      const box = el('div', 'thumb');
      const mediaNode = document.createElement(m.type === 'video' ? 'video' : 'img');
      mediaNode.src = m.url;
      if (m.type === 'video') { mediaNode.preload = 'metadata'; mediaNode.muted = true; }
      else mediaNode.loading = 'lazy';
      box.appendChild(mediaNode);

      if (!isPending && item.kind === 'car' && m.type === 'photo') {
        const bar = el('div', 'thumb-bar');
        if (idx > 0) {
          const cov = el('button', 'thumb-btn cover', '★ Гл.');
          cov.title = 'Сделать главным фото';
          cov.onclick = async () => {
            try {
              await api('/api/admin/items/' + encodeURIComponent(item.id), 'PATCH', { setCoverPhotoIndex: m.photoIndex ?? idx });
              notify('Главное фото обновлено');
              loadAll();
            } catch (e) { notify(e.message, true); }
          };
          bar.appendChild(cov);
        } else {
          bar.appendChild(el('span', 'thumb-btn cover', '★ Обложка'));
        }
        if (mediaList.filter(x => x.type === 'photo').length > 1) {
          const del = el('button', 'thumb-btn del', '×');
          del.title = 'Удалить это фото';
          del.onclick = async () => {
            if (!confirm('Удалить фото №' + (idx + 1) + ' из этой карточки?')) return;
            try {
              await api('/api/admin/items/' + encodeURIComponent(item.id), 'PATCH', { deletePhotoIndex: m.photoIndex ?? idx });
              notify('Фото удалено');
              loadAll();
            } catch (e) { notify(e.message, true); }
          };
          bar.appendChild(del);
        }
        box.appendChild(bar);
      }
      strip.appendChild(box);
    });
    card.appendChild(strip);
  }

  const area = document.createElement('textarea');
  area.value = item.text || '';
  area.placeholder = item.kind === 'car'
    ? 'Название модели, год, характеристики, цена под ключ…'
    : (item.kind === 'news' ? 'Заголовок новости и текст…' : 'Текст отзыва клиента…');
  card.appendChild(area);

  const acts = el('div', 'actions');
  if (isPending) {
    const pubBtn = el('button', 'ok', '✅ Опубликовать (' + (item.kind === 'car' ? 'Авто' : item.kind === 'news' ? 'Новость' : 'Отзыв') + ')');
    pubBtn.onclick = async () => {
      try {
        await api('/api/admin/pending/' + encodeURIComponent(item.id) + '/publish', 'POST', { kind: item.kind, text: area.value });
        notify('Опубликовано на сайт!');
        loadAll();
      } catch (e) { notify(e.message, true); }
    };
    const rejBtn = el('button', 'danger', '❌ Удалить из очереди');
    rejBtn.onclick = async () => {
      if (!confirm('Удалить эту карточку из очереди модерации?')) return;
      try {
        await api('/api/admin/pending/' + encodeURIComponent(item.id), 'DELETE', { kind: item.kind });
        notify('Удалено из очереди');
        loadAll();
      } catch (e) { notify(e.message, true); }
    };
    acts.appendChild(pubBtn);
    acts.appendChild(rejBtn);
  } else {
    const saveBtn = el('button', '', '💾 Сохранить');
    saveBtn.onclick = async () => {
      try {
        await api('/api/admin/items/' + encodeURIComponent(item.id), 'PATCH', { directText: area.value });
        notify('Изменения сохранены: ' + (item.cleanTitle || item.id));
        loadAll();
      } catch (e) { notify(e.message, true); }
    };
    acts.appendChild(saveBtn);

    if (item.kind === 'review' || item.kind === 'news') {
      const targetKind = item.kind === 'review' ? 'news' : 'review';
      const moveBtn = el('button', 'sec', item.kind === 'review' ? '⇄ В Новости' : '⇄ В Отзывы');
      moveBtn.onclick = async () => {
        try {
          await api('/api/admin/items/' + encodeURIComponent(item.id) + '/move', 'POST', { targetKind });
          notify(targetKind === 'news' ? 'Перенесено в раздел «Новости»' : 'Перенесено в раздел «Отзывы»');
          loadAll();
        } catch (e) { notify(e.message, true); }
      };
      acts.appendChild(moveBtn);
    }

    const unpubBtn = el('button', 'danger', '🗑 Снять');
    unpubBtn.onclick = async () => {
      if (!confirm('Снять эту публикацию с сайта? Она переместится во вкладку «Очередь модерации».')) return;
      try {
        await api('/api/admin/items/' + encodeURIComponent(item.id), 'DELETE');
        notify('Публикация снята с сайта');
        loadAll();
      } catch (e) { notify(e.message, true); }
    };
    acts.appendChild(unpubBtn);
  }
  card.appendChild(acts);
  return card;
}

function renderOrderRow(ord) {
  const row = el('div', 'order-row');
  const col1 = el('div');
  col1.appendChild(el('div', 'card-title', 'Заявка №' + (ord.number || ord.id)));
  col1.appendChild(el('div', 'muted', (ord.createdAt || '').replace('T', ' ').slice(0, 16)));

  const col2 = el('div');
  col2.appendChild(el('div', '', '👤 ' + (ord.name || '—')));
  col2.appendChild(el('div', '', '📞 ' + (ord.contact || '—')));

  const col3 = el('div');
  col3.appendChild(el('div', '', '🚘 ' + (ord.model || 'Подбор автомобиля') + (ord.budget ? ' · ' + ord.budget : '')));
  col3.appendChild(el('div', 'muted', [ord.country, ord.year ? 'от ' + ord.year : '', ord.details].filter(Boolean).join(' · ') || 'Без доп. пожеланий'));

  const col4 = el('div', 'actions');
  const stMap = { new: ['Новая', 'new'], in_work: ['В работе', 'work'], done: ['Завершена', 'done'] };
  const [stLabel, stCls] = stMap[ord.status] || [ord.status || 'Новая', 'new'];
  col4.appendChild(el('span', 'badge ' + stCls, stLabel));

  if (ord.status !== 'in_work') {
    const bWork = el('button', 'sec sm', 'В работу');
    bWork.onclick = async () => { await api('/api/admin/orders/' + encodeURIComponent(ord.id), 'PATCH', { status: 'in_work' }); loadAll(); };
    col4.appendChild(bWork);
  }
  if (ord.status !== 'done') {
    const bDone = el('button', 'ok sm', 'Завершить');
    bDone.onclick = async () => { await api('/api/admin/orders/' + encodeURIComponent(ord.id), 'PATCH', { status: 'done' }); loadAll(); };
    col4.appendChild(bDone);
  }
  row.appendChild(col1); row.appendChild(col2); row.appendChild(col3); row.appendChild(col4);
  return row;
}

function render() {
  viewRoot.replaceChildren();
  const q = searchInput.value.trim().toLowerCase();
  filterSelect.hidden = state.tab !== 'orders';
  newsComposer.hidden = state.tab !== 'news';

  if (state.tab === 'orders') {
    const f = filterSelect.value;
    const list = state.orders.filter(o => {
      if (f !== 'all' && (o.status || 'new') !== f) return false;
      if (!q) return true;
      return JSON.stringify(o).toLowerCase().includes(q);
    });
    if (!list.length) { viewRoot.appendChild(el('p', 'muted', 'Заявок по выбранному фильтру пока нет.')); return; }
    list.forEach(o => viewRoot.appendChild(renderOrderRow(o)));
    return;
  }

  if (state.tab === 'pending') {
    const list = state.pending.filter(i => !q || JSON.stringify(i).toLowerCase().includes(q));
    if (!list.length) { viewRoot.appendChild(el('p', 'muted', 'Очередь модерации пуста — все материалы обработаны.')); return; }
    const grid = el('div', 'grid');
    list.forEach(i => grid.appendChild(renderPubCard(i, true)));
    viewRoot.appendChild(grid);
    return;
  }

  const targetKind = state.tab === 'cars' ? 'car' : (state.tab === 'news' ? 'news' : 'review');
  const list = state.items.filter(i => i.kind === targetKind && (!q || JSON.stringify(i).toLowerCase().includes(q)));
  if (!list.length) { viewRoot.appendChild(el('p', 'muted', 'В этом разделе пока нет публикаций.')); return; }
  const grid = el('div', 'grid');
  list.forEach(i => grid.appendChild(renderPubCard(i, false)));
  viewRoot.appendChild(grid);
}

document.querySelectorAll('.tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.tab = btn.dataset.tab;
    render();
  };
});
searchInput.oninput = render;
filterSelect.onchange = render;
refreshBtn.onclick = loadAll;
syncTgBtn.onclick = async () => {
  notify('Проверяем @avtoYkorea на новые автомобили…');
  try {
    const r = await api('/api/admin/sync-telegram', 'POST', {});
    notify(
      r.ok
        ? ('Готово: добавлено новых авто — ' + (r.importedCars || 0) + ', пропущено дублей — ' + (r.skippedDuplicates || 0))
        : ('Не удалось синхронизировать @avtoYkorea: ' + (r.reason || ('HTTP ' + (r.status || 0)))),
      !r.ok
    );
    if (r.ok) loadAll();
  } catch (e) { notify(e.message, true); }
};

syncMirrorBtn.onclick = async () => {
  try {
    const r = await api('/api/admin/sync-mirror', 'POST', {});
    notify(r.ok ? 'Облачное обновление зеркала РФ запущено (~2–3 мин)!' : ('Статус синхронизации: ' + (r.skipped || ('HTTP ' + (r.status || 0)))), !r.ok);
  } catch (e) { notify(e.message, true); }
};

document.getElementById('auto-publish-cars').onchange = async e => {
  try {
    const r = await api('/api/admin/settings', 'POST', { autoPublishCars: Boolean(e.target.checked) });
    notify(r.autoPublishCars ? 'Автопубликация новых авто включена' : 'Автопубликация новых авто выключена');
  } catch (err) { notify(err.message, true); }
};

document.getElementById('save-max-url-btn').onclick = async () => {
  const val = document.getElementById('max-bot-url').value.trim();
  try {
    const r = await api('/api/admin/settings', 'POST', { maxBotUrl: val });
    notify(r.maxBotUrl ? ('Ссылка на бот MAX сохранена: ' + r.maxBotUrl) : 'Прямая ссылка MAX очищена (включён режим формы связи в MAX)');
    loadAll();
  } catch (e) { notify(e.message, true); }
};

document.getElementById('save-yandex-btn').onclick = async () => {
  const val = document.getElementById('yandex-verify-code').value.trim();
  try {
    const r = await api('/api/admin/settings', 'POST', { yandexVerification: val });
    notify(r.yandexVerification ? ('Код Яндекс.Вебмастер сохранён: ' + r.yandexVerification) : 'Код Яндекс.Вебмастер очищен');
    loadAll();
  } catch (e) { notify(e.message, true); }
};

document.getElementById('publish-news-btn').onclick = async () => {
  const txt = document.getElementById('new-news-text').value.trim();
  if (!txt) return notify('Введите текст новости', true);
  try {
    await api('/api/admin/news', 'POST', { text: txt });
    document.getElementById('new-news-text').value = '';
    notify('Новость опубликована на сайт!');
    loadAll();
  } catch (e) { notify(e.message, true); }
};

cleanupBtn.onclick = async () => {
  if (!confirm('Очистить дубликаты фото, хвосты контактов и автоматически перенести рыночные новости из отзывов в раздел «Новости»?')) return;
  try {
    const r = await api('/api/admin/cleanup', 'POST', {});
    notify('Готово: обновлено авто — ' + r.cleanedCars + ', перенесено в Новости — ' + (r.movedToNews || 0) + ', снято битых — ' + r.removedBroken);
    loadAll();
  } catch (e) { notify(e.message, true); }
};

document.getElementById('login-form').onsubmit = async e => {
  e.preventDefault();
  loginStatus.textContent = 'Проверяем код…';
  try {
    await api('/api/admin/login', 'POST', { code: document.getElementById('code').value.trim() });
    document.getElementById('code').value = '';
    showApp();
  } catch (err) { loginStatus.textContent = err.message; }
};

logoutBtn.onclick = async () => {
  await api('/api/admin/logout', 'POST').catch(() => {});
  showLogin('Вы вышли из панели управления.');
};

(async () => {
  const hashMatch = String(location.hash || '').match(/code=(\d{8})/);
  if (hashMatch) {
    history.replaceState(null, '', location.pathname);
    try {
      await api('/api/admin/login', 'POST', { code: hashMatch[1] });
      showApp();
      return;
    } catch {}
  }
  try { await api('/api/admin/session'); showApp(); }
  catch { showLogin(''); }
})();
</script>
</body>
</html>`;

export function enrichAdminItem(id, record, kind, siteLabelFn) {
  const isCar = kind === "car";
  const isNews = kind === "news";
  const photos = Array.isArray(record.photos) ? record.photos : (record.fileId && record.kind !== "video" && record.mediaType !== "video" ? [{ file_id: record.fileId }] : []);
  const videos = Array.isArray(record.videos) ? record.videos : ((record.kind === "video" || record.mediaType === "video") && record.fileId ? [{ file_id: record.fileId }] : []);
  const basePrefix = isCar ? `/api/car-media/${id}` : (isNews ? `/api/news-media/${id}` : `/api/review-media/${id}`);
  const mediaItems = [
    ...photos.map((_, idx) => ({ type: "photo", photoIndex: idx, url: `${basePrefix}/photo/${idx}` })),
    ...videos.map((_, idx) => ({ type: "video", videoIndex: idx, url: `${basePrefix}/video/${idx}` }))
  ];
  const parsedCar = isCar ? parseVehicleCardData({ id, caption: record.caption || "", mediaItems }) : null;
  const parsedNews = isNews ? parseNewsCardData({ id, text: record.text || record.caption || "" }) : null;
  return {
    id,
    kind,
    label: siteLabelFn(id, record),
    cleanTitle: parsedCar ? parsedCar.title : (parsedNews ? parsedNews.title : siteLabelFn(id, record)),
    priceFormatted: parsedCar ? parsedCar.priceFormatted : "",
    text: String(isCar ? record.caption || "" : record.text || record.caption || ""),
    mediaCount: photos.length + videos.length,
    mediaItems,
    publishedAt: record.publishedAt || record.createdAt || ""
  };
}

export async function runAdminCatalogCleanup(env, adminId, writeLogFn) {
  let cleanedCars = 0;
  let removedBroken = 0;
  let movedToNews = 0;

  const page = await env.REVIEWS.list({ prefix: "car_approved:" });
  for (const key of page.keys) {
    const raw = await env.REVIEWS.get(key.name);
    if (!raw) continue;
    const car = JSON.parse(raw);
    const id = key.name.slice("car_approved:".length);
    const trimmed = String(car.caption || "").trim().toLowerCase();

    if (trimmed === "исправить") {
      await env.REVIEWS.put("car_pending:" + id, JSON.stringify(car));
      await env.REVIEWS.delete(key.name);
      removedBroken++;
      continue;
    }

    let changed = false;
    const cleanedText = cleanCarDisplayCaption(car.caption || "");
    if (cleanedText !== String(car.caption || "")) {
      car.originalCaption = car.originalCaption ?? car.caption;
      car.caption = cleanedText;
      changed = true;
    }

    if (Array.isArray(car.photos) && car.photos.length > 1) {
      const seen = new Set();
      const deduped = [];
      for (const p of car.photos) {
        const k = String(p?.file_unique_id || p?.file_id || "");
        if (!k || seen.has(k)) continue;
        seen.add(k);
        deduped.push(p);
      }
      if (deduped.length !== car.photos.length) {
        car.photos = deduped;
        changed = true;
      }
    }

    if (changed) {
      car.editedAt = new Date().toISOString();
      car.editedBy = String(adminId);
      await env.REVIEWS.put(key.name, JSON.stringify(car));
      cleanedCars++;
    }
  }

  // Automatically reclassify market/tariff news accidentally stored in approved:* reviews
  const revPage = await env.REVIEWS.list({ prefix: "approved:" });
  for (const key of revPage.keys) {
    const raw = await env.REVIEWS.get(key.name);
    if (!raw) continue;
    const rev = JSON.parse(raw);
    const revId = key.name.slice("approved:".length);
    if (isMarketNewsRecord(rev)) {
      const newsId = "news_" + revId.replace(/^-/, "");
      const newsRec = {
        ...rev,
        id: newsId,
        category: "news",
        publishedAt: rev.publishedAt || rev.createdAt || new Date().toISOString()
      };
      await env.REVIEWS.put("news_approved:" + newsId, JSON.stringify(newsRec));
      await env.REVIEWS.delete(key.name);
      movedToNews++;
    }
  }

  if (writeLogFn && (cleanedCars > 0 || removedBroken > 0 || movedToNews > 0)) {
    await writeLogFn(
      env,
      String(adminId),
      `автоочистка: авто ${cleanedCars}, в новости ${movedToNews}, битых ${removedBroken}`,
      "каталог",
      "all",
      ""
    );
  }
  return { cleanedCars, removedBroken, movedToNews };
}

// Interactive single-message Telegram control panel (/panel & panel:* callbacks)
export async function sendOrEditTelegramPanel(env, chatId, messageId, stateQuery = "home", helpers = {}) {
  const { callTelegram, siteLabel, sha256Hex } = helpers;
  if (!env.REVIEWS) {
    return callTelegram(env, "sendMessage", { chat_id: chatId, text: "Хранилище REVIEWS не настроено." });
  }

  const sendOrEdit = async (text, inline_keyboard) => {
    if (messageId) {
      try {
        return await callTelegram(env, "editMessageText", {
          chat_id: chatId,
          message_id: messageId,
          text,
          reply_markup: { inline_keyboard }
        });
      } catch {}
    }
    return callTelegram(env, "sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: { inline_keyboard }
    });
  };

  const parts = String(stateQuery).split(":");
  const view = parts[0] || "home";

  if (view === "home") {
    const [cars, news, reviews, carPend, newsPend, revPend, orders] = await Promise.all([
      env.REVIEWS.list({ prefix: "car_approved:" }),
      env.REVIEWS.list({ prefix: "news_approved:" }),
      env.REVIEWS.list({ prefix: "approved:" }),
      env.REVIEWS.list({ prefix: "car_pending:" }),
      env.REVIEWS.list({ prefix: "news_pending:" }),
      env.REVIEWS.list({ prefix: "pending:" }),
      env.REVIEWS.list({ prefix: "order:" })
    ]);
    const totalPending = carPend.keys.length + newsPend.keys.length + revPend.keys.length;
    const text = [
      "🎛 ЦЕНТР УПРАВЛЕНИЯ AVTOY KOREA",
      "",
      `🚘 Автомобилей на сайте: ${cars.keys.length}`,
      `📰 Новостей на сайте: ${news.keys.length}`,
      `⭐ Отзывов на сайте: ${reviews.keys.length}`,
      `⏳ Ожидают модерации: ${totalPending}`,
      `📋 Всего заявок клиентов: ${orders.keys.length}`,
      "",
      "💡 Как быстро добавить материал:",
      "• Отправьте фото/видео с текстом сюда в бот → выберите «Автомобиль», «Новость» или «Отзыв»",
      "• Для текстовой новости без фото: /news <текст новости>"
    ].join("\n");

    let magicUrl = "https://avtoy-korea-auto.sokfrut.workers.dev/admin";
    if (typeof sha256Hex === "function") {
      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 100000000).padStart(8, "0");
      const codeHash = await sha256Hex(code);
      const currentKey = "admin_login_current:" + chatId;
      const oldHash = await env.REVIEWS.get(currentKey);
      if (oldHash) await env.REVIEWS.delete("admin_login:" + oldHash);
      await env.REVIEWS.put("admin_login:" + codeHash, JSON.stringify({ adminId: String(chatId) }), { expirationTtl: 300 });
      await env.REVIEWS.put(currentKey, codeHash, { expirationTtl: 300 });
      magicUrl = `https://avtoy-korea-auto.sokfrut.workers.dev/admin#code=${code}`;
    }

    return sendOrEdit(text, [
      [
        { text: `🚘 Авто (${cars.keys.length})`, callback_data: "panel:cars:0" },
        { text: `📰 Новости (${news.keys.length})`, callback_data: "panel:news:0" },
        { text: `⭐ Отзывы (${reviews.keys.length})`, callback_data: "panel:reviews:0" }
      ],
      [
        { text: `⏳ Модерация (${totalPending})`, callback_data: "panel:pending:0" },
        { text: `📋 Заявки (${orders.keys.length})`, callback_data: "panel:orders:0" }
      ],
      [{ text: "✨ Автоочистка (дубли + новости)", callback_data: "panel:cleanall" }],
      [{ text: "🔐 Открыть Веб-Админку в 1 клик", url: magicUrl }]
    ]);
  }

  if (view === "cars" || view === "reviews" || view === "news") {
    const prefix = view === "cars" ? "car_approved:" : (view === "news" ? "news_approved:" : "approved:");
    const pageIdx = Math.max(0, Number(parts[1] || 0));
    const listPage = await env.REVIEWS.list({ prefix });
    const records = [];
    for (const k of listPage.keys) {
      const r = await env.REVIEWS.get(k.name);
      if (!r) continue;
      const id = k.name.slice(prefix.length);
      records.push({ id, data: JSON.parse(r) });
    }
    records.sort((a, b) => String(b.data.publishedAt || "").localeCompare(String(a.data.publishedAt || "")));
    const perPage = 6;
    const totalPages = Math.max(1, Math.ceil(records.length / perPage));
    const safePage = Math.min(pageIdx, totalPages - 1);
    const slice = records.slice(safePage * perPage, (safePage + 1) * perPage);

    const rows = slice.map(item => {
      let btnText;
      if (view === "cars") {
        const parsed = parseVehicleCardData({ id: item.id, caption: item.data.caption || "" });
        btnText = `🚘 ${parsed.title.slice(0, 26)} · ${parsed.priceFormatted}`;
      } else if (view === "news") {
        const parsed = parseNewsCardData({ id: item.id, text: item.data.text || item.data.caption || "" });
        btnText = `📰 ${parsed.title.slice(0, 38)}`;
      } else {
        btnText = `⭐ ${(siteLabel ? siteLabel(item.id, item.data) : item.id).slice(0, 42)}`;
      }
      return [{ text: btnText, callback_data: `panel:item:${item.id}` }];
    });

    const nav = [];
    if (safePage > 0) nav.push({ text: "◀️ Назад", callback_data: `panel:${view}:${safePage - 1}` });
    nav.push({ text: `${safePage + 1} / ${totalPages}`, callback_data: "panel:noop" });
    if (safePage + 1 < totalPages) nav.push({ text: "Вперёд ▶️", callback_data: `panel:${view}:${safePage + 1}` });
    rows.push(nav);
    rows.push([{ text: "🔙 В главное меню", callback_data: "panel:home" }]);

    const headerLabel = view === "cars" ? "🚘 ОПУБЛИКОВАННЫЕ АВТОМОБИЛИ" : (view === "news" ? "📰 ОПУБЛИКОВАННЫЕ НОВОСТИ" : "⭐ ОПУБЛИКОВАННЫЕ ОТЗЫВЫ");
    return sendOrEdit(`${headerLabel} (${records.length})\nНажмите на нужную позицию для редактирования или снятия с сайта:`, rows);
  }

  if (view === "item") {
    const id = parts.slice(1).join(":");
    const isCar = id.startsWith("car_");
    const isNews = id.startsWith("news_");
    const prefix = isCar ? "car_approved:" : (isNews ? "news_approved:" : "approved:");
    const raw = await env.REVIEWS.get(prefix + id);
    if (!raw) return sendOrEdit("Публикация не найдена (возможно, уже снята с сайта).", [[{ text: "🔙 Назад", callback_data: "panel:home" }]]);
    const rec = JSON.parse(raw);
    const photos = Array.isArray(rec.photos) ? rec.photos.length : (rec.fileId ? 1 : 0);
    const videos = Array.isArray(rec.videos) ? rec.videos.length : 0;
    const body = String(isCar ? rec.caption || "" : rec.text || rec.caption || "").slice(0, 1200) || "— без текста —";
    const backTab = isCar ? "panel:cars:0" : (isNews ? "panel:news:0" : "panel:reviews:0");
    return sendOrEdit(
      `${isCar ? "🚘 КАРТОЧКА АВТОМОБИЛЯ" : (isNews ? "📰 КАРТОЧКА НОВОСТИ" : "⭐ КАРТОЧКА ОТЗЫВА")}\nID: ${id}\nМедиа: фото ${photos}, видео ${videos}\n\n${body}`,
      [
        [{ text: "✏️ Изменить текст", callback_data: `siteedit:${id}` }, { text: "🗑 Снять с сайта", callback_data: `sitedel:${id}` }],
        [{ text: "🔙 К списку", callback_data: backTab }, { text: "🏠 Меню", callback_data: "panel:home" }]
      ]
    );
  }

  if (view === "orders") {
    const pageIdx = Math.max(0, Number(parts[1] || 0));
    const ordPage = await env.REVIEWS.list({ prefix: "order:" });
    const orders = [];
    for (const k of ordPage.keys) {
      const r = await env.REVIEWS.get(k.name);
      if (r) orders.push(JSON.parse(r));
    }
    orders.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    const perPage = 6;
    const totalPages = Math.max(1, Math.ceil(orders.length / perPage));
    const safePage = Math.min(pageIdx, totalPages - 1);
    const slice = orders.slice(safePage * perPage, (safePage + 1) * perPage);

    const lines = [`📋 ЗАЯВКИ КЛИЕНТОВ (${orders.length})`, ""];
    const rows = [];
    for (const o of slice) {
      const icon = o.status === "done" ? "✅" : (o.status === "in_work" ? "🛠" : "🆕");
      lines.push(`${icon} №${String(o.number || o.id).slice(-6)} · ${o.name} · ${o.contact}\n   ${o.model || "Подбор"} (${o.budget || "бюджет не указан"})`);
      if (o.number) {
        rows.push([
          { text: `${icon} №${String(o.number).slice(-6)} — В работу`, callback_data: `ord:${o.number}` },
          { text: "🏁 Завершить", callback_data: `orddone:${o.number}` }
        ]);
      }
    }
    if (!slice.length) lines.push("Заявок пока нет.");
    const nav = [];
    if (safePage > 0) nav.push({ text: "◀️", callback_data: `panel:orders:${safePage - 1}` });
    nav.push({ text: `${safePage + 1} / ${totalPages}`, callback_data: "panel:noop" });
    if (safePage + 1 < totalPages) nav.push({ text: "▶️", callback_data: `panel:orders:${safePage + 1}` });
    rows.push(nav);
    rows.push([{ text: "🔙 В главное меню", callback_data: "panel:home" }]);
    return sendOrEdit(lines.join("\n"), rows);
  }

  if (view === "pending") {
    const [carPend, newsPend, revPend] = await Promise.all([
      env.REVIEWS.list({ prefix: "car_pending:" }),
      env.REVIEWS.list({ prefix: "news_pending:" }),
      env.REVIEWS.list({ prefix: "pending:" })
    ]);
    const entries = [
      ...carPend.keys.map(k => ({ id: k.name.slice("car_pending:".length), kind: "car", key: k.name })),
      ...newsPend.keys.map(k => ({ id: k.name.slice("news_pending:".length), kind: "news", key: k.name })),
      ...revPend.keys.map(k => ({ id: k.name.slice("pending:".length), kind: "review", key: k.name }))
    ].slice(0, 6);
    const rows = [];
    const lines = [`⏳ ОЧЕРЕДЬ МОДЕРАЦИИ (${carPend.keys.length + newsPend.keys.length + revPend.keys.length})`, ""];
    for (const e of entries) {
      const raw = await env.REVIEWS.get(e.key);
      if (!raw) continue;
      const d = JSON.parse(raw);
      const title = String(e.kind === "car" ? d.caption || "" : d.text || d.caption || "").split("\n").find(Boolean) || "Без описания";
      const icon = e.kind === "car" ? "🚘" : (e.kind === "news" ? "📰" : "⭐");
      lines.push(`${icon} ${title.slice(0, 45)}`);
      const pubCb = e.kind === "car" ? `carpubforce:${e.id}` : (e.kind === "news" ? `newspub:${e.id}` : `pubforce:${e.id}`);
      const rejCb = e.kind === "car" ? `carrej:${e.id}` : (e.kind === "news" ? `newsrej:${e.id}` : `rej:${e.id}`);
      rows.push([
        { text: `✅ Опубл.: ${title.slice(0, 18)}`, callback_data: pubCb },
        { text: "❌ Откл.", callback_data: rejCb }
      ]);
    }
    if (!entries.length) lines.push("Нет материалов, ожидающих модерации.");
    rows.push([{ text: "🔙 В главное меню", callback_data: "panel:home" }]);
    return sendOrEdit(lines.join("\n"), rows);
  }

  return sendOrEdit("Раздел не найден.", [[{ text: "🔙 Меню", callback_data: "panel:home" }]]);
}
