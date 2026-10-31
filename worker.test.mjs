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

test("/myid returns the private sender numeric ID and does not notify admins", async () => {
  await withTelegramMock(async calls => {
    const response = await worker.fetch(webhook({
      chat: { id: 333333333, type: "private" },
      from: { id: 333333333, first_name: "Tester" },
      text: "/myid",
    }), env);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(String(calls[0].payload.chat_id), "333333333");
    assert.match(calls[0].payload.text, /333333333/);
    assert.ok(!calls.some(call => ["111111111", "222222222"].includes(String(call.payload.chat_id))));
  });
});

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
    const response = await worker.fetch(request, reviewEnv(memoryKV()));
    assert.equal(response.status, 200);
    assert.deepEqual(
      calls.map(call => String(call.payload.chat_id)).sort(),
      ["111111111", "222222222"]
    );
  });
});



test("website order receives a number and sends a privacy-safe card with admin controls", async () => {
 const kv=memoryKV();
 await withTelegramMock(async calls=>{
  const response=await worker.fetch(new Request("https://worker.test/api/request",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Client Name",contact:"+79990000000",model:"Kia"})}),reviewEnv(kv));
  assert.equal(response.status,200);
  const body=await response.json();
  assert.ok(body.orderNumber);
  const saved=JSON.parse(await kv.get("order_no:"+body.orderNumber));
  assert.equal(saved.contact,"+79990000000");
  const cards=calls.filter(c=>c.method==="sendMessage" && ["111111111","222222222"].includes(String(c.payload.chat_id)));
  assert.equal(cards.length,2);
  assert.ok(cards[0].payload.text.includes("заявка №"+body.orderNumber));
  assert.ok(!cards[0].payload.text.includes("+79990000000"));
  assert.ok(cards[0].payload.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==="ord:"+body.orderNumber));
  assert.ok(cards[0].payload.reply_markup.inline_keyboard.flat().some(b=>b.callback_data==="ordinfo:"+body.orderNumber));
 });
});

test("only an admin can request private order details; admin can accept and finish", async()=>{
 const kv=memoryKV(), order={id:"abc123",number:"123456",name:"Private Name",contact:"+79990000000",status:"new",createdAt:"now"};
 await kv.put("order_no:123456",JSON.stringify(order)); await kv.put("order:abc123",JSON.stringify(order));
 await withTelegramMock(async calls=>{
  await worker.fetch(webhookUpdate(callback(999999999,"ordinfo:123456")),reviewEnv(kv));
  assert.ok(calls.some(c=>c.method==="answerCallbackQuery"&&c.payload.text==="Нет доступа"));
  assert.ok(!calls.some(c=>c.method==="sendMessage"&&String(c.payload.chat_id)==="999999999"));
  await worker.fetch(webhookUpdate(callback(111111111,"ordinfo:123456")),reviewEnv(kv));
  assert.ok(calls.some(c=>c.method==="sendMessage"&&c.payload.text.includes("+79990000000")));
  await worker.fetch(webhookUpdate(callback(111111111,"ord:123456")),reviewEnv(kv));
  assert.equal(JSON.parse(await kv.get("order_no:123456")).status,"in_work");
  await worker.fetch(webhookUpdate(callback(111111111,"orddone:123456")),reviewEnv(kv));
  assert.equal(JSON.parse(await kv.get("order_no:123456")).status,"done");
 });
});


test("order details are never sent to a group even when an admin clicks a forwarded card", async()=>{
 const kv=memoryKV(), order={id:"abc123",number:"123456",name:"Private Name",contact:"+79990000000",status:"new",createdAt:"now"};
 await kv.put("order_no:123456",JSON.stringify(order));
 await withTelegramMock(async calls=>{
  await worker.fetch(webhookUpdate(callback(111111111,"ordinfo:123456",{id:-1009876543210,type:"supergroup"})),reviewEnv(kv));
  assert.ok(calls.some(c=>c.method==="answerCallbackQuery"&&/личном чате/.test(c.payload.text)));
  assert.ok(!calls.some(c=>c.method==="sendMessage"&&String(c.payload.chat_id)==="-1009876543210"));
  assert.ok(!calls.some(c=>c.method==="sendMessage"&&String(c.payload.chat_id)==="111111111"&&c.payload.text.includes("+79990000000")));
 });
});

test("website refuses order registration when durable KV is unavailable",async()=>{
 await withTelegramMock(async calls=>{
  const response=await worker.fetch(new Request("https://worker.test/api/request",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Test",contact:"@test"})}),env);
  assert.equal(response.status,503);
  assert.equal(calls.length,0);
 });
});

test("admin forwarding a channel post stages it for category choice before moderation", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const response = await worker.fetch(webhookUpdate({ message: {
      message_id: 90,
      chat: { id: 111111111, type: "private" },
      from: { id: 111111111, first_name: "Admin" },
      forward_origin: { type: "channel", date: 1790000000, chat: { id: -100555, username: "avtoYkorea", type: "channel" }, message_id: 42 },
      caption: "Kia Sorento, 2022",
      photo: [{ file_id: "SMALL" }, { file_id: "LARGE" }]
    }}), reviewEnv(kv));
    assert.equal(response.status, 200);
    const pending = JSON.parse(await kv.get("import_pending:-100555_42"));
    assert.equal(pending.caption, "Kia Sorento, 2022");
    assert.equal(pending.photo[1].file_id, "LARGE");
    assert.equal((await kv.list({ prefix: "car_pending:" })).keys.length, 0);
    assert.ok(calls.some(c => c.method === "sendMessage" && c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "imp:car:-100555_42"));
    assert.ok(calls.some(c => c.method === "sendMessage" && c.payload.reply_markup?.inline_keyboard?.[0]?.[1]?.callback_data === "imp:review:-100555_42"));
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

test("forwarding the same channel post twice does not duplicate category-choice cards", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const message = {
      message_id: 92, chat: { id: 111111111, type: "private" },
      from: { id: 111111111 },
      forward_origin: { type: "channel", date: 1790000000, chat: { id: -100555, username: "avtoYkorea" }, message_id: 43 },
      caption: "Hyundai Tucson"
    };
    await worker.fetch(webhookUpdate({message}), reviewEnv(kv));
    const firstCardCount = calls.filter(c => c.method === "sendMessage" && c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "imp:car:-100555_43").length;
    await worker.fetch(webhookUpdate({message}), reviewEnv(kv));
    const secondCardCount = calls.filter(c => c.method === "sendMessage" && c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "imp:car:-100555_43").length;
    assert.equal(firstCardCount, 2);
    assert.equal(secondCardCount, 2);
    assert.ok(await kv.get("import_pending:-100555_43"));
  });
});

test("forwarded channel post first asks admin to choose car or review; no immediate publication", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const response = await worker.fetch(webhookUpdate({ message: {
      message_id: 190, chat: { id: 111111111, type: "private" }, from: { id: 111111111 },
      forward_origin: { type: "channel", date: 1790000000, chat: { id: -100555, username: "avtoYkorea", type: "channel" }, message_id: 142 },
      caption: "Отличная машина и обслуживание", photo: [{ file_id: "PHOTO" }]
    }}), reviewEnv(kv));
    assert.equal(response.status, 200);
    assert.ok(await kv.get("import_pending:-100555_142"));
    assert.equal((await kv.list({prefix:"car_pending:"})).keys.length,0);
    assert.equal((await kv.list({prefix:"pending:"})).keys.length,0);
    assert.ok(calls.some(c => c.method === "sendMessage" && c.payload.reply_markup?.inline_keyboard?.[0]?.[1]?.callback_data === "imp:review:-100555_142"));
  });
});

