import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { cleanCarDisplayCaption, deduplicateMediaItems, isMarketNewsRecord, parseNewsCardData, parseVehicleCardData } from "./catalog-formatter.js";

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

test("News publishing works across Telegram (/news, pubasnews, imp:news), MAX (/news), Web Admin (/api/admin/news, /move), and reclassifies recycling-fee review -1002326996766_3581", async () => {
  const kv = memoryKV();
  const recyclingFeeText = "После нового года таких цен 100 % не будет!\nПараллельный импорт планируют закрыть новым расчетом утильсбора.\nНо ещё остаётся время привезти автомобиль по старым правилам.";
  assert.equal(isMarketNewsRecord({ id: "-1002326996766_3581", text: recyclingFeeText }), true);
  assert.equal(isMarketNewsRecord({ id: "-1002326996766_3493", text: "Спасибо огромное за подбор утильсбор успели пройти!" }), false);

  const parsedCard = parseNewsCardData({ id: "news_1002326996766_3581", text: recyclingFeeText });
  assert.equal(parsedCard.isUrgent, true);
  assert.match(parsedCard.title, /После нового года таких цен 100 % не будет/);

  // Seed legacy misclassified review (-1002326996766_3581) + genuine customer review
  await kv.put("approved:-1002326996766_3581", JSON.stringify({
    id: "-1002326996766_3581",
    kind: "text",
    text: recyclingFeeText,
    fileId: "TARIFF_IMG",
    photos: [{ file_id: "TARIFF_IMG" }],
    publishedAt: "2026-11-01T10:00:00.000Z"
  }));
  await kv.put("approved:-1002326996766_3493", JSON.stringify({
    id: "-1002326996766_3493",
    kind: "text",
    text: "Очередной отзыв от нашего клиента! Спасибо за подбор Kia K5!",
    fileId: "REV_IMG",
    photos: [{ file_id: "REV_IMG" }],
    publishedAt: "2026-11-02T10:00:00.000Z"
  }));

  // Even BEFORE cleanup, /api/reviews excludes the market news post and /api/news serves it!
  const revBefore = await (await worker.fetch(new Request("https://worker.test/api/reviews"), baseEnv(kv))).json();
  assert.equal(revBefore.reviews.length, 1);
  assert.equal(revBefore.reviews[0].id, "-1002326996766_3493");

  const newsBefore = await (await worker.fetch(new Request("https://worker.test/api/news"), baseEnv(kv))).json();
  assert.equal(newsBefore.news.length, 1);
  assert.equal(newsBefore.news[0].id, "news_1002326996766_3581");
  assert.match(newsBefore.news[0].text, /утильсбора/);

  const origFetch = globalThis.fetch;
  const tgCalls = [];
  const maxCalls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.telegram.org")) {
      tgCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json({ ok: true, result: { file_path: "photos/tariff.jpg" } });
    }
    if (String(url).includes("platform-api2.max.ru")) {
      maxCalls.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json({ success: true });
    }
    return origFetch(url, init);
  };

  const envWithMax = {
    ...baseEnv(kv),
    MAX_BOT_TOKEN: "max-tok",
    MAX_ADMIN_IDS: "777001",
    MAX_WEBHOOK_SECRET: "max-sec"
  };

  try {
    // 1. Telegram /news <text> publishes directly
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          message_id: 601,
          chat: { id: 111111111, type: "private" },
          from: { id: 111111111 },
          text: "/news Снижение курса воны в ноябре\nОтличное окно для покупки кроссоверов из Южной Кореи."
        }
      })
    }), envWithMax);
    assert.ok(await kv.get("news_approved:news_111111111_601"));

    // 2. Telegram direct photo upload + pubasnews button
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          message_id: 602,
          chat: { id: 111111111, type: "private" },
          from: { id: 111111111 },
          caption: "График работы таможни Владивостока в праздники\nОформление идёт по расписанию.",
          photo: [{ file_id: "NEWS_PHOTO_1", file_unique_id: "UNP1", width: 1280, height: 960 }]
        }
      })
    }), envWithMax);
    const uploadBtns = tgCalls.at(-1).body.reply_markup.inline_keyboard.flat();
    assert.ok(uploadBtns.some(b => b.callback_data === "pubasnews:111111111_602"));

    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        callback_query: {
          id: "cb_news_1",
          from: { id: 111111111 },
          message: { message_id: 901, chat: { id: 111111111, type: "private" } },
          data: "pubasnews:111111111_602"
        }
      })
    }), envWithMax);
    assert.ok(await kv.get("news_approved:news_111111111_602"));

    // 3. Channel post import offers 3rd button "📰 Новость" (imp:news:) -> newspub:
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        channel_post: {
          message_id: 777,
          date: 1763000000,
          chat: { id: -1002326996766, username: "avtoYkorea", type: "channel" },
          caption: "Обновление ставок фрахта Пусан — Владивосток",
          photo: [{ file_id: "CH_NEWS_IMG", file_unique_id: "UCHN1", width: 1280, height: 720 }]
        }
      })
    }), envWithMax);
    const impRow = tgCalls.at(-1).body.reply_markup.inline_keyboard[0];
    assert.equal(impRow[0].callback_data, "imp:car:-1002326996766_777");
    assert.equal(impRow[1].callback_data, "imp:review:-1002326996766_777");
    assert.equal(impRow[2].callback_data, "imp:news:-1002326996766_777");

    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        callback_query: {
          id: "cb_imp_news",
          from: { id: 111111111 },
          message: { message_id: 902, chat: { id: 111111111, type: "private" } },
          data: "imp:news:-1002326996766_777"
        }
      })
    }), envWithMax);
    assert.ok(await kv.get("news_pending:news_1002326996766_777"));

    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        callback_query: {
          id: "cb_newspub",
          from: { id: 111111111 },
          message: { message_id: 903, chat: { id: 111111111, type: "private" } },
          data: "newspub:news_1002326996766_777"
        }
      })
    }), envWithMax);
    assert.ok(await kv.get("news_approved:news_1002326996766_777"));

    // 4. MAX bot /news <text> publishes directly
    await worker.fetch(new Request("https://worker.test/max/webhook", {
      method: "POST",
      headers: { "X-Max-Bot-Api-Secret": "max-sec", "content-type": "application/json" },
      body: JSON.stringify({
        update_type: "message_created",
        message: {
          sender: { user_id: 777001, name: "Владелец" },
          recipient: { chat_type: "dialog", chat_id: 777001 },
          body: { mid: "m_news_1", text: "/news Новая партия авто погружена на паром из Пусана" }
        }
      })
    }), envWithMax);
    assert.match(maxCalls.at(-1).body.text, /Новость опубликована на сайт/);

    // 5. Web Admin cleanup permanently migrates approved:-1002326996766_3581 -> news_approved:news_1002326996766_3581, plus /api/admin/news & /move
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({ message: { chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "/adminlink" } })
    }), envWithMax);
    const code = tgCalls.at(-1).body.text.match(/Код входа: (\d{8})/)[1];
    const loginRes = await worker.fetch(new Request("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { origin: "https://worker.test", "content-type": "application/json" },
      body: JSON.stringify({ code })
    }), envWithMax);
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];

    const cleanRes = await (await worker.fetch(new Request("https://worker.test/api/admin/cleanup", {
      method: "POST",
      headers: { cookie, origin: "https://worker.test", "content-type": "application/json" },
      body: "{}"
    }), envWithMax)).json();
    assert.equal(cleanRes.movedToNews, 1);
    assert.equal(await kv.get("approved:-1002326996766_3581"), null);
    assert.ok(await kv.get("news_approved:news_1002326996766_3581"));

    const postNewsRes = await (await worker.fetch(new Request("https://worker.test/api/admin/news", {
      method: "POST",
      headers: { cookie, origin: "https://worker.test", "content-type": "application/json" },
      body: JSON.stringify({ text: "Новость из веб-панели\nПодробный разбор комплектаций." })
    }), envWithMax)).json();
    assert.equal(postNewsRes.ok, true);

    // Move a news item to reviews and back to news via /move
    const moveRevRes = await (await worker.fetch(new Request(`https://worker.test/api/admin/items/${postNewsRes.id}/move`, {
      method: "POST",
      headers: { cookie, origin: "https://worker.test", "content-type": "application/json" },
      body: JSON.stringify({ targetKind: "review" })
    }), envWithMax)).json();
    assert.equal(moveRevRes.ok, true);

    const moveBackRes = await (await worker.fetch(new Request(`https://worker.test/api/admin/items/${moveRevRes.id}/move`, {
      method: "POST",
      headers: { cookie, origin: "https://worker.test", "content-type": "application/json" },
      body: JSON.stringify({ targetKind: "news" })
    }), envWithMax)).json();
    assert.equal(moveBackRes.ok, true);

    const allNews = await (await worker.fetch(new Request("https://worker.test/api/news"), envWithMax)).json();
    assert.equal(allNews.news.length, 6);

    // 6. MAX Bot buttons are visible on homepage by default and bind dynamically via /setmax & /api/public-config
    const defaultHtml = await (await worker.fetch(new Request("https://worker.test/"), envWithMax)).text();
    assert.match(defaultHtml, /Бот в MAX/);
    assert.match(defaultHtml, /Бот подбора в MAX/);
    assert.match(defaultHtml, /Написать в бот MAX/);

    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        message: { chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "/setmax https://max.ru/avtoykorea_bot" }
      })
    }), envWithMax);

    const pubCfg = await (await worker.fetch(new Request("https://worker.test/api/public-config"), envWithMax)).json();
    assert.equal(pubCfg.maxBotUrl, "https://max.ru/avtoykorea_bot");

    const updatedHtml = await (await worker.fetch(new Request("https://worker.test/"), envWithMax)).text();
    assert.match(updatedHtml, /href="https:\/\/max\.ru\/avtoykorea_bot"/);
  } finally {
    globalThis.fetch = origFetch;
  }
});
