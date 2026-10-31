import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";

const env = {
  TELEGRAM_BOT_TOKEN: "test-token",
  TELEGRAM_ADMIN_IDS: "111111111, 222222222",
  TELEGRAM_WEBHOOK_SECRET: "hook-secret",
};

function webhook(message) {
  return new Request("https://worker.test/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "hook-secret",
    },
    body: JSON.stringify({ message }),
  });
}

async function withTelegramMock(run) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).startsWith("https://api.telegram.org/")) {
      calls.push({
        method: new URL(String(input)).pathname.split("/").pop(),
        payload: JSON.parse(init.body || "{}"),
      });
      return Response.json({ ok: true, result: {} });
    }
    return originalFetch(input, init);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("private client messages go to each personal admin, not a group", async () => {
  await withTelegramMock(async calls => {
    const response = await worker.fetch(webhook({
      chat: { id: 333333333, type: "private" },
      from: { first_name: "Client" },
      text: "Ищу автомобиль",
    }), env);

    assert.equal(response.status, 200);
    const adminNotices = calls.filter(call =>
      ["111111111", "222222222"].includes(String(call.payload.chat_id)) &&
      call.payload.text.includes("Ищу автомобиль")
    );
    assert.equal(adminNotices.length, 2);
    assert.equal(calls.filter(call => String(call.payload.chat_id) === "333333333").length, 1);
  });
});

test("group messages are ignored without replying to the group or notifying admins", async () => {
  await withTelegramMock(async calls => {
    const response = await worker.fetch(webhook({
      chat: { id: -1001234567890, type: "supergroup" },
      from: { first_name: "Member" },
      text: "Это сообщение не должно попасть в группу или админам",
    }), env);

    assert.equal(response.status, 200);
    assert.equal(calls.length, 0);
  });
});

test("website requests are delivered to every personal admin ID", async () => {
  await withTelegramMock(async calls => {
    const request = new Request("https://worker.test/api/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Тест", contact: "@test", model: "Kia" }),
    });
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 200);
    assert.deepEqual(
      calls.map(call => String(call.payload.chat_id)).sort(),
      ["111111111", "222222222"]
    );
  });
});


test("admin can forward an existing channel post to import it for moderation", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const response = await worker.fetch(webhookUpdate({ message: {
      message_id: 90,
      chat: { id: 111111111, type: "private" },
      from: { id: 111111111, first_name: "Admin" },
      forward_origin: { type: "channel", chat: { id: -100555, username: "avtoYkorea", type: "channel" }, message_id: 42 },
      caption: "Kia Sorento, 2022",
      photo: [{ file_id: "SMALL" }, { file_id: "LARGE" }]
    }}), reviewEnv(kv));
    assert.equal(response.status, 200);
    const pending = await kv.get("car_pending:car_100555_42");
    assert.ok(pending);
    assert.equal(JSON.parse(pending).caption, "Kia Sorento, 2022");
    assert.equal(JSON.parse(pending).fileId, "LARGE");
    assert.ok(calls.some(c => c.method === "sendMessage" && c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "carpub:car_100555_42"));
  });
});

test("forwarded posts from another channel are not imported", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    await worker.fetch(webhookUpdate({ message: {
      message_id: 91, chat: { id: 111111111, type: "private" },
      from: { id: 111111111 },
      forward_origin: { type: "channel", chat: { id: -100777, username: "other_channel" }, message_id: 5 },
      text: "Not our car"
    }}), reviewEnv(kv));
    assert.equal((await kv.list({ prefix: "car_pending:" })).keys.length, 0);
    assert.ok(calls.some(c => c.method === "sendMessage" && String(c.payload.chat_id) === "111111111"));
  });
});

test("forwarding the same channel post twice does not create duplicate moderation cards", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const message = {
      message_id: 92, chat: { id: 111111111, type: "private" },
      from: { id: 111111111 },
      forward_origin: { type: "channel", chat: { id: -100555, username: "avtoYkorea" }, message_id: 43 },
      caption: "Hyundai Tucson"
    };
    await worker.fetch(webhookUpdate({message}), reviewEnv(kv));
    const firstCardCount = calls.filter(c => c.method === "sendMessage" && c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "carpub:car_100555_43").length;
    await worker.fetch(webhookUpdate({message}), reviewEnv(kv));
    const secondCardCount = calls.filter(c => c.method === "sendMessage" && c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "carpub:car_100555_43").length;
    assert.equal(firstCardCount, 2);
    assert.equal(secondCardCount, 2);
  });
});