test("admin choosing review imports an old post regardless of its date", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    await kv.put("import_pending:-100555_42", JSON.stringify({
      chat:{id:-100555,username:"avtoYkorea"},message_id:42,sourceDate:1500000000,
      caption:"Спасибо за помощь!",photo:[{file_id:"REVIEW_PHOTO"}]
    }));
    await worker.fetch(webhookUpdate(callback(111111111,"imp:review:-100555_42")),reviewEnv(kv));
    const review=JSON.parse(await kv.get("pending:-100555_42"));
    assert.equal(review.text,"Спасибо за помощь!");
    assert.equal(review.fileId,"REVIEW_PHOTO");
    assert.equal((await kv.list({prefix:"approved:"})).keys.length,0);
    assert.ok(calls.some(c=>c.method==="sendPhoto" && c.payload.photo==="REVIEW_PHOTO"));
  });
});

test("admin choosing car rejects posts before 2026-01-01 and accepts boundary date", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const oldDate=Math.floor(Date.UTC(2025,11,31,23,59,59)/1000);
    await kv.put("import_pending:-100555_50",JSON.stringify({chat:{id:-100555,username:"avtoYkorea"},message_id:50,sourceDate:oldDate,caption:"Старая машина"}));
    await worker.fetch(webhookUpdate(callback(111111111,"imp:car:-100555_50")),reviewEnv(kv));
    assert.equal((await kv.list({prefix:"car_pending:"})).keys.length,0);
    const boundary=Math.floor(Date.UTC(2026,0,1)/1000);
    await kv.put("import_pending:-100555_51",JSON.stringify({chat:{id:-100555,username:"avtoYkorea"},message_id:51,sourceDate:boundary,caption:"Kia 2026"}));
    await worker.fetch(webhookUpdate(callback(111111111,"imp:car:-100555_51")),reviewEnv(kv));
    assert.ok(await kv.get("car_pending:car_100555_51"));
    assert.equal((await kv.list({prefix:"car_approved:"})).keys.length,0);
    assert.ok(calls.some(c=>c.method==="sendMessage" && c.payload.text.includes("до 1 января 2026")));
  });
});

