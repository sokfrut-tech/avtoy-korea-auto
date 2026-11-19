import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { buildCarContentKeys, cleanCarDisplayCaption, deduplicateMediaItems, isCarListingPost, isMarketNewsRecord, normalizePostDedupText, parseNewsCardData, parseVehicleCardData } from "./catalog-formatter.js";

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

  const inStockRaw = "В НАЛИЧИИ НОВЫЙ KIA SPORTAGE\nГод выпуска: 2026\nЦена под ключ до Москвы:\n4.050.000 ₽";
  const inStockCleaned = cleanCarDisplayCaption(inStockRaw);
  assert.doesNotMatch(inStockCleaned, /наличии/i);
  const inStockParsed = parseVehicleCardData({ id: "car_sportage", caption: inStockRaw, mediaItems: [{ type: "photo", url: "/s.jpg" }] });
  assert.equal(inStockParsed.title, "KIA SPORTAGE");
  assert.doesNotMatch(inStockParsed.promoBadge, /наличии/i);
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

test("Yandex SEO engine serves robots.txt, sitemap.xml, yandex-feed.xml, car/news landing pages, Schema.org JSON-LD, and /setyandex verification without /гарант/i on homepage", async () => {
  const kv = memoryKV();
  await kv.put("car_approved:car_1002326996766_3573", JSON.stringify({
    id: "car_1002326996766_3573",
    caption: "Kia Sorento Prestige\nГод выпуска: 2024\nПробег: 18000 км\nДвигатель: 2.2 дизель\nЦена под ключ до Москвы:\n4.250.000 ₽",
    photos: [{ file_id: "SOR1" }],
    publishedAt: "2026-11-12T10:00:00.000Z"
  }));
  await kv.put("car_approved:car_1002326996766_3482", JSON.stringify({
    id: "car_1002326996766_3482",
    caption: "исправить",
    photos: [{ file_id: "BAD1" }]
  }));
  await kv.put("news_approved:news_1002326996766_3581", JSON.stringify({
    id: "news_1002326996766_3581",
    category: "news",
    text: "После нового года таких цен 100 % не будет!\nИндексация утильсбора.",
    photos: [{ file_id: "TAR1" }],
    publishedAt: "2026-11-10T09:00:00.000Z"
  }));

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.telegram.org")) return Response.json({ ok: true, result: {} });
    return origFetch(url, init);
  };

  try {
    // 1. /setyandex sets both homepage meta tag and verification HTML file
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        message: { chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "/setyandex abcd1234ef567890" }
      })
    }), baseEnv(kv));

    const verifyFile = await worker.fetch(new Request("https://worker.test/yandex_abcd1234ef567890.html"), baseEnv(kv));
    assert.equal(verifyFile.status, 200);
    assert.match(await verifyFile.text(), /Verification: abcd1234ef567890/);

    // 2. Homepage renders SSR preview, FAQ, Schema.org JSON-LD, yandex-verification meta, and zero /гарант/i
    const home = await (await worker.fetch(new Request("https://worker.test/"), baseEnv(kv))).text();
    assert.doesNotMatch(home, /гарант/i);
    assert.match(home, /<h2>Автомобили под заказ<\/h2>/);
    assert.doesNotMatch(home, /в продаже|в наличии/i);
    assert.match(home, /schema\.org\/PreOrder/);
    assert.match(home, /<meta name="yandex-verification" content="abcd1234ef567890">/);
    assert.match(home, /application\/ld\+json/);
    assert.match(home, /Kia Sorento Prestige/);
    assert.match(home, /Частые вопросы|Покупка и доставка авто из Кореи и Китая/);

    // 3. robots.txt, sitemap.xml, yandex-feed.xml exclude placeholder "исправить"
    const robots = await (await worker.fetch(new Request("https://worker.test/robots.txt"), baseEnv(kv))).text();
    assert.match(robots, /User-agent: Yandex/);
    assert.match(robots, /Sitemap: https:\/\/worker\.test\/sitemap\.xml/);

    const sitemap = await (await worker.fetch(new Request("https://worker.test/sitemap.xml"), baseEnv(kv))).text();
    assert.match(sitemap, /https:\/\/worker\.test\/cars\/car_1002326996766_3573/);
    assert.match(sitemap, /https:\/\/worker\.test\/news\/news_1002326996766_3581/);
    assert.ok(!sitemap.includes("3482"));

    const yml = await (await worker.fetch(new Request("https://worker.test/yandex-feed.xml"), baseEnv(kv))).text();
    assert.match(yml, /<yml_catalog/);
    assert.match(yml, /available="false"/);
    assert.match(yml, /<price>4250000<\/price>/);
    assert.match(yml, /<vendor>Kia<\/vendor>/);
    assert.ok(!yml.includes("3482"));

    // 4. Individual car & news landing pages return HTTP 200 with canonical + Product/NewsArticle schema
    const carPage = await worker.fetch(new Request("https://worker.test/cars/car_1002326996766_3573"), baseEnv(kv));
    assert.equal(carPage.status, 200);
    const carHtml = await carPage.text();
    assert.match(carHtml, /Kia Sorento Prestige/);
    assert.match(carHtml, /"@type":"Product"/);

    const newsPage = await worker.fetch(new Request("https://worker.test/news/news_1002326996766_3581"), baseEnv(kv));
    assert.equal(newsPage.status, 200);
    assert.match(await newsPage.text(), /Индексация утильсбора/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("catalog digest tracks public changes and GitHub mirror sync auto-dispatches, debounces, and supports /syncru", async () => {
  const kv = memoryKV();
  const envWithSync = { ...baseEnv(kv), GITHUB_SYNC_TOKEN: "gh-sync-test-token" };

  const d0Res = await worker.fetch(new Request("https://worker.test/api/catalog-digest"), envWithSync);
  assert.equal(d0Res.status, 200);
  const d0 = await d0Res.json();
  assert.equal(Object.keys(d0.recordDigests).length, 0);

  await kv.put("car_approved:car_100_1", JSON.stringify({ id: "car_100_1", caption: "Kia Sportage 2025", publishedAt: "2026-11-18T00:00:00Z" }));
  const d1 = await (await worker.fetch(new Request("https://worker.test/api/catalog-digest"), envWithSync)).json();
  assert.notEqual(d1.digest, d0.digest);
  assert.ok(d1.recordDigests["car_approved:car_100_1"]);

  const origFetch = globalThis.fetch;
  const dispatches = [];
  const tgReplies = [];
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s === "https://api.github.com/repos/sokfrut-tech/avtoy-korea-auto/dispatches") {
      dispatches.push({ headers: init.headers, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    if (s.includes("api.telegram.org")) {
      tgReplies.push(JSON.parse(init.body));
      return Response.json({ ok: true, result: {} });
    }
    return origFetch(url, init);
  };

  try {
    // 1. Publishing news via Telegram /news mutates news_approved:* and triggers automatic dispatch
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        message: { chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "/news Важное обновление тарифов" }
      })
    }), envWithSync);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].body.event_type, "catalog-updated");

    // 2. Second immediate mutation (/setyandex) is debounced within 45s (dispatch count stays 1), while /api/catalog-digest reflects the change
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        message: { chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "/setyandex verify98765432" }
      })
    }), envWithSync);
    assert.equal(dispatches.length, 1);
    const d2 = await (await worker.fetch(new Request("https://worker.test/api/catalog-digest"), envWithSync)).json();
    assert.notEqual(d2.digest, d1.digest);
    assert.equal(d2.yandexVerification, "verify98765432");

    // 3. Explicit /syncru forces an immediate dispatch bypassing debounce
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        message: { chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "/syncru" }
      })
    }), envWithSync);
    assert.equal(dispatches.length, 2);
    assert.match(tgReplies[tgReplies.length - 1].text, /автоматическое облачное обновление/i);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("car catalogue keeps 1024x768 photos and falls back to 640x360 galleries when no sharp photos or videos exist", async () => {
  const kv = memoryKV();
  await kv.put("car_approved:car_100_che168", JSON.stringify({
    id: "car_100_che168",
    caption: "T-ROC 2022",
    photos: [{ file_id: "CHE1", file_unique_id: "CHE1_U", width: 1024, height: 768 }],
    publishedAt: "2026-11-12T10:00:00Z"
  }));
  await kv.put("car_approved:car_100_encar", JSON.stringify({
    id: "car_100_encar",
    caption: "MERCEDES-BENZ GLB 200d",
    photos: [{ file_id: "ENC1", file_unique_id: "ENC1_U", width: 640, height: 360 }],
    publishedAt: "2026-11-12T09:00:00Z"
  }));

  const res = await worker.fetch(new Request("https://worker.test/api/cars"), baseEnv(kv));
  assert.equal(res.status, 200);
  const { cars } = await res.json();
  const che = cars.find(c => c.id === "car_100_che168");
  const encar = cars.find(c => c.id === "car_100_encar");
  assert.equal(che.mediaItems.length, 1);
  assert.equal(encar.mediaItems.length, 1);
});

