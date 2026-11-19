import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { crosspostCarToMax, deliverOrderToMax, handleMaxBotWebhook } from "./max-worker-bridge.js";

function memoryKV() {
  const map = new Map();
  return {
    async get(k) { return map.has(k) ? map.get(k) : null; },
    async put(k, v) { map.set(k, String(v)); },
    async delete(k) { map.delete(k); },
    async list({ prefix = "" } = {}) {
      const keys = [...map.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name }));
      return { keys, list_complete: true };
    }
  };
}

test("deliverOrderToMax sends full details to private MAX admins and PII-free summary to MAX group", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  const env = {
    MAX_BOT_TOKEN: "max-secret-token",
    MAX_ADMIN_IDS: "7001, 7002",
    MAX_OPERATOR_CHAT_ID: "900999"
  };
  const order = { id: "ord1234567890abc", number: "1790000111" };
  const fields = { name: "Иван Петров", contact: "+79991112233", model: "Kia Sportage", budget: "3.2 млн", country: "Южная Корея", year: "2023", purpose: "Подбор автомобиля", details: "Панорама" };
  const idem = { deliveredMaxTargets: [] };

  const res = await deliverOrderToMax(env, order, fields, idem, async () => {}, fakeFetch);
  assert.equal(res.configured, true);
  assert.equal(res.deliveredAll, true);
  assert.equal(calls.length, 3);

  const privateCall = calls.find(c => c.url.includes("user_id=7001"));
  assert.ok(privateCall.body.text.includes("Иван Петров"));
  assert.ok(privateCall.body.text.includes("+79991112233"));

  const groupCall = calls.find(c => c.url.includes("chat_id=900999"));
  assert.ok(!groupCall.body.text.includes("Иван Петров"));
  assert.ok(!groupCall.body.text.includes("+79991112233"));
  assert.ok(groupCall.body.text.includes("Kia Sportage"));
});