test("non-admin cannot choose import category", async () => {
  const kv=memoryKV();
  await withTelegramMock(async calls=>{
    await kv.put("import_pending:-100555_52",JSON.stringify({chat:{id:-100555,username:"avtoYkorea"},message_id:52,sourceDate:1790000000,caption:"Test"}));
    await worker.fetch(webhookUpdate(callback(999999999,"imp:review:-100555_52")),reviewEnv(kv));
    assert.ok(await kv.get("import_pending:-100555_52"));
    assert.equal((await kv.list({prefix:"pending:"})).keys.length,0);
    assert.equal(calls.filter(c=>c.method==="answerCallbackQuery").pop().payload.text,"Нет доступа");
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

function callback(fromId, data, chat = { id: fromId, type: "private" }) {
  return { callback_query: { id: "cb" + data, from: { id: fromId }, data, message: { message_id: 77, chat } } };
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

test("website lead rejects non-JSON bodies before storing or notifying", async () => {
 const kv=memoryKV();
 await withTelegramMock(async calls=>{
  const req=new Request("https://worker.test/api/request",{method:"POST",headers:{"content-type":"text/plain"},body:"name=bad"});
  const res=await worker.fetch(req,orderEnv(kv));
  assert.equal(res.status,415);
  assert.equal((await kv.list({prefix:"order:"})).keys.length,0);
  assert.equal(calls.length,0);
 });
});

test("website lead rejects oversized and wrongly typed fields without side effects", async () => {
 const kv=memoryKV();
 await withTelegramMock(async calls=>{
  const tooLong=await worker.fetch(siteRequest({name:"A".repeat(500),contact:"+79990000000"}),orderEnv(kv));
  assert.equal(tooLong.status,400);
  const wrongType=await worker.fetch(siteRequest({name:["not","text"],contact:"+79990000000"}),orderEnv(kv));
  assert.equal(wrongType.status,400);
  assert.equal((await kv.list({prefix:"order:"})).keys.length,0);
  assert.equal(calls.length,0);
 });
});

test("successful website lead response includes privacy and cache headers", async () => {
 const kv=memoryKV();
 await withTelegramMock(async ()=>{
  const res=await worker.fetch(siteRequest({name:"Тест",contact:"+79990000000"}),orderEnv(kv));
  assert.equal(res.status,200);
  assert.equal(res.headers.get("cache-control"),"no-store");
  assert.equal(res.headers.get("x-content-type-options"),"nosniff");
  assert.equal(res.headers.get("referrer-policy"),"no-referrer");
 });
});
test("site order goes to every admin with an accept button and returns a bot link", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const res = await worker.fetch(siteRequest({ name: "Анна", contact: "@anna", model: "Kia Sorento", budget: "3 млн", country: "Южная Корея" }), orderEnv(kv));
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.orderId, /^[0-9a-f]{16}$/);
    assert.match(body.botLink, /^https:\/\/t\.me\/avtoy_test_bot\?start=order_[0-9a-f]{64}$/);
    const cards = calls.filter(c => c.method === "sendMessage" && c.payload.reply_markup);
    assert.equal(cards.length, 2);
    assert.equal(cards[0].payload.reply_markup.inline_keyboard[0][0].callback_data, `ord:${body.orderNumber}`);
  });
});

test("Telegram binding token is one-time and cannot bind a second chat", async () => {
 const kv=memoryKV();
 await withTelegramMock(async calls=>{
  const created=await (await worker.fetch(siteRequest({name:"Анна",contact:"@anna"}),orderEnv(kv))).json();
  const token=new URL(created.botLink).searchParams.get("start").slice("order_".length);
  assert.match(token,/^[0-9a-f]{64}$/);
  await worker.fetch(webhookUpdate({message:{chat:{id:444444444,type:"private"},from:{id:444444444,first_name:"Anna"},text:"/start order_"+token}}),orderEnv(kv));
  assert.equal(await kv.get("bind_token:"+token),null);
  await worker.fetch(webhookUpdate({message:{chat:{id:555555555,type:"private"},text:"/start order_"+token}}),orderEnv(kv));
  const order=JSON.parse(await kv.get("order:"+created.orderId));
  assert.equal(String(order.chatId),"444444444");
  assert.equal(String(order.telegramId),"444444444");
  assert.ok(calls.some(c=>String(c.payload.chat_id)==="555555555"&&c.payload.text.includes("недействительна")));
 });
});
test("client opens the link, admin accepts, client gets the confirmation", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const res = await worker.fetch(siteRequest({ name: "Анна", contact: "@anna" }), orderEnv(kv));
    const { orderId, botLink } = await res.json();
    const bindToken = new URL(botLink).searchParams.get("start").slice("order_".length);

    await worker.fetch(webhookUpdate({ message: { chat: { id: 444444444, type: "private" }, from: { first_name: "Anna" }, text: `/start order_${bindToken}` } }), orderEnv(kv));
    assert.ok(calls.some(c => String(c.payload.chat_id) === "444444444" && c.payload.text.includes("Telegram подключён к заявке")));

    await worker.fetch(webhookUpdate(callback(111111111, `ord:${orderId}`)), orderEnv(kv));
    assert.ok(calls.some(c => String(c.payload.chat_id) === "444444444" && c.payload.text.includes("принята в работу")));
    const order = JSON.parse(await kv.get(`order:${orderId}`));
    assert.equal(order.status, "in_work");
  });
});

