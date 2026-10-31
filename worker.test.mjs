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

test("Telegram HTTP 200 with ok:false is treated as a failed send", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).startsWith("https://api.telegram.org/")) {
      calls.push(new URL(String(input)).pathname.split("/").pop());
      return Response.json({ ok: false, description: "bot was blocked by the user" });
    }
    return originalFetch(input, init);
  };
  try {
    const response = await worker.fetch(webhook({
      chat: { id: 333333333, type: "private" },
      from: { id: 333333333, first_name: "Tester" },
      text: "/start",
    }), env);
    assert.equal(response.status, 502);
    assert.deepEqual(calls, ["sendMessage"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
      headers: { "content-type": "application/json", "idempotency-key": "11111111-2222-4333-8444-555555555555" },
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
  const response=await worker.fetch(new Request("https://worker.test/api/request",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"22222222-2222-4222-8222-222222222222"},body:JSON.stringify({name:"Client Name",contact:"+79990000000",model:"Kia"})}),reviewEnv(kv));
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
    assert.equal(pending.photo[0].file_id, "LARGE");
    assert.equal(pending.photo.length, 1, "store one best-size file_id per photo, not Telegram size variants");
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

test("forwarding the same unpublished channel post again resends category-choice cards", async () => {
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
    assert.equal(secondCardCount, 4, "repeat must send a fresh action card to both admins");
    assert.ok(await kv.get("import_pending:-100555_43"));
  });
});

test("re-forwarding a review still awaiting moderation resends its publish button", async () => {
 const kv=memoryKV();
 await withTelegramMock(async calls=>{
  const message={message_id:193,chat:{id:111111111,type:"private"},from:{id:111111111},
   forward_origin:{type:"channel",date:1790000000,chat:{id:-100555,username:"avtoYkorea",type:"channel"},message_id:143},
   caption:"Спасибо за автомобиль",photo:[{file_id:"RETRY_REVIEW_PHOTO"}]};
  await worker.fetch(webhookUpdate({message}),reviewEnv(kv));
  await worker.fetch(webhookUpdate(callback(111111111,"imp:review:-100555_143")),reviewEnv(kv));
  assert.ok(await kv.get("pending:-100555_143"));
  const before=calls.filter(c=>c.method==="sendMessage"&&c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data==="pub:-100555_143").length;
  await worker.fetch(webhookUpdate({message}),reviewEnv(kv));
  const after=calls.filter(c=>c.method==="sendMessage"&&c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data==="pub:-100555_143").length;
  assert.equal(after,before+2,"pending review card must be resent to both admins");
  assert.ok(await kv.get("pending:-100555_143"));
  assert.equal(await kv.get("approved:-100555_143"),null);
 });
});

test("re-forwarding an automobile still awaiting moderation resends its publish button", async()=>{
 const kv=memoryKV();
 await withTelegramMock(async calls=>{
  const message={message_id:194,chat:{id:111111111,type:"private"},from:{id:111111111},
   forward_origin:{type:"channel",date:1790000000,chat:{id:-100555,username:"avtoYkorea",type:"channel"},message_id:144},
   caption:"Kia Sorento 2026",photo:[{file_id:"RETRY_CAR_PHOTO"}]};
  await worker.fetch(webhookUpdate({message}),reviewEnv(kv));
  await worker.fetch(webhookUpdate(callback(111111111,"imp:car:-100555_144")),reviewEnv(kv));
  assert.ok(await kv.get("car_pending:car_100555_144"));
  const before=calls.filter(c=>c.method==="sendMessage"&&c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data==="carpub:car_100555_144").length;
  await worker.fetch(webhookUpdate({message}),reviewEnv(kv));
  const after=calls.filter(c=>c.method==="sendMessage"&&c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data==="carpub:car_100555_144").length;
  assert.equal(after,before+2,"pending car card must be resent to both admins");
  assert.ok(await kv.get("car_pending:car_100555_144"));
  assert.equal(await kv.get("car_approved:car_100555_144"),null);
 });
});