test("handleMaxBotWebhook supports /myid, admin /site, !unpublish and customer forwarding", async () => {
  const kv = memoryKV();
  await kv.put("car_approved:car_1002326996766_3482", JSON.stringify({ id: "car_1002326996766_3482", caption: "исправить" }));
  const sentMax = [];
  const sentTg = [];
  const fakeFetch = async (url, init) => {
    sentMax.push({ url: String(url), text: JSON.parse(init.body).text });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  const env = {
    REVIEWS: kv,
    MAX_BOT_TOKEN: "max-token",
    MAX_WEBHOOK_SECRET: "wh-secret-123",
    MAX_ADMIN_IDS: "555001"
  };

  // 1. /myid from any user
  const myidReq = new Request("https://worker.test/max/webhook", {
    method: "POST",
    headers: { "x-max-bot-api-secret": "wh-secret-123" },
    body: JSON.stringify({
      update_type: "message_created",
      message: { sender: { user_id: 888999, name: "Гость" }, recipient: { chat_type: "dialog", chat_id: 101 }, body: { text: "/myid" } }
    })
  });
  const r1 = await handleMaxBotWebhook(myidReq, env, { fetchImpl: fakeFetch });
  assert.equal(r1.status, 200);
  assert.match(sentMax.at(-1).text, /Ваш MAX User ID: 888999/);

  // 2. Admin !unpublish broken car directly from MAX
  const unpubReq = new Request("https://worker.test/max/webhook", {
    method: "POST",
    headers: { "x-max-bot-api-secret": "wh-secret-123" },
    body: JSON.stringify({
      update_type: "message_created",
      message: { sender: { user_id: 555001, name: "Админ" }, recipient: { chat_type: "dialog", chat_id: 202 }, body: { text: "!unpublish car_1002326996766_3482" } }
    })
  });
  const r2 = await handleMaxBotWebhook(unpubReq, env, {
    fetchImpl: fakeFetch,
    unpublishById: async id => {
      await kv.delete("car_approved:" + id);
      return true;
    }
  });
  assert.equal(r2.status, 200);
  assert.equal(await kv.get("car_approved:car_1002326996766_3482"), null);
  assert.match(sentMax.at(-1).text, /снята с сайта/);

  // 3. Customer message in MAX forwards to both MAX admin and Telegram admin
  const custReq = new Request("https://worker.test/max/webhook", {
    method: "POST",
    headers: { "x-max-bot-api-secret": "wh-secret-123" },
    body: JSON.stringify({
      update_type: "message_created",
      message: { sender: { user_id: 777111, name: "Алексей" }, recipient: { chat_type: "dialog", chat_id: 303 }, body: { text: "Хочу Hyundai Palisade до 4 млн" } }
    })
  });
  const r3 = await handleMaxBotWebhook(custReq, env, {
    fetchImpl: fakeFetch,
    telegramAdminIds: ["111222"],
    callTelegram: async (_env, method, payload) => {
      sentTg.push({ method, payload });
      return { ok: true };
    }
  });
  assert.equal(r3.status, 200);
  assert.equal(sentTg.length, 1);
  assert.match(sentTg[0].payload.text, /Hyundai Palisade/);
  assert.ok(sentMax.some(m => m.url.includes("user_id=555001") && m.text.includes("Hyundai Palisade")));
});

test("Worker CORS allows Russian GitVerse/Yandex mirror origins on /api/request and /api/cars", async () => {
  const kv = memoryKV();
  const res = await worker.fetch(
    new Request("https://worker.test/api/request", {
      method: "OPTIONS",
      headers: { Origin: "https://avtoy-korea.gitverse.ru" }
    }),
    { REVIEWS: kv }
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://avtoy-korea.gitverse.ru");
});

test("MAX public group car sync publishes to website, crossposts to @avtoYkorea without loop, and ignores regular customer messages", async () => {
  const kv = memoryKV();
  const env = {
    REVIEWS: kv,
    MAX_BOT_TOKEN: "max-token",
    MAX_WEBHOOK_SECRET: "max-sec",
    MAX_ADMIN_IDS: "555001",
    TELEGRAM_BOT_TOKEN: "tg-token",
    TELEGRAM_ADMIN_IDS: "111111111",
    TELEGRAM_WEBHOOK_SECRET: "tg-sec",
    TELEGRAM_CHANNEL_USERNAME: "avtoYkorea",
    AUTO_PUBLISH_CARS: "1"
  };

  const origFetch = globalThis.fetch;
  const maxMsgs = [];
  const tgApiCalls = [];
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.includes("platform-api2.max.ru/messages")) {
      maxMsgs.push(JSON.parse(init.body));
      return Response.json({ success: true });
    }
    if (s === "https://cdn.max.ru/car1.jpg") {
      return new Response(new Uint8Array([5, 6, 7]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (s.startsWith("https://api.telegram.org/bot")) {
      tgApiCalls.push({ url: s, isForm: init.body instanceof FormData });
      return Response.json({
        ok: true,
        result: { message_id: 901, photo: [{ file_id: "TG_CROSS_1", file_unique_id: "UTG1", width: 1280, height: 960 }] }
      });
    }
    return origFetch(url, init);
  };

  try {
    // 1. Bind group from MAX admin
    const bindRes = await worker.fetch(new Request("https://worker.test/max/webhook", {
      method: "POST",
      headers: { "x-max-bot-api-secret": "max-sec", "content-type": "application/json" },
      body: JSON.stringify({
        update_type: "message_created",
        message: { sender: { user_id: 555001 }, recipient: { chat_type: "chat", chat_id: 7770001 }, body: { text: "/bindgroup" } }
      })
    }), env);
    assert.equal(bindRes.status, 200);
    assert.equal(await kv.get("site_config:max_public_group_id"), "7770001");

    // 2. Customer chat message in public group is ignored silently (no car created, no error)
    const custGroupRes = await worker.fetch(new Request("https://worker.test/max/webhook", {
      method: "POST",
      headers: { "x-max-bot-api-secret": "max-sec", "content-type": "application/json" },
      body: JSON.stringify({
        update_type: "message_created",
        message: {
          sender: { user_id: 999888, name: "Клиент" },
          recipient: { chat_type: "chat", chat_id: 7770001 },
          body: { mid: "mid-cust-1", text: "Здравствуйте! Сколько стоит пригон Kia?" },
          attachments: [{ type: "image", payload: { url: "https://cdn.max.ru/car1.jpg" } }]
        }
      })
    }), env);
    assert.equal(custGroupRes.status, 200);
    assert.equal((await custGroupRes.json()).ignored, true);
    assert.equal((await kv.list({ prefix: "car_approved:" })).keys.length, 0);

    // 3. MAX admin posts a car listing -> publishes on site & crossposts to @avtoYkorea
    const carCaption = "Hyundai Palisade\nГод выпуска: 2024\nПробег: 12 000 км\nЦена под ключ: 4.500.000 ₽";
    const adminCarRes = await worker.fetch(new Request("https://worker.test/max/webhook", {
      method: "POST",
      headers: { "x-max-bot-api-secret": "max-sec", "content-type": "application/json" },
      body: JSON.stringify({
        update_type: "message_created",
        message: {
          sender: { user_id: 555001 },
          recipient: { chat_type: "chat", chat_id: 7770001 },
          body: {
            mid: "4200999",
            text: carCaption,
            attachments: [{ type: "image", payload: { url: "https://cdn.max.ru/car1.jpg" } }]
          }
        }
      })
    }), env);
    assert.equal(adminCarRes.status, 200);
    const carJson = await adminCarRes.json();
    assert.equal(carJson.carSync.ok, true);
    assert.equal(carJson.carSync.telegramCrossposted, true);
    assert.equal(tgApiCalls.filter(c => c.url.includes("sendPhoto")).length, 1);

    const saved = JSON.parse(await kv.get("car_approved:" + carJson.carSync.id));
    assert.equal(saved.photos[0].file_id, "TG_CROSS_1");

    // 4. Telegram webhook echoes message_id 901 back -> skipped (no duplicate car created, no bounce to MAX)
    const maxCountBefore = maxMsgs.length;
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "tg-sec", "content-type": "application/json" },
      body: JSON.stringify({
        update_id: 8801,
        channel_post: {
          message_id: 901,
          date: 1790000000,
          chat: { id: -100555, username: "avtoYkorea", type: "channel" },
          caption: carCaption,
          photo: [{ file_id: "TG_CROSS_1", file_unique_id: "UTG1", width: 1280, height: 960 }]
        }
      })
    }), env);
    assert.equal((await kv.list({ prefix: "car_approved:" })).keys.length, 1);
    assert.equal(maxMsgs.length, maxCountBefore);

    // 5. Posting the exact same car again in MAX is skipped as duplicate
    const dupRes = await worker.fetch(new Request("https://worker.test/max/webhook", {
      method: "POST",
      headers: { "x-max-bot-api-secret": "max-sec", "content-type": "application/json" },
      body: JSON.stringify({
        update_type: "message_created",
        message: {
          sender: { user_id: 555001 },
          recipient: { chat_type: "chat", chat_id: 7770001 },
          body: {
            mid: "4201000",
            text: carCaption,
            attachments: [{ type: "image", payload: { url: "https://cdn.max.ru/car1.jpg" } }]
          }
        }
      })
    }), env);
    assert.equal((await dupRes.json()).carSync.skippedDuplicate, true);
    assert.equal((await kv.list({ prefix: "car_approved:" })).keys.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("crosspostCarToMax uploads image tokens via /uploads and enforces idempotency per car ID", async () => {
  const kv = memoryKV();
  const env = { REVIEWS: kv, MAX_BOT_TOKEN: "max-tok", MAX_PUBLIC_GROUP_ID: "7770001" };
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    if (String(url).includes("/uploads")) return Response.json({ url: "https://upload.max.ru/u/abc", token: "tok1" });
    if (String(url).startsWith("https://upload.max.ru/")) return Response.json({ token: "tok1" });
    if (String(url).includes("/messages")) return Response.json({ success: true });
    return new Response("404", { status: 404 });
  };
  const car = { id: "car_100_77", caption: "Kia Sportage 2024", photos: [{ file_id: "F1" }] };
  const r1 = await crosspostCarToMax(env, car, {
    fetchImpl: fakeFetch,
    loadPhotoBytes: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg", fileName: "1.jpg" })
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.attachmentCount, 1);
  assert.equal(calls.length, 3);

  const r2 = await crosspostCarToMax(env, car, { fetchImpl: fakeFetch });
  assert.equal(r2.alreadySent, true);
  assert.equal(calls.length, 3, "second call must be skipped by max_xpost lock");
});
