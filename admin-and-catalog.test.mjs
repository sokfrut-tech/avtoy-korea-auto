import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { cleanCarDisplayCaption, deduplicateMediaItems, parseVehicleCardData } from "./catalog-formatter.js";

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

const baseEnv = kv => ({
  REVIEWS: kv,
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_ADMIN_IDS: "111111111",
  TELEGRAM_WEBHOOK_SECRET: "wh-sec"
});

test("catalog-formatter strips Telegram contact tails, parses price/specs, and deduplicates media", () => {
  const raw = "встречайте новый\n*Mitsubishi ASX*\n\nГод выпуска: 2026\nДвигатель: 2.0\nМощность: 150 л.с\nТопливо: бензин\nПривод: 4WD\nПробег: 0 км\n\nЦена под ключ до Москвы:\n3.220.000₽\n\nПо актуальному курсу на сегодняшний день\nДля заказа автомобиля обращайтесь:\nВладимир:\n+";
  const cleaned = cleanCarDisplayCaption(raw);
  assert.ok(!cleaned.includes("Владимир"));
  assert.ok(!cleaned.includes("*"));

  const parsed = parseVehicleCardData({ id: "car_1", caption: raw, mediaItems: [{ type: "photo", url: "/a.jpg" }] });
  assert.equal(parsed.brand, "Mitsubishi");
  assert.equal(parsed.title, "Mitsubishi ASX");
  assert.equal(parsed.priceRub, 3220000);
  assert.match(parsed.priceFormatted, /3.*220.*000 ₽/);
  assert.equal(parsed.mileage, "Без пробега");
  assert.equal(parsed.isNew, true);

  const dedup = deduplicateMediaItems([
    { type: "photo", url: "./media/car-01-abcdef123456.jpg" },
    { type: "photo", url: "./media/car-02-999999888888.jpg" },
    { type: "photo", url: "./media/car-13-abcdef123456.jpg" }
  ]);
  assert.equal(dedup.length, 2);
});

test("Admin Pro dashboard supports cleanup, cover photo reorder, photo delete, directText edit, and order CRM", async () => {
  const kv = memoryKV();
  await kv.put("car_approved:car_100_1", JSON.stringify({
    id: "car_100_1",
    caption: "KIA K5 Prestige\nЦена под ключ до Москвы:\n2.460.000 ₽\nДля заказа автомобиля обращайтесь:\nВладимир:\n+",
    photos: [
      { file_id: "P1", file_unique_id: "U1" },
      { file_id: "P2", file_unique_id: "U2" },
      { file_id: "P1_DUP", file_unique_id: "U1" }
    ],
    publishedAt: "2026-11-10T00:00:00.000Z"
  }));
  await kv.put("car_approved:car_1002326996766_3482", JSON.stringify({ id: "car_1002326996766_3482", caption: "исправить" }));
  await kv.put("order:ord001", JSON.stringify({ id: "ord001", number: "99001", name: "Сергей", contact: "+79001112233", status: "new" }));

  const origFetch = globalThis.fetch;
  const tgCalls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.telegram.org")) {
      tgCalls.push(JSON.parse(init.body));
      return Response.json({ ok: true, result: {} });
    }
    return origFetch(url, init);
  };

  try {
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({ message: { chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "/adminlink" } })
    }), baseEnv(kv));

    const code = tgCalls[0].text.match(/Код входа: (\d{8})/)[1];
    assert.match(tgCalls[0].reply_markup.inline_keyboard[0][0].url, new RegExp("#code=" + code));

    const loginRes = await worker.fetch(new Request("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { origin: "https://worker.test", "content-type": "application/json" },
      body: JSON.stringify({ code })
    }), baseEnv(kv));
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];

    // 1. Run catalog auto-cleanup
    const cleanRes = await worker.fetch(new Request("https://worker.test/api/admin/cleanup", {
      method: "POST",
      headers: { cookie, origin: "https://worker.test", "content-type": "application/json" },
      body: "{}"
    }), baseEnv(kv));
    const cleanJson = await cleanRes.json();
    assert.equal(cleanJson.cleanedCars, 1);
    assert.equal(cleanJson.removedBroken, 1);
    assert.equal(await kv.get("car_approved:car_1002326996766_3482"), null);

    const cleanedCar = JSON.parse(await kv.get("car_approved:car_100_1"));
    assert.ok(!cleanedCar.caption.includes("Владимир"));
    assert.equal(cleanedCar.photos.length, 2);

    // 2. Reorder cover photo (set photo index 1 as cover)
    await worker.fetch(new Request("https://worker.test/api/admin/items/car_100_1", {
      method: "PATCH",
      headers: { cookie, origin: "https://worker.test", "content-type": "application/json" },
      body: JSON.stringify({ setCoverPhotoIndex: 1 })
    }), baseEnv(kv));
    assert.equal(JSON.parse(await kv.get("car_approved:car_100_1")).photos[0].file_id, "P2");

    // 3. Update order status via CRM endpoint
    const ordPatch = await worker.fetch(new Request("https://worker.test/api/admin/orders/ord001", {
      method: "PATCH",
      headers: { cookie, origin: "https://worker.test", "content-type": "application/json" },
      body: JSON.stringify({ status: "in_work" })
    }), baseEnv(kv));
    assert.equal(ordPatch.status, 200);
    assert.equal(JSON.parse(await kv.get("order:ord001")).status, "in_work");

    // 4. Dashboard returns enriched items, pending, and orders
    const dash = await (await worker.fetch(new Request("https://worker.test/api/admin/dashboard", { headers: { cookie } }), baseEnv(kv))).json();
    assert.equal(dash.items.length, 1);
    assert.equal(dash.orders.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("Telegram /panel interactive menu and pubascar direct car upload work cleanly", async () => {
  const kv = memoryKV();
  const origFetch = globalThis.fetch;
  const tgCalls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.telegram.org")) {
      tgCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: {} });
    }
    return origFetch(url, init);
  };

  try {
    // 1. Direct admin upload in private chat offers "pubascar:" button and publishes to car_approved
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          message_id: 501,
          chat: { id: 111111111, type: "private" },
          from: { id: 111111111 },
          caption: "Hyundai Palisade Calligraphy\nГод выпуска: 2024\nЦена под ключ до Москвы:\n4.900.000 ₽",
          photo: [{ file_id: "PALISADE_HD", file_unique_id: "UPAL1", width: 1920, height: 1080 }]
        }
      })
    }), baseEnv(kv));

    const cardMsg = tgCalls.at(-1).body;
    const buttons = cardMsg.reply_markup.inline_keyboard.flat();
    assert.ok(buttons.some(b => b.callback_data === "pubascar:111111111_501"));

    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        callback_query: {
          id: "cb1",
          from: { id: 111111111 },
          message: { message_id: 900, chat: { id: 111111111, type: "private" } },
          data: "pubascar:111111111_501"
        }
      })
    }), baseEnv(kv));

    const publishedCar = JSON.parse(await kv.get("car_approved:car_111111111_501"));
    assert.ok(publishedCar);
    assert.match(publishedCar.caption, /Hyundai Palisade/);

    // 2. /panel opens compact single-message control hub
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({ message: { chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "/panel" } })
    }), baseEnv(kv));

    assert.match(tgCalls.at(-1).body.text, /ЦЕНТР УПРАВЛЕНИЯ AVTOY KOREA/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
