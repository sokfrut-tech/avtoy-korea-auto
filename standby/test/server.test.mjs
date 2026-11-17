import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { assertDurableAdminRuntime, assertProductionRequestStore, createStandbyApp } from '../server.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'avtoy-standby-'));
  const publicDir = path.join(dir, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<title>AVTOY KOREA — резервный сайт</title>');
  const { env = {}, ...appOptions } = options;
  const app = createStandbyApp({ dataDir: path.join(dir, 'data'), publicDir, ...appOptions, env:{ NODE_ENV:'test', ...env } });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { base, dir, app };
}
const submit = (base, body, key) => fetch(base + '/api/request', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
  body: JSON.stringify(body)
});

test('health endpoint responds independently', async t => {
  const { base } = await fixture(t);
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).service, 'avtoy-korea-standby');
});

test('catalogue reads only local public snapshot', async t => {
  const { base, dir } = await fixture(t);
  let r = await fetch(base + '/api/cars');
  assert.deepEqual((await r.json()).cars, []);
  await mkdir(path.join(dir, 'data'), { recursive: true });
  await writeFile(path.join(dir, 'data', 'public-snapshot.json'), JSON.stringify({ cars: [{ id: 'car_1_2', caption: 'Kia', mediaItems: [] }] }));
  r = await fetch(base + '/api/cars');
  assert.equal((await r.json()).cars[0].caption, 'Kia');
});

test('enquiry is saved before delivery and idempotency prevents duplicates', async t => {
  const { base, dir } = await fixture(t);
  const body = { name: 'Анна', contact: '@anna', model: 'Kia Sportage' };
  const first = await submit(base, body, 'request-12345678');
  const second = await submit(base, body, 'request-12345678');
  assert.equal(first.status, 202);
  assert.equal((await second.json()).ok, true);
  const saved = JSON.parse(await readFile(path.join(dir, 'data', 'inbox.json'), 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, 'queued');
});

test('Telegram success marks enquiry delivered', async t => {
  const { base, dir } = await fixture(t, {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_ADMIN_IDS: '111111111' },
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  const r = await submit(base, { name: 'Анна', contact: '@anna', model: 'Kia' });
  assert.equal((await r.json()).delivery, 'sent');
  const saved = JSON.parse(await readFile(path.join(dir, 'data', 'inbox.json'), 'utf8'));
  assert.equal(saved[0].status, 'delivered');
});

test('failed Telegram delivery stays queued and private inbox requires token', async t => {
  const { base } = await fixture(t, {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_ADMIN_IDS: '111111111', STANDBY_ADMIN_TOKEN: 'secret' },
    fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 200, headers: { 'content-type': 'application/json' } })
  });
  const r = await submit(base, { name: 'Анна', contact: '@anna', model: 'Kia' });
  assert.equal((await r.json()).delivery, 'queued');
  assert.equal((await fetch(base + '/ops/inbox')).status, 401);
  const privateResponse = await fetch(base + '/ops/inbox', { headers: { authorization: 'Bearer secret' } });
  assert.equal(privateResponse.status, 200);
});

test('invalid and oversized enquiries are rejected', async t => {
  const { base } = await fixture(t);
  assert.equal((await submit(base, { name: '', contact: '', model: '' })).status, 422);
  assert.equal((await submit(base, { name: 'x'.repeat(15000), contact: 'x', model: 'Kia' })).status, 413);
});

test('robots and sitemap are served by standby', async t => {
  const { base } = await fixture(t);
  const robots = await fetch(base + '/robots.txt');
  assert.equal(robots.status, 200);
  assert.ok((await robots.text()).includes('Allow: /'));
  assert.equal((await fetch(base + '/sitemap.xml')).status, 200);
});

test('automatic retry sends queued request after Telegram recovers', async t => {
  let now = 1000000; let telegramCalls = 0;
  const { base, dir, app } = await fixture(t, {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_ADMIN_IDS: '111111111' },
    clock: () => now,
    fetchImpl: async () => {
      telegramCalls += 1;
      return new Response(JSON.stringify({ ok: telegramCalls > 1 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const response = await fetch(base + '/api/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Анна', contact: '@anna', model: 'Kia' }) });
  assert.equal((await response.json()).delivery, 'queued');
  now += 61000;
  const retried = await app.retryDue();
  assert.equal(retried.length, 1);
  const saved = JSON.parse(await readFile(path.join(dir, 'data', 'inbox.json'), 'utf8'));
  assert.equal(saved[0].status, 'delivered');
});

test('approved reviews are served from the local snapshot without Cloudflare', async t => {
  const { base, dir } = await fixture(t);
  await mkdir(path.join(dir, 'data'), { recursive: true });
  await writeFile(path.join(dir, 'data', 'public-snapshot.json'), JSON.stringify({ reviews: [{ id: 'review_1', text: 'Спасибо за подбор автомобиля, всё прошло отлично.', mediaItems: [] }] }));
  const response = await fetch(base + '/api/reviews');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).reviews[0].id, 'review_1');
});