test("legacy negative group ID is rejected instead of used as an admin destination", async () => {
  await withTelegramMock(async calls => {
    const legacyGroupEnv = {
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_CHAT_ID: "-1001234567890",
      TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    };
    const response = await worker.fetch(webhook({
      chat: { id: 333333333, type: "private" },
      from: { first_name: "Client" },
      text: "Test",
    }), legacyGroupEnv);

    assert.equal(response.status, 503);
    assert.equal(calls.length, 0);
  });
});

// --- Отзывы ---
const REVIEW_GROUP = "-1001234567890";

function memoryKV() {
  const store = new Map();
  return {
    async put(k, v) { store.set(k, v); },
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async delete(k) { store.delete(k); },
    async list({ prefix }) { return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })) }; },
  };
}

function webhookUpdate(update) {
  return new Request("https://worker.test/telegram/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
    body: JSON.stringify(update),
  });
}

function reviewEnv(kv) {
  return { ...env, TELEGRAM_REVIEW_GROUP_ID: REVIEW_GROUP, REVIEWS: kv };
}

function groupReview(messageId, extra) {
  return { message_id: messageId, chat: { id: Number(REVIEW_GROUP), type: "supergroup" }, from: { first_name: "Ivan" }, ...extra };
}

function callback(fromId, data) {
  return { callback_query: { id: "cb" + data, from: { id: fromId }, data } };
}

test("group messages are ignored when no review group is configured", async () => {
  await withTelegramMock(async calls => {
    const response = await worker.fetch(webhookUpdate({ message: groupReview(1, { caption: "/review Спасибо!", video: { file_id: "V" } }) }), env);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 0);
  });
});

test("only the configured review group is read, and only /review messages", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    await worker.fetch(webhookUpdate({ message: { message_id: 2, chat: { id: -999, type: "supergroup" }, from: { first_name: "X" }, text: "/review Спасибо" } }), reviewEnv(kv));
    await worker.fetch(webhookUpdate({ message: groupReview(3, { text: "просто болтаем" }) }), reviewEnv(kv));
    assert.equal(calls.length, 0);
    assert.equal((await kv.list({ prefix: "pending:" })).keys.length, 0);
  });
});

test("video review without thanks can be published after admin approval", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    await worker.fetch(webhookUpdate({ message: groupReview(10, { caption: "/review Машина нормальная", video: { file_id: "VID10" } }) }), reviewEnv(kv));
    const card = calls.find(c => c.method === "sendMessage" && String(c.payload.chat_id) === "111111111");
    assert.ok(card, "admin receives the card");
    assert.ok(card.payload.text.includes("Видео"));

    await worker.fetch(webhookUpdate(callback(111111111, "pub:" + REVIEW_GROUP + "_10")), reviewEnv(kv));
    assert.equal((await kv.list({ prefix: "approved:" })).keys.length, 1);
  });
});

test("video review with thanks is published and appears on the site API", async () => {
  const kv = memoryKV();
  await withTelegramMock(async () => {
    await worker.fetch(webhookUpdate({ message: groupReview(11, { caption: "/review Спасибо большое за помощь!", video: { file_id: "VID11" } }) }), reviewEnv(kv));
    await worker.fetch(webhookUpdate(callback(111111111, "pub:" + REVIEW_GROUP + "_11")), reviewEnv(kv));
    const response = await worker.fetch(new Request("https://worker.test/api/reviews"), reviewEnv(kv));
    const body = await response.json();
    assert.equal(body.reviews.length, 1);
    assert.equal(body.reviews[0].name, "Ivan");
    assert.equal(body.reviews[0].kind, "video");
    assert.equal(body.reviews[0].media, "/api/review-media/" + REVIEW_GROUP + "_11");
    assert.ok(!JSON.stringify(body).includes("test-token"), "bot token never reaches the site");
  });
});