test("normalizePostDedupText, buildCarContentKeys, and isCarListingPost classify and fingerprint vehicles accurately", () => {
  const tgText = "Genesis GV80 2023\nПробег: 34 000 км\nЦена под ключ: 6.450.000 ₽\nhttps://t.me/avtoYkorea";
  const maxCopyText = "[MAX] Genesis GV80 2023\nПробег: 34.000 км\nЦена под ключ: 6 450 000 ₽\n@avtoYkorea";
  const tgKeys = buildCarContentKeys(tgText);
  const maxKeys = buildCarContentKeys(maxCopyText);
  assert.ok(tgKeys.some(k => maxKeys.includes(k)), "TG and MAX variants of the same car must share a dedup key");
  assert.equal(normalizePostDedupText(tgText), normalizePostDedupText(maxCopyText));

  assert.equal(isCarListingPost({ text: maxCopyText, hasMedia: true }), true);
  assert.equal(isCarListingPost({ text: "LiXiang L7 Ultra\nГод выпуска: 2024\nПробег: 0 км", hasMedia: true }), true);
  assert.equal(isCarListingPost({ text: tgText, hasMedia: false }), false);
  assert.equal(isCarListingPost({ text: "Здравствуйте! Сколько стоит привезти Kia Sportage 2023?", hasMedia: true }), false);
  assert.equal(isCarListingPost({ text: "Спасибо огромное за отличный Kia Sorento!", hasMedia: true }), false);
  assert.equal(isCarListingPost({ text: "Повышение утильсбора и изменение таможенных пошлин с 1 мая", hasMedia: true }), false);
});