test('transactional inbox store is used for enqueue and Telegram runs outside its transaction', async t => {
  let items = [];
  let insideTransaction = false;
  const store = {
    async readInbox() { return structuredClone(items); },
    async transactInbox(mutator) {
      insideTransaction = true;
      try {
        const working = structuredClone(items);
        const outcome = await mutator(working);
        items = outcome.items;
        return outcome.result;
      } finally {
        insideTransaction = false;
      }
    }
  };
  let deliveryCalls = 0;
  const { base } = await fixture(t, {
    inboxStore: store,
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_ADMIN_IDS: '111111111' },
    fetchImpl: async () => {
      assert.equal(insideTransaction, false, 'Telegram HTTP call must happen outside the DB transaction');
      deliveryCalls += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const body = { name: 'Мария', contact: '@maria', model: 'Kia Sportage' };
  const first = await submit(base, body, 'ydb-request-123456');
  const second = await submit(base, body, 'ydb-request-123456');
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(deliveryCalls, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'delivered');
});

test('concurrent duplicate submissions with the same idempotency key create one inbox item', async t => {
  const { base, dir } = await fixture(t);
  const body = { name: 'Мария', contact: '+49 151 2345 6789', model: 'Kia Sportage' };
  const responses = await Promise.all(Array.from({ length: 5 }, () =>
    submit(base, body, 'concurrent-request-123456')
  ));
  for (const response of responses) assert.equal(response.status, 202);
  const saved = JSON.parse(await readFile(path.join(dir, 'data', 'inbox.json'), 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].idempotencyKey, 'concurrent-request-123456');
});

test('phone-only contact is delivered privately to each unique configured admin', async t => {
  const calls = [];
  const { base } = await fixture(t, {
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_ADMIN_IDS: '111111111,222222222 111111111', STANDBY_ADMIN_TOKEN: 'secret' },
    fetchImpl: async (url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const response = await submit(base, { name: 'Иван', contact: '+49 151 2345 6789', model: 'Kia Sportage' }, 'phone-contact-123456');
  assert.equal(response.status, 202);
  assert.equal((await response.json()).delivery, 'sent');
  assert.deepEqual(calls.map(call => String(call.chat_id)).sort(), ['111111111', '222222222']);
  assert.ok(calls.every(call => call.text.includes('+49 151 2345 6789')));
});

test('partial admin delivery retries only the admin who did not receive the enquiry', async t => {
  let secondAdminFails = true;
  const calls = [];
  let now = 500000;
  const { base, dir, app } = await fixture(t, {
    clock: () => now,
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_ADMIN_IDS: '111111111,222222222' },
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(String(body.chat_id));
      const ok = body.chat_id === '111111111' || !secondAdminFails;
      return new Response(JSON.stringify({ ok }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const response = await submit(base, { name: 'Ольга', contact: '+7 999 123-45-67', model: 'Kia K5' });
  assert.equal((await response.json()).delivery, 'queued');
  let saved = JSON.parse(await readFile(path.join(dir, 'data', 'inbox.json'), 'utf8'))[0];
  assert.deepEqual(saved.deliveredAdminIds, ['111111111']);
  secondAdminFails = false;
  now += 61000;
  await app.retryDue();
  saved = JSON.parse(await readFile(path.join(dir, 'data', 'inbox.json'), 'utf8'))[0];
  assert.equal(saved.status, 'delivered');
  assert.deepEqual(calls, ['111111111', '222222222', '222222222']);
});

test('Telegram timeout releases the delivery lease and schedules a retry', async t => {
  let now = 900000;
  let aborted = false;
  const { base, dir } = await fixture(t, {
    clock: () => now,
    telegramTimeoutMs: 25,
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_ADMIN_IDS: '111111111' },
    fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        aborted = true;
        reject(options.signal.reason);
      }, { once: true });
    })
  });
  const response = await submit(base, { name: 'Елена', contact: '+49 170 1234567', model: 'Kia Sportage' });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).delivery, 'queued');
  assert.equal(aborted, true);
  const saved = JSON.parse(await readFile(path.join(dir, 'data', 'inbox.json'), 'utf8'))[0];
  assert.equal(saved.status, 'queued');
  assert.equal(saved.attempts, 1);
  assert.equal('lockUntil' in saved, false);
  assert.ok(saved.nextAttemptAt > now);
});