test("text review needs a car photo; with photo it is published and name can be hidden", async () => {
  const kv = memoryKV();
  await withTelegramMock(async () => {
    await worker.fetch(webhookUpdate({ message: groupReview(20, { text: "/review Всё быстро" }) }), reviewEnv(kv));
    await worker.fetch(webhookUpdate(callback(222222222, "anon:" + REVIEW_GROUP + "_20")), reviewEnv(kv));
    await worker.fetch(webhookUpdate(callback(111111111, "pub:" + REVIEW_GROUP + "_20")), reviewEnv(kv));
    assert.equal((await kv.list({ prefix: "approved:" })).keys.length, 0, "no photo, not published");

    await worker.fetch(webhookUpdate({ message: groupReview(21, { caption: "/review Всё быстро", photo: [{ file_id: "S" }, { file_id: "BIG" }] }) }), reviewEnv(kv));
    await worker.fetch(webhookUpdate(callback(111111111, "anon:" + REVIEW_GROUP + "_21")), reviewEnv(kv));
    await worker.fetch(webhookUpdate(callback(111111111, "pub:" + REVIEW_GROUP + "_21")), reviewEnv(kv));
    const body = await (await worker.fetch(new Request("https://worker.test/api/reviews"), reviewEnv(kv))).json();
    assert.equal(body.reviews.length, 1);
    assert.equal(body.reviews[0].name, "Клиент");
  });
});

test("callbacks from non-admins are refused", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    await worker.fetch(webhookUpdate({ message: groupReview(30, { caption: "/review Спасибо!", video: { file_id: "V30" } }) }), reviewEnv(kv));
    await worker.fetch(webhookUpdate(callback(999999999, "pub:" + REVIEW_GROUP + "_30")), reviewEnv(kv));
    const last = calls.filter(c => c.method === "answerCallbackQuery").pop();
    assert.equal(last.payload.text, "Нет доступа");
    assert.equal((await kv.list({ prefix: "approved:" })).keys.length, 0);
  });
});

// --- Заявки с сайта ---
function siteRequest(body) {
  return new Request("https://worker.test/api/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const orderEnv = (kv) => ({ ...env, TELEGRAM_BOT_USERNAME: "@avtoy_test_bot", REVIEWS: kv });

test("site order goes to every admin with an accept button and returns a bot link", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const res = await worker.fetch(siteRequest({ name: "Анна", contact: "@anna", model: "Kia Sorento", budget: "3 млн", country: "Южная Корея" }), orderEnv(kv));
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.orderId, /^[0-9a-f]{16}$/);
    assert.equal(body.botLink, `https://t.me/avtoy_test_bot?start=order_${body.orderId}`);
    const cards = calls.filter(c => c.method === "sendMessage" && c.payload.reply_markup);
    assert.equal(cards.length, 2);
    assert.equal(cards[0].payload.reply_markup.inline_keyboard[0][0].callback_data, `ord:${body.orderId}`);
  });
});

test("client opens the link, admin accepts, client gets the confirmation", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const res = await worker.fetch(siteRequest({ name: "Анна", contact: "@anna" }), orderEnv(kv));
    const { orderId } = await res.json();

    await worker.fetch(webhookUpdate({ message: { chat: { id: 444444444, type: "private" }, from: { first_name: "Anna" }, text: `/start order_${orderId}` } }), orderEnv(kv));
    assert.ok(calls.some(c => String(c.payload.chat_id) === "444444444" && c.payload.text.includes("заявка получена")));

    await worker.fetch(webhookUpdate(callback(111111111, `ord:${orderId}`)), orderEnv(kv));
    assert.ok(calls.some(c => String(c.payload.chat_id) === "444444444" && c.payload.text.includes("принята в работу")));
    const order = JSON.parse(await kv.get(`order:${orderId}`));
    assert.equal(order.status, "in_work");
  });
});

test("accepting an order twice does not message the client twice", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const { orderId } = await (await worker.fetch(siteRequest({ name: "Анна", contact: "@anna" }), orderEnv(kv))).json();
    await worker.fetch(webhookUpdate({ message: { chat: { id: 444444444, type: "private" }, from: { first_name: "Anna" }, text: `/start order_${orderId}` } }), orderEnv(kv));
    await worker.fetch(webhookUpdate(callback(111111111, `ord:${orderId}`)), orderEnv(kv));
    await worker.fetch(webhookUpdate(callback(222222222, `ord:${orderId}`)), orderEnv(kv));
    const confirmations = calls.filter(c => String(c.payload.chat_id) === "444444444" && c.payload.text.includes("принята в работу"));
    assert.equal(confirmations.length, 1);
  });
});

test("accept button from a non-admin is refused", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const { orderId } = await (await worker.fetch(siteRequest({ name: "Анна", contact: "@anna" }), orderEnv(kv))).json();
    await worker.fetch(webhookUpdate(callback(999999999, `ord:${orderId}`)), orderEnv(kv));
    const last = calls.filter(c => c.method === "answerCallbackQuery").pop();
    assert.equal(last.payload.text, "Нет доступа");
    assert.equal(JSON.parse(await kv.get(`order:${orderId}`)).status, "new");
  });
});
