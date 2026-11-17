import test from "node:test";
import assert from "node:assert/strict";
import worker from "./worker.js";
import { deliverOrderToMax, handleMaxBotWebhook } from "./max-worker-bridge.js";

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