test('expired sending lease is recovered by a fresh app instance after restart', async t => {
  let now = 2_000_000;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'avtoy-restart-'));
  const dataDir = path.join(dir, 'data');
  await mkdir(dataDir, { recursive: true });
  const item = {
    id: 'restart-request-1', idempotencyKey: 'restart-key-12345678',
    name: 'Павел', contact: '+7 999 111-22-33', model: 'Kia K5', comment: '',
    createdAt: new Date(now - 300_000).toISOString(), status: 'sending',
    attempts: 1, nextAttemptAt: now - 300_000, lockUntil: now - 1,
    deliveredAdminIds: []
  };
  await writeFile(path.join(dataDir, 'inbox.json'), JSON.stringify([item]));
  const publicDir = path.join(dir, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<title>standby</title>');
  const calls = [];
  const appAfterRestart = createStandbyApp({
    dataDir, publicDir, clock: () => now,
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_ADMIN_IDS: '111111111' },
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body).chat_id);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  try {
    const results = await appAfterRestart.retryDue();
    const saved = JSON.parse(await readFile(path.join(dataDir, 'inbox.json'), 'utf8'))[0];
    assert.deepEqual(results, [{ id: item.id, status: 'delivered' }]);
    assert.deepEqual(calls, ['111111111']);
    assert.equal(saved.status, 'delivered');
    assert.equal(saved.attempts, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two app instances atomically claim one enquiry and delivered items are terminal', async t => {
  let items = [];
  let transactionQueue = Promise.resolve();
  const store = {
    async readInbox() { return structuredClone(items); },
    async transactInbox(mutator) {
      const run = transactionQueue.then(async () => {
        const working = structuredClone(items);
        const outcome = await mutator(working);
        items = outcome.items;
        return outcome.result;
      });
      transactionQueue = run.catch(() => {});
      return run;
    }
  };
  let telegramCalls = 0;
  let releaseTelegram;
  const telegramGate = new Promise(resolve => { releaseTelegram = resolve; });
  const fetchImpl = async () => {
    telegramCalls += 1;
    await telegramGate;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'avtoy-two-instances-'));
  const publicDir = path.join(dir, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<title>standby</title>');
  const options = {
    dataDir: path.join(dir, 'data'), publicDir, inboxStore: store,
    env: { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_ADMIN_IDS: '111111111' },
    fetchImpl, clock: () => 4_000_000
  };
  const appA = createStandbyApp(options);
  const appB = createStandbyApp(options);
  const serverA = http.createServer(appA);
  const serverB = http.createServer(appB);
  await Promise.all([
    new Promise(resolve => serverA.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => serverB.listen(0, '127.0.0.1', resolve))
  ]);
  const baseA = 'http://127.0.0.1:' + serverA.address().port;
  try {
    const submission = submit(baseA, { name: 'Ирина', contact: '+49 151 0000000', model: 'Kia Sportage' }, 'two-instance-claim-1234');
    for (let n = 0; n < 30 && telegramCalls === 0; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(telegramCalls, 1, 'first instance should own the delivery lease');
    const competingRetry = await appB.retryDue();
    assert.deepEqual(competingRetry, []);
    assert.equal(telegramCalls, 1, 'second instance must not send while the lease is active');
    releaseTelegram();
    const response = await submission;
    assert.equal((await response.json()).delivery, 'sent');
    assert.equal(items[0].status, 'delivered');
    assert.deepEqual(await appB.retryDue(), []);
    assert.equal(telegramCalls, 1, 'delivered item must not be sent again');
  } finally {
    releaseTelegram();
    await Promise.all([
      new Promise(resolve => serverA.close(resolve)),
      new Promise(resolve => serverB.close(resolve))
    ]);
    await rm(dir, { recursive: true, force: true });
  }
});

test('public catalogue preserves mixed album order and serves every referenced media file', async t => {
  const { base, dir } = await fixture(t);
  const publicMedia = path.join(dir, 'public', 'media');
  await mkdir(publicMedia, { recursive: true });
  const photoA = Buffer.from('photo-a-original-bytes');
  const video = Buffer.from('video-original-bytes');
  const photoB = Buffer.from('photo-b-original-bytes');
  await writeFile(path.join(publicMedia, 'a.jpg'), photoA);
  await writeFile(path.join(publicMedia, 'b.mp4'), video);
  await writeFile(path.join(publicMedia, 'c.jpg'), photoB);
  await mkdir(path.join(dir, 'data'), { recursive: true });
  const mediaItems = [
    { type: 'photo', url: '/media/a.jpg' },
    { type: 'video', url: '/media/b.mp4' },
    { type: 'photo', url: '/media/c.jpg' }
  ];
  await writeFile(path.join(dir, 'data', 'public-snapshot.json'), JSON.stringify({
    schemaVersion: 1,
    updatedAt: '2026-11-14T12:00:00.000Z',
    cars: [{ id: 'car_1_2', caption: 'Kia Sportage', mediaItems }],
    reviews: [{ id: 'review_1', text: 'Отличный автомобиль и обслуживание.', mediaItems: [mediaItems[2], mediaItems[0]] }]
  }));

  const catalogue = await fetch(base + '/api/cars');
  assert.equal(catalogue.status, 200);
  const cars = await catalogue.json();
  assert.deepEqual(cars.cars[0].mediaItems, mediaItems);

  const reviewsResponse = await fetch(base + '/api/reviews');
  assert.equal(reviewsResponse.status, 200);
  const reviews = await reviewsResponse.json();
  assert.deepEqual(reviews.reviews[0].mediaItems, [mediaItems[2], mediaItems[0]]);

  for (const [url, expected, contentType] of [
    ['/media/a.jpg', photoA, 'image/jpeg'],
    ['/media/b.mp4', video, 'video/mp4'],
    ['/media/c.jpg', photoB, 'image/jpeg']
  ]) {
    const response = await fetch(base + url);
    assert.equal(response.status, 200, url + ' must be publicly retrievable');
    assert.equal(response.headers.get('content-type'), contentType);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
});



test('v2 request store handles phone-only enquiries through private Telegram delivery', async t => {
  const state = new Map();
  const store = {
    async createEnquiry(enquiry, idempotencyKey) {
      const existing = [...state.values()].find(item => idempotencyKey && item.idempotencyKey === idempotencyKey);
      if (existing) return { item:structuredClone(existing), duplicate:true };
      const item = { ...enquiry, id:'v2-request-001', idempotencyKey, createdAt:new Date(1_000_000).toISOString(), status:'queued', attempts:0, deliveredAdminIds:[] };
      state.set(item.id, item);
      return { item:structuredClone(item), duplicate:false };
    },
    async getEnquiry(id) { return structuredClone(state.get(id) || null); },
    async claimEnquiry(id) {
      const item = state.get(id);
      if (!item || item.status === 'delivered' || item.status === 'sending') return null;
      item.status = 'sending';
      item.leaseToken = 'lease-v2';
      return structuredClone(item);
    },
    async completeDelivery({ requestId, leaseToken, deliveredAdminIds, requiredAdminIds }) {
      const item = state.get(requestId);
      if (!item || item.leaseToken !== leaseToken) return null;
      item.deliveredAdminIds = [...new Set(deliveredAdminIds)];
      item.status = requiredAdminIds.every(id => item.deliveredAdminIds.includes(id)) ? 'delivered' : 'queued';
      return structuredClone(item);
    },
    async claimDueEnquiries() { return []; },
    async listPrivateEnquiries() { return [...state.values()].map(item => structuredClone(item)); }
  };
  const telegramCalls = [];
  const { base, dir } = await fixture(t, {
    requestStore:store,
    env:{ TELEGRAM_BOT_TOKEN:'test-token', TELEGRAM_ADMIN_IDS:'111111111,222222222', STANDBY_ADMIN_TOKEN:'admin-secret' },
    fetchImpl:async (_url, options) => {
      telegramCalls.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ ok:true }), { status:200, headers:{ 'content-type':'application/json' } });
    }
  });
  const response = await submit(base, { name:'Иван', contact:'+49 151 2345 6789', model:'Kia Sportage' }, 'v2-phone-request-1234');
  assert.equal(response.status, 202);
  assert.equal((await response.json()).delivery, 'sent');
  assert.deepEqual(telegramCalls.map(call => String(call.chat_id)).sort(), ['111111111','222222222']);
  assert.ok(telegramCalls.every(call => call.text.includes('+49 151 2345 6789')));
  assert.equal(state.get('v2-request-001').status, 'delivered');
  assert.equal((await fetch(base + '/ops/inbox')).status, 401);
  const privateInbox = await fetch(base + '/ops/inbox', { headers:{ authorization:'Bearer admin-secret' } });
  assert.equal(privateInbox.status, 200);
  assert.equal((await privateInbox.json()).items[0].contact, '+49 151 2345 6789');
  await assert.rejects(readFile(path.join(dir, 'data', 'inbox.json'), 'utf8'), { code:'ENOENT' });
});