test("AUTO_PUBLISH_CARS auto-publishes channel car albums without duplicates, crossposts to MAX, and blocks pubascar duplicates", async () => {
  const kv = memoryKV();
  const env = {
    ...baseEnv(kv),
    AUTO_PUBLISH_CARS: "1",
    TELEGRAM_CHANNEL_USERNAME: "avtoYkorea",
    MAX_BOT_TOKEN: "max-tok",
    MAX_PUBLIC_GROUP_ID: "888001"
  };
  const origFetch = globalThis.fetch;
  const tgCalls = [];
  const maxCalls = [];
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s.includes("api.telegram.org/bot")) {
      if (s.endsWith("/getFile")) {
        return Response.json({ ok: true, result: { file_path: "photos/car.jpg" } });
      }
      tgCalls.push(JSON.parse(init.body));
      return Response.json({ ok: true, result: { message_id: 999 } });
    }
    if (s.includes("api.telegram.org/file/bot")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "image/jpeg" } });
    }
    if (s.includes("platform-api2.max.ru/uploads")) {
      return Response.json({ url: "https://upload.max.ru/u/1", token: "max-img-tok" });
    }
    if (s.startsWith("https://upload.max.ru/")) {
      return Response.json({ token: "max-img-tok" });
    }
    if (s.includes("platform-api2.max.ru/messages")) {
      maxCalls.push(JSON.parse(init.body));
      return Response.json({ success: true });
    }
    return origFetch(url, init);
  };

  try {
    const carCaption = "Kia K5 GT-Line\nГод выпуска: 2024\nПробег: 18 000 км\nЦена под ключ: 2.950.000 ₽";
    // Part 1 of album arrives live from channel
    const r1 = await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        update_id: 9101,
        channel_post: {
          message_id: 800,
          media_group_id: "alb-800",
          date: 1790000000,
          chat: { id: -100555, username: "avtoYkorea", type: "channel" },
          caption: carCaption,
          photo: [{ file_id: "ALB1", file_unique_id: "UALB1", width: 1280, height: 960 }]
        }
      })
    }), env);
    assert.equal(r1.status, 200);

    // Part 2 merges into car_approved:car_100555_800
    const r2 = await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        update_id: 9102,
        channel_post: {
          message_id: 801,
          media_group_id: "alb-800",
          date: 1790000000,
          chat: { id: -100555, username: "avtoYkorea", type: "channel" },
          photo: [{ file_id: "ALB2", file_unique_id: "UALB2", width: 1280, height: 960 }]
        }
      })
    }), env);
    assert.equal(r2.status, 200);

    const saved = JSON.parse(await kv.get("car_approved:car_100555_800"));
    assert.ok(saved, "car should be auto-published immediately");
    assert.deepEqual(saved.photos.map(p => p.file_id), ["ALB1", "ALB2"]);
    assert.equal(maxCalls.length, 1, "single MAX crosspost emitted");

    // Duplicate post with another message_id (805) and slight formatting variance is skipped
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        update_id: 9103,
        channel_post: {
          message_id: 805,
          date: 1790000100,
          chat: { id: -100555, username: "avtoYkorea", type: "channel" },
          caption: "[MAX] Kia K5 GT-Line\nГод выпуска: 2024\nПробег: 18.000 км\nЦена под ключ: 2 950 000 ₽",
          photo: [{ file_id: "ALB_DUP", file_unique_id: "UALB_DUP", width: 1280, height: 960 }]
        }
      })
    }), env);
    assert.equal(await kv.get("car_approved:car_100555_805"), null, "duplicate car must not be published");
    assert.equal(maxCalls.length, 1, "duplicate must not bounce back to MAX");

    // Duplicate manual upload via pubascar: is also rejected
    await kv.put("pending:111111111_777", JSON.stringify({ id: "111111111_777", kind: "text", text: carCaption, photos: [{ file_id: "MANUAL1" }] }));
    await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "wh-sec", "content-type": "application/json" },
      body: JSON.stringify({
        callback_query: {
          id: "cb-dup",
          from: { id: 111111111 },
          message: { message_id: 950, chat: { id: 111111111, type: "private" } },
          data: "pubascar:111111111_777"
        }
      })
    }), env);
    assert.equal(await kv.get("car_approved:car_111111111_777"), null);
    assert.ok(tgCalls.some(c => /дубль пропущен/i.test(c.text || "")));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("/api/admin/sync-telegram imports new cars from t.me/s/avtoYkorea, skips duplicates, and serves tgweb photos via /api/car-media", async () => {
  const kv = memoryKV();
  await kv.put("car_approved:car_900000_111", JSON.stringify({
    id: "car_900000_111",
    caption: "Hyundai Santa Fe 2023\nПробег: 25 000 км\nЦена под ключ: 3.600.000 ₽",
    photos: [{ file_id: "EXISTING_SF" }],
    publishedAt: "2026-11-18T10:00:00Z"
  }));
  const env = { ...baseEnv(kv), TELEGRAM_CHANNEL_USERNAME: "avtoYkorea" };
  const channelHtml = [
    '<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="avtoYkorea/3601">',
    '<div class="tgme_widget_message_photo_wrap" style="background-image:url(\'https://cdn4.telesco.pe/file/p1.jpg\')"></div>',
    '<div class="tgme_widget_message_text js-message_text" dir="auto">Kia Carnival<br/><i class="emoji"><b>➖</b></i>Год выпуска: 2023<br/><i class="emoji"><b>➖</b></i>Пробег: 45 000 км<br/>Цена под ключ:<br/>3.850.000 ₽</div>',
    '<time datetime="2026-11-19T09:00:00+00:00"></time></div></div>',
    '<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="avtoYkorea/3602">',
    '<div class="tgme_widget_message_photo_wrap" style="background-image:url(\'https://cdn4.telesco.pe/file/n1.jpg\')"></div>',
    '<div class="tgme_widget_message_text js-message_text" dir="auto">Повышение утильсбора и таможенные пошлины с мая</div>',
    '<time datetime="2026-11-19T09:05:00+00:00"></time></div></div>',
    '<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="avtoYkorea/3603">',
    '<div class="tgme_widget_message_photo_wrap" style="background-image:url(\'https://cdn4.telesco.pe/file/d1.jpg\')"></div>',
    '<div class="tgme_widget_message_text js-message_text" dir="auto">Hyundai Santa Fe 2023<br/>Пробег: 25.000 км<br/>Цена под ключ: 3 600 000 ₽</div>',
    '<time datetime="2026-11-19T09:10:00+00:00"></time></div></div>'
  ].join("");
  const embedHtml = '<a class="tgme_widget_message_photo_wrap" style="background-image:url(\'https://cdn4.telesco.pe/file/p1.jpg\')"></a><a class="tgme_widget_message_photo_wrap" style="background-image:url(\'https://cdn4.telesco.pe/file/p2.jpg\')"></a>';

  const origFetch = globalThis.fetch;
  const tgCalls = [];
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s === "https://t.me/s/avtoYkorea") return new Response(channelHtml, { status: 200 });
    if (s === "https://t.me/avtoYkorea/3601?embed=1") return new Response(embedHtml, { status: 200 });
    if (s === "https://cdn4.telesco.pe/file/p1.jpg") return new Response(new Uint8Array([9, 8, 7]), { status: 200, headers: { "content-type": "image/jpeg" } });
    if (s.includes("api.telegram.org")) {
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
    }), env);
    const code = tgCalls[0].text.match(/Код входа: (\d{8})/)[1];
    const loginRes = await worker.fetch(new Request("https://worker.test/api/admin/login", {
      method: "POST",
      headers: { origin: "https://worker.test", "content-type": "application/json" },
      body: JSON.stringify({ code })
    }), env);
    const cookie = loginRes.headers.get("set-cookie").split(";")[0];

    const syncRes = await worker.fetch(new Request("https://worker.test/api/admin/sync-telegram", {
      method: "POST",
      headers: { cookie, origin: "https://worker.test", "content-type": "application/json" },
      body: "{}"
    }), env);
    assert.equal(syncRes.status, 200);
    const syncJson = await syncRes.json();
    assert.equal(syncJson.importedCars, 1);
    assert.equal(syncJson.skippedDuplicates, 1);

    const imported = JSON.parse(await kv.get("car_approved:car_1002326996766_3601"));
    assert.ok(imported);
    assert.equal(imported.photos.length, 2);
    assert.equal(imported.photos[0].file_id, "tgweb:avtoYkorea/3601/0");
    assert.equal(await kv.get("car_approved:car_1002326996766_3602"), null);
    assert.equal(await kv.get("car_approved:car_1002326996766_3603"), null);

    const mediaRes = await worker.fetch(new Request("https://worker.test/api/car-media/car_1002326996766_3601/photo/0"), env);
    assert.equal(mediaRes.status, 200);
    assert.deepEqual(new Uint8Array(await mediaRes.arrayBuffer()), new Uint8Array([9, 8, 7]));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("worker.scheduled imports new t.me/s/avtoYkorea cars once, triggers mirror dispatch, and skips on rerun", async () => {
  const kv = memoryKV();
  const env = {
    ...baseEnv(kv),
    AUTO_PUBLISH_CARS: "1",
    TELEGRAM_CHANNEL_USERNAME: "avtoYkorea",
    GITHUB_SYNC_TOKEN: "gh-sync-tok",
    GITHUB_SYNC_REPO: "sokfrut-tech/avtoy-korea-auto"
  };
  const channelHtml = [
    '<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="avtoYkorea/3610">',
    '<div class="tgme_widget_message_photo_wrap" style="background-image:url(\'https://cdn4.telesco.pe/file/cron1.jpg\')"></div>',
    '<div class="tgme_widget_message_text js-message_text" dir="auto">Genesis GV80<br/>Год выпуска: 2024<br/>Пробег: 18 000 км<br/>Цена под ключ: 6.450.000 ₽</div>',
    '<time datetime="2026-11-19T12:00:00+00:00"></time></div></div>'
  ].join("");
  const embedHtml = '<a class="tgme_widget_message_photo_wrap" style="background-image:url(\'https://cdn4.telesco.pe/file/cron1.jpg\')"></a>';

  const origFetch = globalThis.fetch;
  const dispatches = [];
  globalThis.fetch = async (url, init) => {
    const s = String(url);
    if (s === "https://t.me/s/avtoYkorea") return new Response(channelHtml, { status: 200 });
    if (s === "https://t.me/avtoYkorea/3610?embed=1") return new Response(embedHtml, { status: 200 });
    if (s === "https://api.github.com/repos/sokfrut-tech/avtoy-korea-auto/dispatches") {
      dispatches.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    return origFetch(url, init);
  };

  try {
    const pending1 = [];
    await worker.scheduled({}, env, { waitUntil(p) { pending1.push(p); } });
    await Promise.all(pending1);

    const saved = JSON.parse(await kv.get("car_approved:car_1002326996766_3610"));
    assert.ok(saved);
    assert.match(saved.caption, /Genesis GV80/i);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].event_type, "catalog-updated");
    assert.equal(dispatches[0].client_payload.reason, "cron_sync_tg");

    const pending2 = [];
    await worker.scheduled({}, env, { waitUntil(p) { pending2.push(p); } });
    await Promise.all(pending2);
    assert.equal(dispatches.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});