test("accepting an order twice does not message the client twice", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const created = await (await worker.fetch(siteRequest({ name: "Анна", contact: "@anna" }), orderEnv(kv))).json();
    const { orderId } = created;
    const bindToken = new URL(created.botLink).searchParams.get("start").slice("order_".length);
    await worker.fetch(webhookUpdate({ message: { chat: { id: 444444444, type: "private" }, from: { first_name: "Anna" }, text: `/start order_${bindToken}` } }), orderEnv(kv));
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

test("website form reports failure when no admin recipient is configured", async () => {
  await withTelegramMock(async calls => {
    const response = await worker.fetch(siteRequest({ name: "Тест", contact: "+79990000000" }), {
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_ADMIN_IDS: "",
    });
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(calls.length, 0);
  });
});

test("website form can temporarily deliver a phone-only lead to one configured admin", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const response = await worker.fetch(siteRequest({ name: "Иван", contact: "+79991234567" }), {
      ...orderEnv(kv),
      TELEGRAM_ADMIN_IDS: "1095575236",
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    const notices = calls.filter(c => c.method === "sendMessage" && /заявка №/i.test(c.payload.text));
    assert.equal(notices.length, 1);
    assert.equal(String(notices[0].payload.chat_id), "1095575236");
  });
});

test("website form accepts a phone-only contact and sends the lead privately to both admins", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const response = await worker.fetch(siteRequest({ name: "Иван", contact: "+79991234567", model: "Hyundai" }), orderEnv(kv));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    const notices = calls.filter(c => c.method === "sendMessage" && /заявка №/i.test(c.payload.text));
    assert.equal(notices.length, 2);
    assert.ok(notices.every(c => !String(c.payload.chat_id).startsWith("-")));
    assert.ok(notices.every(c => c.payload.text.includes("заявка №" + body.orderNumber)));
    assert.ok(notices.every(c => !c.payload.text.includes("+79991234567")));
  });
});


test("admin can reply to a phone-only website order using Telegram Reply", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const response = await worker.fetch(siteRequest({ name: "Иван", contact: "+79991234567" }), orderEnv(kv));
    const { orderId } = await response.json();
    const card = calls.find(c => c.method === "sendMessage" && c.payload.text.includes("Заявка: " + orderId));
    assert.ok(card);
    await worker.fetch(webhook({ chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "Позвоните завтра", reply_to_message: { text: card.payload.text } }), orderEnv(kv));
    assert.ok(calls.some(c => String(c.payload.chat_id) === "111111111" && c.payload.text.includes("Свяжитесь с ним по контакту из заявки: +79991234567")));
  });
});

test("admin native Reply sends a response to a customer who connected Telegram", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const response = await worker.fetch(siteRequest({ name: "Анна", contact: "+79990000000" }), orderEnv(kv));
    const { orderId, botLink } = await response.json();
    const bindToken = new URL(botLink).searchParams.get("start").slice("order_".length);
    const card = calls.find(c => c.method === "sendMessage" && c.payload.text.includes("Заявка: " + orderId));
    await worker.fetch(webhook({ chat: { id: 444444444, type: "private" }, from: { id: 444444444 }, text: "/start order_" + bindToken }), orderEnv(kv));
    await worker.fetch(webhook({ chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "Подобрали варианты", reply_to_message: { text: card.payload.text } }), orderEnv(kv));
    assert.ok(calls.some(c => String(c.payload.chat_id) === "444444444" && c.payload.text === "Подобрали варианты"));
    assert.ok(calls.some(c => String(c.payload.chat_id) === "111111111" && c.payload.text.includes("Ответ отправлен клиенту")));
  });
});


test("homepage inline JavaScript parses before deployment", async () => {
  const vm = await import("node:vm");
  const response = await worker.fetch(new Request("https://worker.test/"), env);
  assert.equal(response.status, 200);
  const html = await response.text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0, "homepage contains inline JavaScript");
  for (const script of scripts) new vm.Script(script[1]);
});