test('MAX is used as privacy-safe fallback when Telegram delivery fails', async t => {
  const calls = [];
  const { base, dir } = await fixture(t, {
    env: { TELEGRAM_BOT_TOKEN:'telegram-token', TELEGRAM_ADMIN_IDS:'111111111 222222222', MAX_BOT_TOKEN:'max-token', MAX_OPERATOR_CHAT_ID:'987654321' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (String(url).startsWith('https://api.telegram.org/')) return new Response(JSON.stringify({ ok:false }), { status:200 });
      return new Response(JSON.stringify({ message:{ body:{ mid:'max-message' } } }), { status:200 });
    }
  });
  const response = await submit(base, { name:'Секретное имя', contact:'+7 999 123-45-67', model:'Kia Sportage', comment:'личные сведения' }, 'max-fallback-123456');
  assert.equal(response.status, 202);
  assert.equal((await response.json()).delivery, 'sent');
  assert.equal(calls.length, 3);
  const maxCall = calls.find(call => String(call.url).startsWith('https://platform-api2.max.ru/'));
  assert.ok(maxCall);
  assert.equal(maxCall.options.headers.Authorization, 'max-token');
  const maxText = JSON.parse(maxCall.options.body).text;
  assert.match(maxText, /Kia Sportage/);
  assert.doesNotMatch(maxText, /Секретное имя|999 123|личные сведения/);
  const saved = JSON.parse(await readFile(path.join(dir, 'data', 'inbox.json'), 'utf8'))[0];
  assert.equal(saved.status, 'delivered');
  assert.ok(saved.deliveredAdminIds.includes('operators'));
});

test('request remains queued when both Telegram and MAX are unavailable', async t => {
  let now = 1_500_000;
  let calls = 0;
  const { base, dir, app } = await fixture(t, {
    clock:()=>now,
    env: { TELEGRAM_BOT_TOKEN:'telegram-token', TELEGRAM_ADMIN_IDS:'111111111', MAX_BOT_TOKEN:'max-token', MAX_OPERATOR_CHAT_ID:'987654321' },
    fetchImpl: async () => { calls += 1; return new Response('{}', { status:503 }); }
  });
  const response = await submit(base, { name:'Иван', contact:'+7 999 111-22-33', model:'Kia' }, 'both-down-12345678');
  assert.equal((await response.json()).delivery, 'queued');
  let saved = JSON.parse(await readFile(path.join(dir, 'data', 'inbox.json'), 'utf8'))[0];
  assert.equal(saved.status, 'queued');
  assert.equal(saved.lastError, 'notification_delivery_failed');
  assert.equal(calls, 2);
  now += 61_000;
  await app.retryDue();
  saved = JSON.parse(await readFile(path.join(dir, 'data', 'inbox.json'), 'utf8'))[0];
  assert.equal(saved.status, 'queued');
  assert.equal(calls, 4);
});

test('YDB request completion uses a stable operator receipt', async t => {
  let completed;
  const request = { id:'abcd1234-0000-0000-0000-000000000000', name:'Ирина', contact:'+7 900 000-00-00', model:'Kia', status:'queued', deliveredAdminIds:[] };
  const requestStore = {
    async createEnquiry() { return { item:request, duplicate:false }; },
    async claimEnquiry() { return { ...request, leaseToken:'lease-1' }; },
    async completeDelivery(args) { completed=args; return { ...request, status:args.requiredAdminIds.every(id=>args.deliveredAdminIds.includes(id))?'delivered':'queued' }; },
    async getEnquiry() { return { ...request, status:completed?.deliveredAdminIds.includes('operators')?'delivered':'queued' }; }
  };
  const { base } = await fixture(t, {
    requestStore,
    env: { TELEGRAM_BOT_TOKEN:'telegram-token', TELEGRAM_ADMIN_IDS:'111111111 222222222' },
    fetchImpl: async () => new Response(JSON.stringify({ ok:true }), { status:200 })
  });
  const response = await submit(base, { name:'Ирина', contact:'+7 900 000-00-00', model:'Kia' }, 'ydb-operator-123456');
  assert.equal((await response.json()).delivery, 'sent');
  assert.deepEqual(completed.requiredAdminIds, ['operators']);
  assert.ok(completed.deliveredAdminIds.includes('operators'));
});


test('MAX webhook persists allowlisted operator-group event metadata before HTTP 200', async t => {
  const stored = [];
  const maxEventStore = { async recordMaxWebhookEvent(event) { stored.push(event); return { duplicate:false }; } };
  const { base } = await fixture(t, { maxEventStore, env:{ MAX_WEBHOOK_SECRET:'test_secret-123', MAX_OPERATOR_CHAT_ID:'987654321', MAX_OPERATOR_USER_IDS:'12345' } });
  const update = { update_type:'message_created',timestamp:1794740000000,message:{sender:{user_id:12345},recipient:{chat_id:987654321,chat_type:'chat'},body:{mid:'msg-001',text:'обычное сообщение без команды'}} };
  const response=await fetch(base+'/api/max/webhook',{method:'POST',headers:{'content-type':'application/json','x-max-bot-api-secret':'test_secret-123'},body:JSON.stringify(update)});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.ok,true);
  assert.equal(body.duplicate,false);
  assert.equal(body.command,'ignored');
  assert.equal(body.queuedReply,false);
  assert.equal(stored.length,1);
  assert.equal(stored[0].eventType,'message_created');
  assert.equal(stored[0].chatId,'987654321');
  assert.equal(stored[0].messageId,'msg-001');
  assert.equal(stored[0].senderUserId,'12345');
  assert.equal(Object.hasOwn(stored[0],'text'),false);
});

