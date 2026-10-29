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