test("re-forwarding an already published channel post does not republish it", async()=>{
 const kv=memoryKV();
 await withTelegramMock(async calls=>{
  const message={message_id:195,chat:{id:111111111,type:"private"},from:{id:111111111},
   forward_origin:{type:"channel",date:1790000000,chat:{id:-100555,username:"avtoYkorea",type:"channel"},message_id:145},
   caption:"Спасибо за помощь",photo:[{file_id:"PUBLISHED_PHOTO"}]};
  await worker.fetch(webhookUpdate({message}),reviewEnv(kv));
  await worker.fetch(webhookUpdate(callback(111111111,"imp:review:-100555_145")),reviewEnv(kv));
  await worker.fetch(webhookUpdate(callback(111111111,"pub:-100555_145")),reviewEnv(kv));
  assert.ok(await kv.get("approved:-100555_145"));
  const publishedCards=calls.filter(c=>c.method==="sendMessage"&&c.payload.text==="Опубликовано на сайте").length;
  await worker.fetch(webhookUpdate({message}),reviewEnv(kv));
  assert.equal(calls.filter(c=>c.method==="sendMessage"&&c.payload.text.includes("уже опубликована на сайте")).length,2);
  assert.equal(calls.filter(c=>c.method==="sendMessage"&&c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data==="pub:-100555_145").length,2);
  assert.ok(await kv.get("approved:-100555_145"));
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

test("configured group media sent by an admin is routed privately to review moderation", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const response = await worker.fetch(webhookUpdate({ message: {
      message_id: 81, chat: { id: Number(REVIEW_GROUP), type: "supergroup" },
      from: { id: 111111111, first_name: "Admin" },
      caption: "Фото автомобиля клиента", photo: [{ file_id: "SMALL" }, { file_id: "GROUP_PHOTO" }]
    }}), reviewEnv(kv));
    assert.equal(response.status, 200);
    assert.ok(await kv.get("import_pending:" + REVIEW_GROUP + "_81"));
    assert.ok(calls.some(c => c.method === "sendPhoto" && String(c.payload.chat_id) === "111111111" && c.payload.photo === "GROUP_PHOTO"));
    assert.ok(calls.some(c => c.method === "sendMessage" && String(c.payload.chat_id) === "111111111" && c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "imp:review:" + REVIEW_GROUP + "_81"));
    assert.equal(calls.some(c => String(c.payload.chat_id) === REVIEW_GROUP), false);
    assert.equal(calls.some(c => c.method === "sendMessage" && String(c.payload.chat_id) === "222222222" && c.payload.reply_markup), true);
  });
});

test("group media notification retries missing admin delivery without duplicating completed sends", async () => {
 const kv=memoryKV(), originalFetch=globalThis.fetch, calls=[];
 let failOnce=true;
 globalThis.fetch=async(input,init={})=>{
  if(String(input).startsWith("https://api.telegram.org/")){
   const method=new URL(String(input)).pathname.split("/").pop(),payload=JSON.parse(init.body||"{}");
   if(method==="sendMessage"&&String(payload.chat_id)==="222222222"&&failOnce){failOnce=false;return Response.json({ok:false,description:"temporary failure"});}
   calls.push({method,payload});return Response.json({ok:true,result:{}});
  }
  return originalFetch(input,init);
 };
 const update={update_id:9001,message:{message_id:82,chat:{id:Number(REVIEW_GROUP),type:"supergroup"},from:{id:111111111,first_name:"Admin"},caption:"Фото для отзыва",photo:[{file_id:"GROUP_PHOTO_RETRY"}]}};
 try{
  const first=await worker.fetch(webhookUpdate(update),reviewEnv(kv));
  assert.equal(first.status,502);
  assert.ok(await kv.get("import_pending:"+REVIEW_GROUP+"_82"));
  const second=await worker.fetch(webhookUpdate(update),reviewEnv(kv));
  assert.equal(second.status,200);
  for(const adminId of ["111111111","222222222"]){
   assert.equal(calls.filter(c=>c.method==="sendPhoto"&&String(c.payload.chat_id)===adminId&&c.payload.photo==="GROUP_PHOTO_RETRY").length,1);
   assert.equal(calls.filter(c=>c.method==="sendMessage"&&String(c.payload.chat_id)===adminId&&c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data==="imp:review:"+REVIEW_GROUP+"_82").length,1);
  }
 }finally{globalThis.fetch=originalFetch;}
});

test("review import keeps staged media and resumes missing admin delivery after failure", async () => {
 const kv=memoryKV(),originalFetch=globalThis.fetch,calls=[];
 let failOnce=true;
 await kv.put("import_pending:"+REVIEW_GROUP+"_83",JSON.stringify({chat:{id:Number(REVIEW_GROUP),type:"supergroup"},message_id:83,sourceType:"group",caption:"Отзыв с фото",photo:[{file_id:"IMPORT_RETRY_PHOTO"}]}));
 globalThis.fetch=async(input,init={})=>{
  if(String(input).startsWith("https://api.telegram.org/")){
   const method=new URL(String(input)).pathname.split("/").pop(),payload=JSON.parse(init.body||"{}");
   if(method==="sendPhoto"&&String(payload.chat_id)==="222222222"&&failOnce){failOnce=false;return Response.json({ok:false,description:"temporary failure"});}
   calls.push({method,payload});return Response.json({ok:true,result:{}});
  }
  return originalFetch(input,init);
 };
 try{
  const update=webhookUpdate(callback(111111111,"imp:review:"+REVIEW_GROUP+"_83"));
  const first=await worker.fetch(update,reviewEnv(kv));
  assert.equal(first.status,502);
  assert.ok(await kv.get("import_pending:"+REVIEW_GROUP+"_83"));
  assert.ok(await kv.get("pending:"+REVIEW_GROUP+"_83"));
  const second=await worker.fetch(webhookUpdate(callback(111111111,"imp:review:"+REVIEW_GROUP+"_83")),reviewEnv(kv));
  assert.equal(second.status,200);
  assert.equal(await kv.get("import_pending:"+REVIEW_GROUP+"_83"),null);
  for(const adminId of ["111111111","222222222"]){
   assert.equal(calls.filter(c=>c.method==="sendPhoto"&&String(c.payload.chat_id)===adminId&&c.payload.photo==="IMPORT_RETRY_PHOTO").length,1);
   assert.equal(calls.filter(c=>c.method==="sendMessage"&&String(c.payload.chat_id)===adminId&&c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data==="pub:"+REVIEW_GROUP+"_83").length,1);
  }
 }finally{globalThis.fetch=originalFetch;}
});

test("admin can upload review photo directly in private bot chat for moderation", async () => {
 const kv=memoryKV();
 await withTelegramMock(async calls=>{
  const response=await worker.fetch(webhookUpdate({message:{message_id:88,chat:{id:111111111,type:"private"},from:{id:111111111,first_name:"Admin"},caption:"Отзыв клиента",photo:[{file_id:"SMALL"},{file_id:"DIRECT_UPLOAD"}]}}),reviewEnv(kv));
  assert.equal(response.status,200);
  const review=JSON.parse(await kv.get("pending:111111111_88"));
  assert.equal(review.fileId,"DIRECT_UPLOAD");
  assert.equal(review.text,"Отзыв клиента");
  assert.ok(calls.some(c=>c.method==="sendMessage"&&String(c.payload.chat_id)==="111111111"&&c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data==="pub:111111111_88"));
  await worker.fetch(webhookUpdate(callback(111111111,"pub:111111111_88")),reviewEnv(kv));
  assert.ok(await kv.get("approved:111111111_88"));
 });
});

test("admin can forward a group review photo to the bot for private moderation", async () => {
  const kv=memoryKV();
  await withTelegramMock(async calls=>{
    const response=await worker.fetch(webhookUpdate({message:{
      message_id:188,chat:{id:111111111,type:"private"},from:{id:111111111,first_name:"Admin"},
      forward_origin:{type:"user",date:1760000000,sender_user:{id:333333333,first_name:"Buyer"}},
      caption:"Отзыв покупателя из группы",photo:[{file_id:"SMALL"},{file_id:"FORWARDED_GROUP_PHOTO"}]
    }}),reviewEnv(kv));
    assert.equal(response.status,200);
    const review=JSON.parse(await kv.get("pending:111111111_188"));
    assert.equal(review.fileId,"FORWARDED_GROUP_PHOTO");
    assert.equal(review.text,"Отзыв покупателя из группы");
    assert.equal(review.name,"Администратор загрузил");
    assert.ok(calls.some(c=>c.method==="sendMessage"&&String(c.payload.chat_id)==="111111111"&&c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data==="pub:111111111_188"));
    assert.equal(calls.some(c=>String(c.payload.chat_id)==="333333333"),false);
  });
});

test("private admin upload retries moderation card after Telegram send failure", async () => {
 const kv=memoryKV(),originalFetch=globalThis.fetch,calls=[];
 let failOnce=true;
 globalThis.fetch=async(input,init={})=>{
  if(String(input).startsWith("https://api.telegram.org/")){
   const method=new URL(String(input)).pathname.split("/").pop(),payload=JSON.parse(init.body||"{}");
   if(method==="sendMessage"&&failOnce){failOnce=false;return Response.json({ok:false,description:"temporary failure"});}
   calls.push({method,payload});return Response.json({ok:true,result:{}});
  }
  return originalFetch(input,init);
 };
 const update={update_id:9902,message:{message_id:89,chat:{id:111111111,type:"private"},from:{id:111111111},photo:[{file_id:"DIRECT_RETRY"}]}};
 try{
  const first=await worker.fetch(webhookUpdate(update),reviewEnv(kv));
  assert.equal(first.status,502);
  assert.equal(JSON.parse(await kv.get("admin_upload:111111111_89")).cardSent,false);
  const second=await worker.fetch(webhookUpdate(update),reviewEnv(kv));
  assert.equal(second.status,200);
  assert.equal(calls.filter(c=>c.method==="sendMessage"&&c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data==="pub:111111111_89").length,1);
  assert.equal(JSON.parse(await kv.get("admin_upload:111111111_89")).cardSent,true);
 }finally{globalThis.fetch=originalFetch;}
});

test("non-admin private media upload is not staged or forwarded to administrators", async () => {
 const kv=memoryKV();
 await withTelegramMock(async calls=>{
  const response=await worker.fetch(webhookUpdate({message:{message_id:90,chat:{id:333333333,type:"private"},from:{id:333333333},photo:[{file_id:"UNTRUSTED_UPLOAD"}]}}),reviewEnv(kv));
  assert.equal(response.status,200);
  assert.equal(await kv.get("pending:333333333_90"),null);
  assert.equal(calls.length,0);
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
    assert.ok(!Object.hasOwn(body.reviews[0], "name"), "public reviews must not expose author names");
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
    assert.ok(!Object.hasOwn(body.reviews[0], "name"), "anonymous public reviews must not expose author names");
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
function siteRequest(body, key = crypto.randomUUID()) {
  return new Request("https://worker.test/api/request", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

const orderEnv = (kv) => ({ ...env, TELEGRAM_BOT_USERNAME: "@avtoy_test_bot", REVIEWS: kv });


test("repeating the same website submission key reuses one order and does not resend delivered admin cards", async () => {
  const kv = memoryKV();
  const key = "11111111-2222-4333-8444-555555555555";
  await withTelegramMock(async calls => {
    const first = await worker.fetch(siteRequest({ name: "Иван", contact: "@ivan" }, key), orderEnv(kv));
    const firstBody = await first.json();
    assert.equal(first.status, 200);
    const second = await worker.fetch(siteRequest({ name: "Иван", contact: "@ivan" }, key), orderEnv(kv));
    const secondBody = await second.json();
    assert.equal(second.status, 200);
    assert.equal(secondBody.orderNumber, firstBody.orderNumber);
    assert.equal((await kv.list({ prefix: "order:" })).keys.length, 1);
    assert.equal(calls.filter(c => c.method === "sendMessage" && /заявка №/i.test(c.payload.text)).length, 2);
  });
});

test("same website idempotency key cannot be reused for different customer data", async () => {
  const kv = memoryKV();
  const key = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  await withTelegramMock(async () => {
    await worker.fetch(siteRequest({ name: "Иван", contact: "@ivan" }, key), orderEnv(kv));
    const conflict = await worker.fetch(siteRequest({ name: "Анна", contact: "@anna" }, key), orderEnv(kv));
    assert.equal(conflict.status, 409);
    assert.equal((await kv.list({ prefix: "order:" })).keys.length, 1);
  });
});

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

test("website orders created in the same millisecond receive distinct visible numbers", async () => {
  const kv = memoryKV();
  await withTelegramMock(async () => {
    const first = await (await worker.fetch(siteRequest({ name: "Анна", contact: "+79990000000" }), orderEnv(kv))).json();
    const second = await (await worker.fetch(siteRequest({ name: "Иван", contact: "+79991111111" }), orderEnv(kv))).json();
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.match(first.orderNumber, /^\d{23}$/);
    assert.match(second.orderNumber, /^\d{23}$/);
    assert.notEqual(first.orderNumber, second.orderNumber);
    assert.ok(await kv.get("order_no:" + first.orderNumber));
    assert.ok(await kv.get("order_no:" + second.orderNumber));
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
test("failed KV write during Telegram binding keeps the one-time token for retry", async () => {
 const kv=memoryKV();
 const body=await withTelegramMock(async()=>await (await worker.fetch(siteRequest({name:"Иван",contact:"@ivan"}),orderEnv(kv))).json());
 const token=new URL(body.botLink).searchParams.get("start").slice("order_".length);
 let failOnce=true;
 const flakyKV={
  async get(k){return kv.get(k);},
  async put(k,v,options){if(k==="order_no:"+body.orderNumber&&failOnce){failOnce=false;throw new Error("temporary KV failure");}return kv.put(k,v,options);},
  async delete(k){return kv.delete(k);},
  async list(args){return kv.list(args);}
 };
 const update={update_id:9901,message:{chat:{id:444444444,type:"private"},from:{id:444444444,first_name:"Ivan"},text:"/start order_"+token}};
 await withTelegramMock(async calls=>{
  const first=await worker.fetch(webhookUpdate(update),orderEnv(flakyKV));
  assert.equal(first.status,502);
  assert.ok(await kv.get("bind_token:"+token),"token remains available after partial KV failure");
  const second=await worker.fetch(webhookUpdate(update),orderEnv(flakyKV));
  assert.equal(second.status,200);
  assert.equal(await kv.get("bind_token:"+token),null);
  const order=JSON.parse(await kv.get("order:"+body.orderId));
  assert.equal(String(order.chatId),"444444444");
  assert.equal(String(order.telegramId),"444444444");
  assert.ok(calls.some(c=>String(c.payload.chat_id)==="444444444"&&c.payload.text.includes("Telegram подключён к заявке")));
 });
});

test("client opens the link, admin accepts, client gets the confirmation", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const res = await worker.fetch(siteRequest({ name: "Анна", contact: "@anna" }), orderEnv(kv));
    const { orderId, botLink } = await res.json();
    const bindToken = new URL(botLink).searchParams.get("start").slice("order_".length);

    await worker.fetch(webhookUpdate({ message: { chat: { id: 444444444, type: "private" }, from: { id: 444444444, first_name: "Anna" }, text: `/start order_${bindToken}` } }), orderEnv(kv));
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
    await worker.fetch(webhookUpdate({ message: { chat: { id: 444444444, type: "private" }, from: { id: 444444444, first_name: "Anna" }, text: `/start order_${bindToken}` } }), orderEnv(kv));
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


test("admin Reply can resolve a card containing only the visible order number", async () => {
  const kv = memoryKV();
  const order = { id: "0123456789abcdef", number: "1793456789012", contact: "+79990000000", chatId: "444444444", status: "new" };
  await kv.put("order_no:" + order.number, JSON.stringify(order));
  await withTelegramMock(async calls => {
    await worker.fetch(webhook({ chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "Ответ по заявке", reply_to_message: { text: "🚘 Новая заявка №" + order.number } }), orderEnv(kv));
    assert.ok(calls.some(c => String(c.payload.chat_id) === "444444444" && c.payload.text === "Ответ по заявке"));
    assert.ok(calls.some(c => String(c.payload.chat_id) === "111111111" && c.payload.text.includes("Ответ отправлен клиенту")));
  });
});

test("admin import buttons are rejected outside the admin private chat", async () => {
  const kv = memoryKV();
  await kv.put("import_pending:-100123_77", JSON.stringify({ chat: { id: -100123, username: "avtoykorea" }, message_id: 77, text: "Post" }));
  await withTelegramMock(async calls => {
    const update = webhookUpdate(callback(111111111, "imp:review:-100123_77", { id: -100123, type: "supergroup" }));
    const response = await worker.fetch(update, reviewEnv(kv));
    assert.equal(response.status, 200);
    assert.ok(await kv.get("import_pending:-100123_77"));
    const answer = calls.find(c => c.method === "answerCallbackQuery");
    assert.match(answer.payload.text, /только в личном чате/);
    assert.equal(calls.some(c => c.method === "sendMessage" && String(c.payload.chat_id) === "111111111"), false);
  });
});

test("channel album imports one vehicle with all photos", async () => {
  const kv = memoryKV();
  await withTelegramMock(async calls => {
    const first = { update_id: 7001, channel_post: { message_id: 77, media_group_id: "album-abc", date: 1790000000, chat: { id: -100555, username: "avtoYkorea", type: "channel" }, caption: "Kia Sorento 2022", photo: [{file_id:"PHOTO_1"}] }};
    const second = { update_id: 7002, channel_post: { message_id: 78, media_group_id: "album-abc", date: 1790000000, chat: { id: -100555, username: "avtoYkorea", type: "channel" }, photo: [{file_id:"PHOTO_2"}] }};
    assert.equal((await worker.fetch(webhookUpdate(first), reviewEnv(kv))).status, 200);
    assert.equal((await worker.fetch(webhookUpdate(second), reviewEnv(kv))).status, 200);
    const staged = JSON.parse(await kv.get("import_pending:-100555_77"));
    assert.equal(staged.post.caption, "Kia Sorento 2022");
    assert.deepEqual(staged.post.photo.map(p => p.file_id), ["PHOTO_1","PHOTO_2"]);
    assert.equal(calls.filter(c => c.method === "sendMessage" && c.payload.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === "imp:car:-100555_77").length, 2); // one notification per configured admin
    await worker.fetch(webhookUpdate(callback(111111111, "imp:car:-100555_77")), reviewEnv(kv));
    const cars = await kv.list({prefix:"car_pending:"});
    assert.equal(cars.keys.length, 1);
    const car = JSON.parse(await kv.get(cars.keys[0].name));
    assert.deepEqual(car.photos.map(p => p.file_id), ["PHOTO_1","PHOTO_2"]);
    assert.equal(calls.filter(c => c.method === "sendMediaGroup").length, 2);
  });
});

test("public car and review APIs remove Telegram promotional footer and source links", async () => {
 const kv=memoryKV();
 await kv.put("car_approved:car_100555_3383",JSON.stringify({id:"car_100555_3383",caption:"Kia Sorento 2022\nПробег 20 000 км\nЦена под ключ: 1.716.671 ₽\n📞 Владимир: +79537477230\n📲 WhatsApp / Telegram\nhttps://t.me/avtoYkorea\nВидео\n\nИсточник: https://t.me/avtoYkorea/3383",sourceUrl:"https://t.me/avtoYkorea/3383",fileId:"CAR_MEDIA",publishedAt:"2026-10-31"}));
 await kv.put("approved:-100555_3383",JSON.stringify({id:"-100555_3383",kind:"video",text:"Отличный автомобиль!\n\nДля заказа аналогичного автомобиля обращайтесь:\n📞 Владимир: +79537477230\n📲 WhatsApp / Telegram\nhttps://t.me/avtoYkorea\nВидео\n\nИсточник: https://t.me/avtoYkorea/3383",name:"Клиент",fileId:"REVIEW_MEDIA"}));
 const siteEnv=reviewEnv(kv);
 const cars=await (await worker.fetch(new Request("https://worker.test/api/cars"),siteEnv)).json();
 assert.equal(cars.cars[0].caption,"Kia Sorento 2022\nПробег 20 000 км\nЦена под ключ: 1.716.671 ₽\n📞 Владимир:");
 assert.equal(Object.hasOwn(cars.cars[0],"sourceUrl"),false);
 const reviews=await (await worker.fetch(new Request("https://worker.test/api/reviews"),siteEnv)).json();
 assert.equal(reviews.reviews[0].text,"Отличный автомобиль!");
 assert.equal(Object.hasOwn(reviews.reviews[0],"name"),false);
 assert.match(cars.cars[0].caption,/Владимир/);
 assert.doesNotMatch(JSON.stringify({cars,reviews}),/79537477230|WhatsApp|avtoYkorea|Источник:|Видео/);
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


test("website order retry delivers only the admin whose first notification failed", async () => {
  const kv = memoryKV();
  const originalFetch = globalThis.fetch;
  const deliveries = [];
  let failFirstAdmin = true;
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).startsWith("https://api.telegram.org/")) {
      const payload = JSON.parse(init.body || "{}");
      const recipient = String(payload.chat_id);
      deliveries.push(recipient);
      if (recipient === "111111111" && failFirstAdmin) {
        return Response.json({ ok: false, description: "temporary failure" });
      }
      return Response.json({ ok: true, result: {} });
    }
    return originalFetch(input, init);
  };
  try {
    const key = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const body = { name: "Retry Test", contact: "@retry", model: "Kia" };
    const first = await worker.fetch(siteRequest(body, key), orderEnv(kv));
    assert.equal(first.status, 503);
    assert.deepEqual(deliveries, ["111111111", "222222222"]);
    failFirstAdmin = false;
    const retry = await worker.fetch(siteRequest(body, key), orderEnv(kv));
    assert.equal(retry.status, 200);
    assert.deepEqual(deliveries, ["111111111", "222222222", "111111111"]);
    assert.equal((await kv.list({ prefix: "order:" })).keys.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("website form does not resend an old stored payload after the customer edits the form", async () => {
  const vm = await import("node:vm");
  const response = await worker.fetch(new Request("https://worker.test/"), env);
  const html = await response.text();
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes("request-form"));
  assert.ok(script, "homepage contains the request form script");
  const storage = new Map();
  const sessionStorage = {
    getItem: k => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: k => storage.delete(k)
  };
  const makeElement = () => ({ addEventListener() {}, style: {}, setAttribute() {}, appendChild() {}, focus() {}, textContent: "", disabled: false, reset() {} });
  const elements = {};
  const form = makeElement();
  let submitHandler = null;
  form.addEventListener = (type, fn) => { if (type === "submit") submitHandler = fn; };
  const document = {
    getElementById: id => (id === "request-form" ? form : (elements[id] ||= makeElement())),
    querySelectorAll: () => [],
    createElement: () => makeElement()
  };
  let currentForm = {};
  const sent = [];
  const context = {
    document, sessionStorage, crypto: globalThis.crypto, JSON, Object, console,
    window: { setTimeout: () => 0 },
    location: { origin: "https://worker.test", href: "" },
    FormData: class { entries() { return Object.entries(currentForm); } },
    fetch: async (url, init) => {
      sent.push({ body: JSON.parse(init.body), key: init.headers["idempotency-key"] });
      return { ok: false, status: 503, text: async () => JSON.stringify({ ok: false, error: "temporary" }) };
    }
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  assert.ok(submitHandler, "form submit handler is registered");

  currentForm = { name: "Иван", contact: "@ivan", model: "Kia" };
  await submitHandler({ preventDefault() {} });
  currentForm = { name: "Иван", contact: "+79001112233", model: "Kia" };
  await submitHandler({ preventDefault() {} });

  assert.equal(sent.length, 2);
  assert.equal(sent[1].body.contact, "+79001112233", "corrected contact must be sent, not the stale one");
  assert.notEqual(sent[1].key, sent[0].key, "edited form must get a new idempotency key");
});


test("webhook retry skips admins who already received a client message", async () => {
  const kv = memoryKV();
  const originalFetch = globalThis.fetch;
  const deliveries = [];
  let failSecondAdmin = true;
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).startsWith("https://api.telegram.org/")) {
      const payload = JSON.parse(init.body || "{}");
      const recipient = String(payload.chat_id);
      deliveries.push(recipient);
      if (recipient === "222222222" && failSecondAdmin) return Response.json({ ok: false, description: "temporary failure" });
      return Response.json({ ok: true, result: {} });
    }
    return originalFetch(input, init);
  };
  try {
    const update = { update_id: 987654321, message: {
      message_id: 77, chat: { id: 333333333, type: "private" },
      from: { id: 333333333, first_name: "Client" }, text: "Нужна консультация"
    }};
    const first = await worker.fetch(webhookUpdate(update), reviewEnv(kv));
    assert.equal(first.status, 502);
    assert.deepEqual(deliveries, ["111111111", "222222222"]);
    failSecondAdmin = false;
    const retry = await worker.fetch(webhookUpdate(update), reviewEnv(kv));
    assert.equal(retry.status, 200);
    // Admin 111 is not resent; admin 222 gets the card once; the client gets the thank-you once, for the first time.
    assert.deepEqual(deliveries, ["111111111", "222222222", "222222222", "333333333"]);
    const again = await worker.fetch(webhookUpdate(update), reviewEnv(kv));
    assert.equal(again.status, 200);
    assert.deepEqual(deliveries, ["111111111", "222222222", "222222222", "333333333"]);
    assert.ok(await kv.get("webhook_delivery:987654321"));
  } finally { globalThis.fetch = originalFetch; }
});

test("admin native Reply never sends a whitespace-only customer message", async () => {
  const kv = memoryKV();
  const order = { id: "0123456789abcdef", number: "1793456789012", contact: "+79990000000", chatId: "444444444", status: "new" };
  await kv.put("order_no:" + order.number, JSON.stringify(order));
  await withTelegramMock(async calls => {
    const response = await worker.fetch(webhook({
      chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, text: "   ",
      reply_to_message: { text: "🚘 Новая заявка №" + order.number }
    }), orderEnv(kv));
    assert.equal(response.status, 200);
    assert.equal(calls.some(c => String(c.payload.chat_id) === "444444444"), false);
    assert.ok(calls.some(c => String(c.payload.chat_id) === "111111111" && /Ответ пустой/.test(c.payload.text)));
  });
});

test("client thank-you failure retry does not resend admin cards", async () => {
  const kv = memoryKV();
  const originalFetch = globalThis.fetch;
  const deliveries = [];
  let failClientThanks = true;
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).startsWith("https://api.telegram.org/")) {
      const payload = JSON.parse(init.body || "{}");
      const recipient = String(payload.chat_id);
      deliveries.push(recipient);
      if (recipient === "333333333" && failClientThanks) return Response.json({ ok: false, description: "temporary failure" });
      return Response.json({ ok: true, result: {} });
    }
    return originalFetch(input, init);
  };
  try {
    const update = { update_id: 555000111, message: {
      message_id: 90, chat: { id: 333333333, type: "private" },
      from: { id: 333333333, first_name: "Client" }, text: "Вопрос по Kia"
    }};
    const first = await worker.fetch(webhookUpdate(update), reviewEnv(kv));
    assert.equal(first.status, 502);
    assert.deepEqual(deliveries, ["111111111", "222222222", "333333333"]);
    failClientThanks = false;
    const retry = await worker.fetch(webhookUpdate(update), reviewEnv(kv));
    assert.equal(retry.status, 200);
    assert.deepEqual(deliveries, ["111111111", "222222222", "333333333", "333333333"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("messages without update_id or message_id are each delivered, not dropped as duplicates", async () => {
  const kv = memoryKV();
  const originalFetch = globalThis.fetch;
  const adminDeliveries = [];
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).startsWith("https://api.telegram.org/")) {
      const payload = JSON.parse(init.body || "{}");
      if (String(payload.chat_id) === "111111111") adminDeliveries.push(payload.text);
      return Response.json({ ok: true, result: {} });
    }
    return originalFetch(input, init);
  };
  try {
    const first = await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
      body: JSON.stringify({ message: { chat: { id: 333333333, type: "private" }, from: { id: 333333333, first_name: "Client" }, text: "Первое сообщение" } })
    }), reviewEnv(kv));
    const second = await worker.fetch(new Request("https://worker.test/telegram/webhook", {
      method: "POST", headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "hook-secret" },
      body: JSON.stringify({ message: { chat: { id: 333333333, type: "private" }, from: { id: 333333333, first_name: "Client" }, text: "Второе сообщение" } })
    }), reviewEnv(kv));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(adminDeliveries.filter(t => t.includes("Первое сообщение")).length, 1);
    assert.equal(adminDeliveries.filter(t => t.includes("Второе сообщение")).length, 1);
  } finally { globalThis.fetch = originalFetch; }
});


test("failed order acceptance notification is retried on the next callback", async () => {
  const kv = memoryKV();
  const originalFetch = globalThis.fetch;
  let failClientNotice = true;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    if (String(input).startsWith("https://api.telegram.org/")) {
      const method = new URL(String(input)).pathname.split("/").pop();
      const payload = JSON.parse(init.body || "{}");
      calls.push({ method, payload });
      if (method === "sendMessage" && String(payload.chat_id) === "444444444" && String(payload.text || "").includes("принята в работу") && failClientNotice) {
        failClientNotice = false;
        return Response.json({ ok: false, description: "temporary failure" });
      }
      return Response.json({ ok: true, result: {} });
    }
    return originalFetch(input, init);
  };
  try {
    const created = await (await worker.fetch(siteRequest({ name: "Анна", contact: "@anna" }), orderEnv(kv))).json();
    const token = new URL(created.botLink).searchParams.get("start").slice("order_".length);
    await worker.fetch(webhookUpdate({ message: { chat: { id: 444444444, type: "private" }, from: { id: 444444444, first_name: "Anna" }, text: "/start order_" + token } }), orderEnv(kv));

    const first = await worker.fetch(webhookUpdate(callback(111111111, "ord:" + created.orderId)), orderEnv(kv));
    assert.equal(first.status, 502);
    assert.equal(JSON.parse(await kv.get("order:" + created.orderId)).status, "in_work");
    assert.equal(JSON.parse(await kv.get("order:" + created.orderId)).acceptanceNotifiedAt, undefined);

    const retry = await worker.fetch(webhookUpdate(callback(111111111, "ord:" + created.orderId)), orderEnv(kv));
    assert.equal(retry.status, 200);
    const order = JSON.parse(await kv.get("order:" + created.orderId));
    assert.ok(order.acceptanceNotifiedAt);
    const notices = calls.filter(c => c.method === "sendMessage" && String(c.payload.chat_id) === "444444444" && c.payload.text.includes("принята в работу"));
    assert.equal(notices.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});


test("admin edit session ignores replies to unrelated messages", async () => {
 const kv=memoryKV();
 const id="-100123_900";
 await kv.put("pending:"+id,JSON.stringify({id,kind:"video",text:"Исходный текст",name:"Клиент",fileId:"VIDEO",hasPhoto:false,anonymous:false}));
 await withTelegramMock(async calls=>{
  await worker.fetch(webhookUpdate(callback(111111111,"edit:"+id)),reviewEnv(kv));
  const response=await worker.fetch(webhookUpdate({message:{message_id:901,chat:{id:111111111,type:"private"},from:{id:111111111},text:"Это обычный ответ",reply_to_message:{text:"Другое сообщение бота"}}}),reviewEnv(kv));
  assert.equal(response.status,200);
  const saved=JSON.parse(await kv.get("pending:"+id));
  assert.equal(saved.text,"Исходный текст");
  assert.ok(await kv.get("moderation_edit:111111111"),"edit session must remain active");
 });
});

test("admin can edit a pending review before publishing; original text is retained", async () => {
 const kv = memoryKV();
 const id = "-100123_901";
 await kv.put("pending:" + id, JSON.stringify({id,kind:"video",text:"Старый текст",name:"Клиент",fileId:"VIDEO",hasPhoto:false,anonymous:false}));
 await withTelegramMock(async calls => {
  const started = await worker.fetch(webhookUpdate(callback(111111111,"edit:" + id)), reviewEnv(kv));
  assert.equal(started.status,200);
  const prompt = calls.find(c=>c.method==="sendMessage" && String(c.payload.text||"").startsWith("✏️ РЕДАКТИРОВАНИЕ"));
  assert.ok(prompt);
  assert.ok(await kv.get("moderation_edit:111111111"), "callback must persist the admin edit session");
  const response = await worker.fetch(webhookUpdate({message:{message_id:902,chat:{id:111111111,type:"private"},from:{id:111111111},text:"Новый текст отзыва",reply_to_message:{text:prompt.payload.text}}}),reviewEnv(kv));
  assert.equal(response.status,200);
  const saved=JSON.parse(await kv.get("pending:"+id));
  assert.equal(saved.text,"Новый текст отзыва");
  assert.equal(saved.originalText,"Старый текст");
  assert.ok(calls.some(c=>c.method==="sendMessage" && String(c.payload.text||"").includes("Текст обновлён")));
 });
});

test("admin can edit a pending car caption and the public API uses only the edited caption", async () => {
 const kv=memoryKV();
 const id="car_100555_902";
 await kv.put("car_pending:"+id,JSON.stringify({id,caption:"Старое описание",fileId:"PHOTO",photos:[{file_id:"PHOTO"}],mediaType:"photo"}));
 await withTelegramMock(async calls=>{
  const started=await worker.fetch(webhookUpdate(callback(111111111,"caredit:"+id)),reviewEnv(kv));
  assert.equal(started.status,200);
  const prompt=calls.find(c=>c.method==="sendMessage" && String(c.payload.text||"").startsWith("✏️ РЕДАКТИРОВАНИЕ"));
  assert.ok(prompt);
  const response=await worker.fetch(webhookUpdate({message:{message_id:903,chat:{id:111111111,type:"private"},from:{id:111111111},text:"Kia Sorento 2022\nПробег 20 000 км\nТелефон: +79991234567",reply_to_message:{text:prompt.payload.text}}}),reviewEnv(kv));
  assert.equal(response.status,200);
  const saved=JSON.parse(await kv.get("car_pending:"+id));
  assert.equal(saved.caption,"Kia Sorento 2022\nПробег 20 000 км");
  assert.equal(saved.originalCaption,"Старое описание");
  await worker.fetch(webhookUpdate(callback(111111111,"carpub:"+id)),reviewEnv(kv));
  const cars=await (await worker.fetch(new Request("https://worker.test/api/cars"),reviewEnv(kv))).json();
  assert.equal(cars.cars[0].caption,"Kia Sorento 2022\nПробег 20 000 км");
  assert.doesNotMatch(JSON.stringify(cars),/79991234567/);
 });
});


test("channel album imported as one review keeps every photo through publication and website API", async () => {
 const kv=memoryKV();
 await withTelegramMock(async calls=>{
  const first={channel_post:{message_id:440,chat:{id:-100555,username:"avtoYkorea",type:"channel"},date:1790000000,media_group_id:"778899",caption:"Спасибо за автомобиль!",photo:[{file_id:"ALBUM_PHOTO_1_SMALL"},{file_id:"ALBUM_PHOTO_1"}]}};
  const second={channel_post:{message_id:441,chat:{id:-100555,username:"avtoYkorea",type:"channel"},date:1790000000,media_group_id:"778899",photo:[{file_id:"ALBUM_PHOTO_2_SMALL"},{file_id:"ALBUM_PHOTO_2"}]}};
  await worker.fetch(webhookUpdate(first),reviewEnv(kv));
  await worker.fetch(webhookUpdate(second),reviewEnv(kv));
  const staged=JSON.parse(await kv.get("import_pending:-100555_440"));
  assert.deepEqual(staged.post.photo.map(p=>p.file_id),["ALBUM_PHOTO_1","ALBUM_PHOTO_2"]);
  await worker.fetch(webhookUpdate(callback(111111111,"imp:review:-100555_440")),reviewEnv(kv));
  const pending=JSON.parse(await kv.get("pending:-100555_440"));
  assert.deepEqual(pending.photos.map(p=>p.file_id),["ALBUM_PHOTO_1","ALBUM_PHOTO_2"]);
  assert.ok(calls.some(c=>c.method==="sendMediaGroup"&&String(c.payload.chat_id)==="111111111"&&c.payload.media.map(m=>m.media).join(",")==="ALBUM_PHOTO_1,ALBUM_PHOTO_2"));
  await worker.fetch(webhookUpdate(callback(111111111,"pub:-100555_440")),reviewEnv(kv));
  const approved=JSON.parse(await kv.get("approved:-100555_440"));
  assert.deepEqual(approved.photos.map(p=>p.file_id),["ALBUM_PHOTO_1","ALBUM_PHOTO_2"]);
  const response=await worker.fetch(new Request("https://worker.test/api/reviews"),reviewEnv(kv));
  const body=await response.json();
  assert.deepEqual(body.reviews[0].mediaItems,["/api/review-media/-100555_440/0","/api/review-media/-100555_440/1"]);
 });
});

test("editing one phrase in a review preserves every photo and shows the current text", async () => {
 const kv=memoryKV();
 await kv.put("pending:"+REVIEW_GROUP+"_901",JSON.stringify({
  id:REVIEW_GROUP+"_901",kind:"text",text:"Спасибо за автомобиль. Всё понравилось.",name:"Клиент",
  fileId:"EDIT_PHOTO_1",photos:[{file_id:"EDIT_PHOTO_1"},{file_id:"EDIT_PHOTO_2"}],
  hasPhoto:true,hasThanks:true,anonymous:false,createdAt:"now"
 }));
 await withTelegramMock(async calls=>{
  await worker.fetch(webhookUpdate(callback(111111111,"edit:"+REVIEW_GROUP+"_901")),reviewEnv(kv));
  const prompt=calls.find(c=>c.method==="sendMessage"&&String(c.payload.chat_id)==="111111111"&&c.payload.reply_markup?.force_reply);
  assert.ok(prompt);
  assert.ok(prompt.payload.text.includes("Спасибо за автомобиль. Всё понравилось."));
  await worker.fetch(webhookUpdate({message:{
   message_id:902,chat:{id:111111111,type:"private"},from:{id:111111111},
   reply_to_message:{message_id:prompt.payload.message_id||1,text:prompt.payload.text},
   text:"ЗАМЕНИТЬ: Всё понравилось => Всё отлично"
  }}),reviewEnv(kv));
  const updated=JSON.parse(await kv.get("pending:"+REVIEW_GROUP+"_901"));
  assert.equal(updated.text,"Спасибо за автомобиль. Всё отлично.");
  assert.deepEqual(updated.photos.map(p=>p.file_id),["EDIT_PHOTO_1","EDIT_PHOTO_2"]);
  assert.equal(updated.hasThanks,true);
 });
});

test("failed fragment edit leaves review text unchanged and allows a later edit", async()=>{
 const kv=memoryKV();
 await kv.put("pending:"+REVIEW_GROUP+"_903",JSON.stringify({id:REVIEW_GROUP+"_903",kind:"text",text:"Исходный текст отзыва",name:"Клиент",fileId:"PHOTO",photos:[{file_id:"PHOTO"}],hasPhoto:true,anonymous:false}));
 await withTelegramMock(async calls=>{
  await worker.fetch(webhookUpdate(callback(111111111,"edit:"+REVIEW_GROUP+"_903")),reviewEnv(kv));
  const prompt=calls.find(c=>c.method==="sendMessage"&&c.payload.reply_markup?.force_reply);
  const reply={message_id:904,chat:{id:111111111,type:"private"},from:{id:111111111},reply_to_message:{message_id:1,text:prompt.payload.text},text:"ЗАМЕНИТЬ: такого фрагмента нет => новый"};
  await worker.fetch(webhookUpdate({message:reply}),reviewEnv(kv));
  assert.equal(JSON.parse(await kv.get("pending:"+REVIEW_GROUP+"_903")).text,"Исходный текст отзыва");
  await worker.fetch(webhookUpdate({message:{...reply,message_id:905,text:"ДОБАВИТЬ В КОНЕЦ: Дополнение"}}),reviewEnv(kv));
  assert.equal(JSON.parse(await kv.get("pending:"+REVIEW_GROUP+"_903")).text,"Исходный текст отзыва\n\nДополнение");
 });
});

test("one Telegram photo sent in several sizes is stored as a single photo", async () => {
  const kv = memoryKV();
  await withTelegramMock(async () => {
    await worker.fetch(webhookUpdate({ message: { message_id: 300, chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, caption: "Отзыв, спасибо", photo: [{ file_id: "SMALL" }, { file_id: "MEDIUM" }, { file_id: "LARGE" }] } }), reviewEnv(kv));
    const saved = JSON.parse(await kv.get("pending:111111111_300"));
    assert.deepEqual(saved.photos.map(p => p.file_id), ["LARGE"]);
    assert.equal(saved.fileId, "LARGE");
  });
});

test("group review album keeps photos from every message and shows them on the site after publishing", async () => {
  const kv = memoryKV();
  const chat = { id: Number(REVIEW_GROUP), type: "supergroup" };
  const from = { id: 333333333, first_name: "Buyer" };
  await withTelegramMock(async () => {
    // Фото без команды приходит раньше /review; его нужно не потерять.
    await worker.fetch(webhookUpdate({ message: { message_id: 401, chat, from, media_group_id: "7700001", photo: [{ file_id: "A_S" }, { file_id: "A_L" }] } }), reviewEnv(kv));
    await worker.fetch(webhookUpdate({ message: { message_id: 402, chat, from, media_group_id: "7700001", caption: "/review Отличный автомобиль, спасибо!", photo: [{ file_id: "B_S" }, { file_id: "B_L" }] } }), reviewEnv(kv));
    await worker.fetch(webhookUpdate({ message: { message_id: 403, chat, from, media_group_id: "7700001", photo: [{ file_id: "C_S" }, { file_id: "C_L" }] } }), reviewEnv(kv));
    const id = REVIEW_GROUP + "_7700001";
    const pending = JSON.parse(await kv.get("pending:" + id));
    assert.deepEqual(pending.photos.map(p => p.file_id), ["A_L", "B_L", "C_L"]);
    assert.equal(await kv.get("pending:" + REVIEW_GROUP + "_402"), null, "album must not create a second review");
    await worker.fetch(webhookUpdate(callback(111111111, "pub:" + id)), reviewEnv(kv));
    const body = await (await worker.fetch(new Request("https://worker.test/api/reviews"), reviewEnv(kv))).json();
    const item = body.reviews.find(r => r.id === id);
    assert.ok(item, "published album is visible on the site");
    assert.equal(item.mediaItems.length, 3, "every album photo is shown on the site");
  });
});

test("admin album uploaded in the private chat keeps every photo in one review", async () => {
  const kv = memoryKV();
  await withTelegramMock(async () => {
    await worker.fetch(webhookUpdate({ message: { message_id: 501, chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, caption: "Отзыв клиента, спасибо", media_group_id: "880002", photo: [{ file_id: "X1_S" }, { file_id: "X1_L" }] } }), reviewEnv(kv));
    await worker.fetch(webhookUpdate({ message: { message_id: 502, chat: { id: 111111111, type: "private" }, from: { id: 111111111 }, media_group_id: "880002", photo: [{ file_id: "X2_S" }, { file_id: "X2_L" }] } }), reviewEnv(kv));
    const saved = JSON.parse(await kv.get("pending:111111111_880002"));
    assert.deepEqual(saved.photos.map(p => p.file_id), ["X1_L", "X2_L"]);
    assert.equal(saved.text, "Отзыв клиента, спасибо");
    assert.equal(await kv.get("pending:111111111_501"), null);
  });
});