test('MAX webhook rejects missing or incorrect secret before persistence', async t => {
  let writes=0;
  const {base}=await fixture(t,{maxEventStore:{async recordMaxWebhookEvent(){writes++;}},env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345'}});
  const body=JSON.stringify({update_type:'message_created',timestamp:1794740000000,message:{sender:{user_id:12345},recipient:{chat_id:987654321,chat_type:'chat'},body:{mid:'m1'}}});
  for(const secret of [undefined,'wrong-secret']){
    const response=await fetch(base+'/api/max/webhook',{method:'POST',headers:{'content-type':'application/json',...(secret?{'x-max-bot-api-secret':secret}:{})},body});
    assert.equal(response.status,401);
  }
  assert.equal(writes,0);
});

test('MAX webhook rejects events outside the configured operator group', async t => {
  let writes=0;
  const {base}=await fixture(t,{maxEventStore:{async recordMaxWebhookEvent(){writes++;}},env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345'}});
  const response=await fetch(base+'/api/max/webhook',{method:'POST',headers:{'content-type':'application/json','x-max-bot-api-secret':'valid-secret-123'},body:JSON.stringify({update_type:'message_created',timestamp:1794740000000,message:{sender:{user_id:12345},recipient:{chat_id:111111111,chat_type:'chat'},body:{mid:'other-chat'}}})});
  assert.equal(response.status,403);
  assert.equal(writes,0);
});

test('MAX webhook does not acknowledge without durable storage or when persistence fails', async t => {
  let writes=0;
  const headers={'content-type':'application/json','x-max-bot-api-secret':'valid-secret-123'};
  const payload={update_type:'message_created',timestamp:1794740000000,message:{sender:{user_id:12345},recipient:{chat_id:987654321,chat_type:'chat'},body:{mid:'m1'}}};
  const missingType=await fixture(t,{env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345'},maxEventStore:{async recordMaxWebhookEvent(){writes++;}}});
  const forgedFallback=await fetch(missingType.base+'/api/max/webhook',{method:'POST',headers,body:JSON.stringify({update_type:'message_created',timestamp:1794740000000,chat_id:987654321,message:{sender:{user_id:12345},body:{mid:'missing-type'}}})});
  assert.equal(forgedFallback.status,403);
  assert.equal(writes,0);

  const noStore=await fixture(t,{env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345'}});
  assert.equal((await fetch(noStore.base+'/api/max/webhook',{method:'POST',headers,body:JSON.stringify(payload)})).status,503);
  const failed=await fixture(t,{env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345'},maxEventStore:{async recordMaxWebhookEvent(){throw new Error('db down');}}});
  assert.equal((await fetch(failed.base+'/api/max/webhook',{method:'POST',headers,body:JSON.stringify(payload)})).status,503);
});

test('MAX webhook rejects malformed, oversized and unsupported updates', async t => {
  let writes=0;
  const {base}=await fixture(t,{env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345'},maxEventStore:{async recordMaxWebhookEvent(){writes++;}}});
  const headers={'content-type':'application/json','x-max-bot-api-secret':'valid-secret-123'};
  assert.equal((await fetch(base+'/api/max/webhook',{method:'POST',headers,body:'{'})).status,400);
  assert.equal((await fetch(base+'/api/max/webhook',{method:'POST',headers,body:JSON.stringify({update_type:'bot_started',timestamp:1794740000000,chat_id:987654321})})).status,400);
  assert.equal((await fetch(base+'/api/max/webhook',{method:'POST',headers,body:' '.repeat(65000)})).status,413);
  assert.equal(writes,0);
});


test('operator panel HTML is explicitly non-cacheable', async t => {
  const { base,dir }=await fixture(t);
  await writeFile(path.join(dir,'public','ops.html'), '<title>Operator panel</title>');
  const response=await fetch(base+'/ops');
  assert.equal(response.status,200);
  assert.match(response.headers.get('cache-control') || '',/no-store/);
  assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
});

test('operator panel is served locally and does not embed an admin token', async t => {
  const {base,dir}=await fixture(t);
  await writeFile(path.join(dir,'public','ops.html'),'<!doctype html><title>AVTOY operator panel</title><script>let token = ""; fetch("/ops/inbox")</script>');
  const response=await fetch(base+'/ops');
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-security-policy'),/connect-src 'self'/);
  const html=await response.text();
  assert.match(html,/AVTOY operator panel/);
  assert.doesNotMatch(html,/STANDBY_ADMIN_TOKEN/);
});

test('operator inbox API remains protected from unauthenticated requests', async t => {
  const {base}=await fixture(t,{env:{STANDBY_ADMIN_TOKEN:'admin-secret'}});
  assert.equal((await fetch(base+'/ops/inbox')).status,401);
  assert.equal((await fetch(base+'/ops/inbox',{headers:{authorization:'Bearer admin-secret'}})).status,200);
});


test('operator panel keeps admin token in memory and provides phone contact actions', async () => {
  const html=await readFile(new URL('../public/ops.html',import.meta.url),'utf8');
  assert.match(html,/tel:/);
  assert.match(html,/sms:/);
  assert.match(html,/textContent/);
  assert.doesNotMatch(html,/localStorage/);
});


test('MAX webhook does not persist commands when outbound bot credentials are missing', async t => {
  let writes=0;
  const {base}=await fixture(t,{
    env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345'},
    maxEventStore:{async recordMaxWebhookEvent(){writes++;return {duplicate:false};}}
  });
  const response=await fetch(base+'/api/max/webhook',{
    method:'POST',
    headers:{'content-type':'application/json','x-max-bot-api-secret':'valid-secret-123'},
    body:JSON.stringify({
      update_type:'message_created',timestamp:1794740000000,
      message:{sender:{user_id:12345},recipient:{chat_id:987654321,chat_type:'chat'},body:{mid:'help-no-outbound',text:'!help'}}
    })
  });
  assert.equal(response.status,503);
  assert.equal(writes,0);
});

test('MAX webhook rejects a non-allowlisted group member', async t => {
  let writes=0;
  const {base}=await fixture(t,{env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345'},maxEventStore:{async recordMaxWebhookEvent(){writes++;}}});
  const response=await fetch(base+'/api/max/webhook',{method:'POST',headers:{'content-type':'application/json','x-max-bot-api-secret':'valid-secret-123'},body:JSON.stringify({
    update_type:'message_created',timestamp:1794740000000,message:{sender:{user_id:99999},recipient:{chat_id:987654321,chat_type:'chat'},body:{mid:'unauthorized'}}
  })});
  assert.equal(response.status,403);
  assert.equal(writes,0);
});

test('MAX callback authorizes the clicking operator, not the bot message sender', async t => {
  const stored=[];
  const {base}=await fixture(t,{env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345'},maxEventStore:{async recordMaxWebhookEvent(event){stored.push(event);return {duplicate:false};}}});
  const response=await fetch(base+'/api/max/webhook',{method:'POST',headers:{'content-type':'application/json','x-max-bot-api-secret':'valid-secret-123'},body:JSON.stringify({
    update_type:'message_callback',timestamp:1794740000000,
    callback:{user:{user_id:12345},callback_id:'cb-1',payload:'approve'},
    message:{sender:{user_id:55555,is_bot:true},recipient:{chat_id:987654321,chat_type:'chat'},body:{mid:'bot-message'}}
  })});
  assert.equal(response.status,200);
  assert.equal(stored[0].senderUserId,'12345');
});

test('per-operator auth enforces roles and records durable audit before inbox access', async t => {
  const token='A'.repeat(43);
  const { digestOperatorToken } = await import('../security/operator-auth.mjs');
  const audit=[];
  const requestStore={async listPrivateEnquiries(){return [{id:'r1',name:'A',contact:'+7',model:'Kia',comment:'',createdAt:'2026-11-15',status:'queued',attempts:0,lastError:null}]}};
  const auditStore={async recordOperatorAuditEvent(event){audit.push(event)}};
  const { base }=await fixture(t,{
    env:{STANDBY_OPERATORS_JSON:JSON.stringify([{id:'op-1',tokenHash:digestOperatorToken(token),role:'operator',enabled:true}])},
    requestStore,auditStore
  });
  const inbox=await fetch(base+'/ops/inbox',{headers:{authorization:'Bearer '+token}});
  assert.equal(inbox.status,200);
  assert.equal((await inbox.json()).operator.id,'op-1');
  const retry=await fetch(base+'/ops/retry',{method:'POST',headers:{authorization:'Bearer '+token}});
  assert.equal(retry.status,403);
  assert.equal(audit.length,2);
  assert.equal(audit[0].action,'inbox.read');
  assert.equal(audit[1].action,'auth.forbidden');
});

test('per-operator sensitive actions fail closed when durable audit is unavailable', async t => {
  const token='B'.repeat(43);
  const { digestOperatorToken } = await import('../security/operator-auth.mjs');
  let retryCalls=0;
  const requestStore={async claimDueEnquiries(){retryCalls++;return []}};
  const { base }=await fixture(t,{
    env:{STANDBY_OPERATORS_JSON:JSON.stringify([{id:'supervisor-1',tokenHash:digestOperatorToken(token),role:'supervisor',enabled:true}])},
    requestStore,auditStore:{async recordOperatorAuditEvent(){throw new Error('YDB unavailable')}}
  });
  const response=await fetch(base+'/ops/retry',{method:'POST',headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,503);
  assert.equal(retryCalls,0);
});

test('production does not accept the legacy shared admin token', async t => {
  const { base }=await fixture(t,{env:{NODE_ENV:'production',STANDBY_ADMIN_TOKEN:'legacy-secret'}});
  const response=await fetch(base+'/ops/inbox',{headers:{authorization:'Bearer legacy-secret'}});
  assert.equal(response.status,401);
});

test('supervisor retry is durably audited before queue work begins', async t => {
  const token='C'.repeat(43);
  const { digestOperatorToken } = await import('../security/operator-auth.mjs');
  const order=[];
  const requestStore={async claimDueEnquiries(){order.push('retry');return []}};
  const auditStore={async recordOperatorAuditEvent(event){order.push('audit');assert.equal(event.action,'notifications.retry')}};
  const { base }=await fixture(t,{
    env:{STANDBY_OPERATORS_JSON:JSON.stringify([{id:'supervisor-2',tokenHash:digestOperatorToken(token),role:'supervisor',enabled:true}])},
    requestStore,auditStore
  });
  const response=await fetch(base+'/ops/retry',{method:'POST',headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,200);
  assert.deepEqual(order,['audit','retry']);
});

test('legacy shared token is denied when NODE_ENV is missing, not only in production', async t => {
  const { base }=await fixture(t,{env:{NODE_ENV:'',STANDBY_ADMIN_TOKEN:'legacy-secret'}});
  const response=await fetch(base+'/ops/inbox',{headers:{authorization:'Bearer legacy-secret'}});
  assert.equal(response.status,401);
});

test('only supervisor and owner can read the audit endpoint', async t => {
  const token='D'.repeat(43);
  const { digestOperatorToken } = await import('../security/operator-auth.mjs');
  const audit=[];
  const auditStore={
    async recordOperatorAuditEvent(event){audit.push(event)},
    async listOperatorAuditEvents(){return [{eventId:'e1',action:'inbox.read',actorId:'operator-a'}]}
  };
  const { base }=await fixture(t,{
    env:{STANDBY_OPERATORS_JSON:JSON.stringify([{id:'supervisor-a',tokenHash:digestOperatorToken(token),role:'supervisor',enabled:true}])},
    auditStore
  });
  const response=await fetch(base+'/ops/audit',{headers:{authorization:'Bearer '+token}});
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.events[0].eventId,'e1');
  assert.equal(audit.at(-1).action,'audit.read');
});

test('operator panel exposes audit only through role-aware controls', async () => {
  const html=await readFile(new URL('../public/ops.html',import.meta.url),'utf8');
  assert.match(html,/\/ops\/audit/);
  assert.match(html,/audit:read/);
  assert.match(html,/notifications:retry/);
  assert.match(html,/operatorInfo/);
  assert.doesNotMatch(html,/localStorage|sessionStorage/);
  assert.match(html,/textContent/);
});

test('failed operator authentication is audited without credentials and rate limited', async t => {
  const token='E'.repeat(43);
  const { digestOperatorToken } = await import('../security/operator-auth.mjs');
  const events=[];
  const auditStore={async recordOperatorAuditEvent(event){events.push(event)}};
  const { base }=await fixture(t,{
    env:{STANDBY_OPERATORS_JSON:JSON.stringify([{id:'operator-z',tokenHash:digestOperatorToken(token),role:'operator',enabled:true}])},
    auditStore
  });
  const bad='F'.repeat(43);
  for(let i=0;i<10;i++){
    const response=await fetch(base+'/ops/inbox',{headers:{authorization:'Bearer '+bad}});
    assert.equal(response.status,401);
  }
  const blocked=await fetch(base+'/ops/inbox',{headers:{authorization:'Bearer '+bad}});
  assert.equal(blocked.status,429);
  assert.equal(events.length,10);
  assert.ok(events.every(event=>event.action==='auth.denied' && event.actorId==='unauthenticated'));
  assert.equal(JSON.stringify(events).includes(bad),false);
});

test('legacy shared token is denied in development unless test mode is explicit', async t => {
  const { base }=await fixture(t,{env:{NODE_ENV:'development',STANDBY_ADMIN_TOKEN:'legacy-secret'}});
  const response=await fetch(base+'/ops/inbox',{headers:{authorization:'Bearer legacy-secret'}});
  assert.equal(response.status,401);
});


test('production admin and MAX webhook require complete durable YDB request, audit and receipt capabilities', () => {
  assert.equal(assertDurableAdminRuntime(),true);
  assert.throws(() => assertDurableAdminRuntime({ operatorsConfigured:true }), /durable YDB/);
  assert.throws(() => assertDurableAdminRuntime({ maxWebhookConfigured:true }), /durable YDB/);
  const base={ensureMaxWebhookSchema(){},ensureMaxCommandReplySchema(){},verifySchema(){}};
  assert.throws(() => assertDurableAdminRuntime({operatorsConfigured:true,requestStore:base}), /durable enquiry persistence/);
  assert.throws(() => assertDurableAdminRuntime({maxWebhookConfigured:true,requestStore:base}), /durable enquiry persistence/);
  const store={
    ...base,
    verifySchema(){},
    createEnquiry(){},getEnquiry(){},claimEnquiry(){},claimDueEnquiries(){},listPrivateEnquiries(){},completeDelivery(){},
    ensureOperatorAuditSchema(){},consumeOperatorAuthFailure(){},recordOperatorAuditEvent(){},listOperatorAuditEvents(){},
    recordMaxWebhookEvent(){},claimDueMaxCommandReplies(){},completeMaxCommandReply(){},failMaxCommandReply(){}
  };
  assert.equal(assertDurableAdminRuntime({operatorsConfigured:true,requestStore:store}),true);
  assert.equal(assertDurableAdminRuntime({maxWebhookConfigured:true,requestStore:store}),true);
  const noOutbox={...store,claimDueMaxCommandReplies:undefined};
  assert.throws(()=>assertDurableAdminRuntime({maxWebhookConfigured:true,requestStore:noOutbox}),/durable retryable command reply outbox/);
  const noMaxReceipts={...store,recordMaxWebhookEvent:undefined};
  assert.throws(()=>assertDurableAdminRuntime({maxWebhookConfigured:true,requestStore:noMaxReceipts}),/idempotent webhook receipt storage/);
  const noAudit={...store,recordOperatorAuditEvent:undefined};
  assert.throws(()=>assertDurableAdminRuntime({operatorsConfigured:true,requestStore:noAudit}),/audit, rate-limit and inbox/);
});


test('operator authentication uses the durable shared rate limiter when available', async t => {
  const token='G'.repeat(43);
  const { digestOperatorToken } = await import('../security/operator-auth.mjs');
  const calls=[];
  const auditStore={
    async consumeOperatorAuthFailure(input){calls.push(input);return {allowed:calls.length<=2,failures:calls.length}},
    async recordOperatorAuditEvent(){}
  };
  const {base}=await fixture(t,{
    env:{STANDBY_OPERATORS_JSON:JSON.stringify([{id:'operator-shared',tokenHash:digestOperatorToken(token),role:'operator',enabled:true}])},
    auditStore
  });
  for(let i=0;i<3;i++){
    const response=await fetch(base+'/ops/inbox',{headers:{authorization:'Bearer '+'H'.repeat(43)}});
    assert.equal(response.status,i<2?401:429);
  }
  assert.equal(calls.length,3);
  assert.match(calls[0].keyDigest,/^[a-f0-9]{64}$/);
});


test('production Russian standby cannot start with local JSON or a partial YDB request store', () => {
  assert.equal(assertProductionRequestStore(),true);
  assert.equal(assertProductionRequestStore({nodeEnv:'test'}),true);
  assert.throws(()=>assertProductionRequestStore({nodeEnv:'production',inboxStoreMode:'',ydbConnectionString:'grpcs://db'}),/INBOX_STORE=v2/);
  assert.throws(()=>assertProductionRequestStore({nodeEnv:'production',inboxStoreMode:'v2'}),/connected durable YDB/);
  const partial={verifySchema(){},createEnquiry(){}};
  assert.throws(()=>assertProductionRequestStore({nodeEnv:'production',inboxStoreMode:'v2',ydbConnectionString:'grpcs://db',requestStore:partial}),/request store is incomplete/);
  const complete={verifySchema(){},createEnquiry(){},getEnquiry(){},claimEnquiry(){},claimDueEnquiries(){},listPrivateEnquiries(){},completeDelivery(){}};
  assert.equal(assertProductionRequestStore({nodeEnv:'production',inboxStoreMode:'v2',ydbConnectionString:'grpcs://db',requestStore:complete}),true);
});


test('MAX !help command replies only to the configured operator group and audits the action', async t => {
  const stored=[];
  const maxEventStore={async recordMaxWebhookEvent(event){stored.push(event);return {duplicate:false};}};
  const {base}=await fixture(t,{
    maxEventStore,
    env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345',MAX_BOT_TOKEN:'max-token'}
  });
  const update={update_type:'message_created',timestamp:1794740000000,message:{sender:{user_id:12345},recipient:{chat_id:987654321,chat_type:'chat'},body:{mid:'help-001',text:'!help'}}};
  const response=await fetch(base+'/api/max/webhook',{method:'POST',headers:{'content-type':'application/json','x-max-bot-api-secret':'valid-secret-123'},body:JSON.stringify(update)});
  assert.equal(response.status,200);
  assert.equal((await response.json()).command,'help');
  assert.equal(stored.length,1);
  assert.equal(stored[0].reply.commandKind,'help');
  assert.equal(stored[0].reply.actorId,'12345');
  assert.match(stored[0].reply.text,/!status/);
  assert.deepEqual(stored[0].reply.auditEvent,{eventId:stored[0].reply.auditEvent.eventId,targetId:'group'});
  assert.equal(Object.hasOwn(stored[0].reply,'chatId'),false);
});

test('MAX !status command returns only enquiry state and never customer contact details', async t => {
  const stored=[];
  const id='abcd1234-1234-4234-8234-123456789abc';
  const requestStore={async getEnquiry(value){assert.equal(value,id);return {id,status:'queued',name:'Секретное имя',contact:'+7 999 123-45-67',model:'Kia Sportage'};}};
  const maxEventStore={async recordMaxWebhookEvent(event){stored.push(event);return {duplicate:false};}};
  const {base}=await fixture(t,{
    requestStore,maxEventStore,
    env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345',MAX_BOT_TOKEN:'max-token'}
  });
  const update={update_type:'message_created',timestamp:1794740000000,message:{sender:{user_id:12345},recipient:{chat_id:987654321,chat_type:'chat'},body:{mid:'status-001',text:'!status '+id}}};
  const response=await fetch(base+'/api/max/webhook',{method:'POST',headers:{'content-type':'application/json','x-max-bot-api-secret':'valid-secret-123'},body:JSON.stringify(update)});
  assert.equal(response.status,200);
  assert.equal((await response.json()).command,'status');
  assert.equal(stored[0].reply.commandKind,'status');
  assert.match(stored[0].reply.text,/Заявка abcd1234: queued/);
  assert.doesNotMatch(stored[0].reply.text,/Секретное имя|999 123|Sportage/);
  assert.equal(stored[0].reply.auditEvent.targetId,id);
});


test('MAX outbox dispatcher sends a leased reply and completes it with the same fencing token', async t => {
  const completed=[];
  const sent=[];
  const requestStore={
    async claimDueMaxCommandReplies(){return [{eventDigest:'d'.repeat(64),commandKind:'help',actorId:'12345',text:'Безопасный ответ',leaseToken:'lease-1'}];},
    async completeMaxCommandReply(input){completed.push(input);return {status:'sent'};},
    async failMaxCommandReply(){assert.fail('successful MAX send must not be failed');}
  };
  const {app}=await fixture(t,{
    requestStore,
    env:{MAX_OPERATOR_CHAT_ID:'987654321',MAX_BOT_TOKEN:'max-token'},
    fetchImpl:async(url,options)=>{sent.push({url:String(url),body:JSON.parse(options.body)});return new Response(JSON.stringify({success:true}),{status:200});}
  });
  const result=await app.retryMaxCommandReplies();
  assert.equal(result[0].status,'sent');
  assert.equal(sent.length,1);
  assert.equal(sent[0].url,'https://platform-api2.max.ru/messages?chat_id=987654321');
  assert.equal(sent[0].body.text,'Безопасный ответ');
  assert.equal(completed[0].leaseToken,'lease-1');
});

test('MAX outbox dispatcher schedules retry for rate-limited API responses', async t => {
  const failures=[];
  const requestStore={
    async claimDueMaxCommandReplies(){return [{eventDigest:'e'.repeat(64),text:'safe',leaseToken:'lease-2'}];},
    async completeMaxCommandReply(){assert.fail('429 must not complete delivery');},
    async failMaxCommandReply(input){failures.push(input);return {status:'queued'};}
  };
  const {app}=await fixture(t,{
    requestStore,
    env:{MAX_OPERATOR_CHAT_ID:'987654321',MAX_BOT_TOKEN:'max-token'},
    fetchImpl:async()=>new Response(JSON.stringify({success:false}),{status:429,headers:{'retry-after':'3600'}})
  });
  const result=await app.retryMaxCommandReplies();
  assert.equal(result[0].status,'queued');
  assert.equal(failures[0].retryable,true);
  assert.equal(failures[0].errorCode,'max_rate_limited');
  assert.equal(failures[0].retryBaseMs,60 * 60_000);
  assert.equal(failures[0].retryMaxMs,6 * 60 * 60_000);
});


test('MAX status reply allowlists state values even if stored status is corrupted', async t => {
  const stored=[];
  const id='abcd1234-1234-4234-8234-123456789abc';
  const requestStore={async getEnquiry(){return {id,status:'+7 999 123-45-67',contact:'private'};}};
  const maxEventStore={async recordMaxWebhookEvent(event){stored.push(event);return {duplicate:false};}};
  const {base}=await fixture(t,{requestStore,maxEventStore,env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345'}});
  const update={update_type:'message_created',timestamp:1794740000000,message:{sender:{user_id:12345},recipient:{chat_id:987654321,chat_type:'chat'},body:{mid:'status-002',text:'!status '+id}}};
  const response=await fetch(base+'/api/max/webhook',{method:'POST',headers:{'content-type':'application/json','x-max-bot-api-secret':'valid-secret-123'},body:JSON.stringify(update)});
  assert.equal(response.status,200);
  assert.match(stored[0].reply.text,/неизвестно/);
  assert.doesNotMatch(stored[0].reply.text,/999 123|private/);
});


test('MAX callback fails closed when the original message and recipient context are absent', async t => {
  let writes=0;
  const {base}=await fixture(t,{
    env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345'},
    maxEventStore:{async recordMaxWebhookEvent(){writes++;}}
  });
  const response=await fetch(base+'/api/max/webhook',{method:'POST',headers:{'content-type':'application/json','x-max-bot-api-secret':'valid-secret-123'},body:JSON.stringify({
    update_type:'message_callback',timestamp:1794740000000,
    callback:{user:{user_id:12345},callback_id:'cb-no-message',payload:'safe'},
    message:null
  })});
  assert.equal(response.status,403);
  assert.equal(writes,0);
});

test('MAX callback rejects a channel recipient even when the clicking operator is allowlisted', async t => {
  let writes=0;
  const {base}=await fixture(t,{
    env:{MAX_WEBHOOK_SECRET:'valid-secret-123',MAX_OPERATOR_CHAT_ID:'987654321',MAX_OPERATOR_USER_IDS:'12345'},
    maxEventStore:{async recordMaxWebhookEvent(){writes++;}}
  });
  const response=await fetch(base+'/api/max/webhook',{method:'POST',headers:{'content-type':'application/json','x-max-bot-api-secret':'valid-secret-123'},body:JSON.stringify({
    update_type:'message_callback',timestamp:1794740000000,
    callback:{user:{user_id:12345},callback_id:'cb-channel',payload:'safe'},
    message:{sender:{user_id:55555,is_bot:true},recipient:{chat_id:987654321,chat_type:'channel'},body:{mid:'channel-message'}}
  })});
  assert.equal(response.status,403);
  assert.equal(writes,0);
});
