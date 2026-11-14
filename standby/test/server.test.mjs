import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createStandbyApp } from '../server.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'avtoy-standby-'));
  const publicDir = path.join(dir, 'public');
  await mkdir(publicDir, { recursive: true });
  await writeFile(path.join(publicDir, 'index.html'), '<title>AVTOY KOREA — резервный сайт</title>');
  const app = createStandbyApp({ dataDir: path.join(dir, 'data'), publicDir, ...options });
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

