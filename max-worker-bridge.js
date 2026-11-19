// Dual-channel MAX messenger integration for AVTOY KOREA Cloudflare Worker.
// Keeps customer PII strictly inside private admin dialogs (never in group chats).
import { cleanCarDisplayCaption, isCarListingPost } from "./catalog-formatter.js";

export const MAX_API_BASE = "https://platform-api2.max.ru";
export const MAX_TELEGRAM_BOT_VIDEO_BYTES = 20 * 1024 * 1024;

function isSafeMaxCdnUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    if (parsed.protocol !== "https:") return false;
    const h = parsed.hostname.toLowerCase();
    return (
      h === "max.ru" || h.endsWith(".max.ru") ||
      h === "mycdn.me" || h.endsWith(".mycdn.me") ||
      h === "userapi.com" || h.endsWith(".userapi.com")
    );
  } catch {
    return false;
  }
}

export function extractMaxImageUrls(message) {
  const rawList = [
    ...(Array.isArray(message?.attachments) ? message.attachments : []),
    ...(Array.isArray(message?.body?.attachments) ? message.body.attachments : [])
  ];
  const seen = new Set();
  const urls = [];
  for (const item of rawList) {
    const kind = String(item?.type || "").toLowerCase();
    if (kind !== "image" && kind !== "photo") continue;
    const url = String(item?.payload?.url || "").trim();
    if (!url || seen.has(url) || !isSafeMaxCdnUrl(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= 10) break;
  }
  return urls;
}

function parsePositiveIds(raw) {
  return [...new Set(
    String(raw || "")
      .split(/[\s,]+/)
      .map(s => s.trim())
      .filter(s => /^\d{1,24}$/.test(s) && Number(s) > 0)
  )];
}

function safeSecretEqual(a, b) {
  const sa = String(a || "");
  const sb = String(b || "");
  if (!sa || sa.length !== sb.length) return false;
  let diff = 0;
  for (let i = 0; i < sa.length; i++) {
    diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  }
  return diff === 0;
}

function cleanLine(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

export async function callMaxApi(env, query, text, fetchImpl = fetch) {
  const token = String(env.MAX_BOT_TOKEN || "").trim();
  if (!token) return { ok: false, reason: "max_not_configured" };
  const safeText = cleanLine(text, 3900);
  if (!safeText) return { ok: false, reason: "empty_text" };
  try {
    const response = await fetchImpl(`${MAX_API_BASE}/messages?${query}`, {
      method: "POST",
      headers: {
        Authorization: token,
        "content-type": "application/json"
      },
      body: JSON.stringify({ text: safeText, notify: true })
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body?.success !== false) {
      return { ok: true, result: body };
    }
    return { ok: false, status: response.status, reason: "max_rejected" };
  } catch {
    return { ok: false, reason: "max_network_error" };
  }
}

export function getMaxAdminIds(env) {
  return parsePositiveIds(env.MAX_ADMIN_IDS || env.MAX_OPERATOR_USER_IDS || "");
}

export async function crosspostCarToMax(env, car, options = {}) {
  const token = String(env.MAX_BOT_TOKEN || "").trim();
  if (!token || !car || !car.id) return { ok: false, reason: "max_not_configured" };

  const kvGroupId = env.REVIEWS
    ? String((await env.REVIEWS.get("site_config:max_public_group_id").catch(() => "")) || "").trim()
    : "";
  const targetChatId = kvGroupId || String(env.MAX_PUBLIC_GROUP_ID || env.MAX_OPERATOR_CHAT_ID || "").trim();
  if (!/^-?\d{1,24}$/.test(targetChatId) || targetChatId === "0") {
    return { ok: false, reason: "max_group_not_configured" };
  }

  if (env.REVIEWS && await env.REVIEWS.get("max_xpost:" + car.id)) {
    return { ok: true, alreadySent: true };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const loadPhotoBytes = typeof options.loadPhotoBytes === "function" ? options.loadPhotoBytes : null;
  const photoItems = Array.isArray(car.photos) && car.photos.length
    ? car.photos.slice(0, 10)
    : (car.fileId && car.mediaType !== "video" ? [{ file_id: car.fileId }] : []);

  const attachments = [];
  if (loadPhotoBytes && photoItems.length) {
    for (let i = 0; i < photoItems.length; i++) {
      try {
        const loaded = await loadPhotoBytes(photoItems[i], i);
        if (!loaded || !loaded.bytes) continue;
        const upUrlResp = await fetchImpl(`${MAX_API_BASE}/uploads?type=image`, {
          method: "POST",
          headers: { Authorization: token }
        });
        if (!upUrlResp.ok) continue;
        const upUrlData = await upUrlResp.json().catch(() => ({}));
        if (!upUrlData || !upUrlData.url) continue;

        const form = new FormData();
        form.append(
          "data",
          new Blob([loaded.bytes], { type: loaded.mimeType || "image/jpeg" }),
          loaded.fileName || `car-${i + 1}.jpg`
        );
        const binResp = await fetchImpl(upUrlData.url, { method: "POST", body: form });
        if (!binResp.ok) continue;
        const binData = await binResp.json().catch(() => ({}));
        const photoMapToken = binData?.photos && typeof binData.photos === "object"
          ? Object.values(binData.photos).find(v => v && v.token)?.token
          : null;
        const imgToken = upUrlData.token || binData?.token || photoMapToken || null;
        if (imgToken) {
          attachments.push({ type: "image", payload: { token: String(imgToken) } });
        }
      } catch {}
    }
  }

  const cleanedText = cleanCarDisplayCaption(car.caption || "").slice(0, 3800);
  const text = cleanedText || (attachments.length ? "Автомобиль под заказ AVTOY KOREA" : "");
  if (!text) return { ok: false, reason: "empty_text" };

  try {
    const response = await fetchImpl(`${MAX_API_BASE}/messages?chat_id=${encodeURIComponent(targetChatId)}`, {
      method: "POST",
      headers: {
        Authorization: token,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        text,
        ...(attachments.length ? { attachments } : {}),
        notify: true
      })
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && body?.success !== false) {
      if (env.REVIEWS) {
        await env.REVIEWS.put(
          "max_xpost:" + car.id,
          JSON.stringify({
            chatId: targetChatId,
            sentAt: new Date().toISOString(),
            attachmentCount: attachments.length
          }),
          { expirationTtl: 7776000 }
        );
      }
      return { ok: true, chatId: targetChatId, attachmentCount: attachments.length };
    }
    return { ok: false, status: response.status, reason: "max_rejected" };
  } catch {
    return { ok: false, reason: "max_network_error" };
  }
}

export async function deliverOrderToMax(env, order, f, idem, saveIdem, fetchImpl = fetch) {
  const token = String(env.MAX_BOT_TOKEN || "").trim();
  if (!token) return { configured: false, deliveredAll: true };

  const maxAdmins = getMaxAdminIds(env);
  const groupChatId = /^\d{1,24}$/.test(String(env.MAX_OPERATOR_CHAT_ID || "").trim())
    ? String(env.MAX_OPERATOR_CHAT_ID).trim()
    : null;

  if (!maxAdmins.length && !groupChatId) {
    return { configured: false, deliveredAll: true };
  }

  const deliveredMax = new Set((idem.deliveredMaxTargets || []).map(String));

  // 1. Private admin dialogs receive full order details so the manager can contact the client immediately.
  const privateCard = [
    `🚘 Новая заявка AVTOY KOREA №${order.number}`,
    `Имя: ${f.name}`,
    `Контакт: ${f.contact}`,
    `Марка / модель: ${f.model || "не указано"}`,
    `Бюджет: ${f.budget || "не указан"}`,
    `Страна: ${f.country || "не указана"}`,
    `Год от: ${f.year || "не указан"}`,
    `Тема: ${f.purpose || "Подбор автомобиля"}`,
    `Пожелания: ${f.details || "нет"}`,
    `ID заявки: ${order.id}`
  ].join("\n");

  for (const userId of maxAdmins) {
    const targetKey = `user:${userId}`;
    if (deliveredMax.has(targetKey)) continue;
    const res = await callMaxApi(env, `user_id=${encodeURIComponent(userId)}`, privateCard, fetchImpl);
    if (res.ok) {
      deliveredMax.add(targetKey);
      idem.deliveredMaxTargets = [...deliveredMax];
      if (saveIdem) await saveIdem(idem);
    }
  }

  // 2. Operator group chat NEVER receives customer name or phone/contact (AGENTS.md privacy rule).
  if (groupChatId) {
    const groupKey = `chat:${groupChatId}`;
    if (!deliveredMax.has(groupKey)) {
      const groupCard = [
        `🚘 Новая заявка AVTOY KOREA №${order.number}`,
        `Модель: ${f.model || "не указано"}`,
        `Бюджет: ${f.budget || "не указан"}`,
        `Страна: ${f.country || "не указана"}`,
        `Тема: ${f.purpose || "Подбор автомобиля"}`,
        `ID: ${order.id}`,
        `Личные контакты отправлены только в личный чат администратора.`
      ].join("\n");
      const res = await callMaxApi(env, `chat_id=${encodeURIComponent(groupChatId)}`, groupCard, fetchImpl);
      if (res.ok) {
        deliveredMax.add(groupKey);
        idem.deliveredMaxTargets = [...deliveredMax];
        if (saveIdem) await saveIdem(idem);
      }
    }
  }

  const requiredTargets = [
    ...maxAdmins.map(id => `user:${id}`),
    ...(groupChatId ? [`chat:${groupChatId}`] : [])
  ];
  const deliveredAll = requiredTargets.every(t => deliveredMax.has(t));
  return { configured: true, deliveredAll, deliveredTargets: [...deliveredMax] };
}

const MAX_ADMIN_HELP = [
  "🤖 Управление AVTOY KOREA в MAX",
  "",
  "Команды администратора:",
  "• /adminlink — войти в веб-панель управления сайтом в 1 клик",
  "• /synctg — проверить @avtoYkorea и подтянуть новые авто без дублей",
  "• /bindgroup — (отправить внутри группы MAX) привязать группу для автосинхронизации",
  "• /news <текст> — опубликовать новость на сайт",
  "• /setmax <https://max.ru/...> — привязать ссылку на этого бота к кнопкам MAX на сайте",
  "• /site (или !site) — список опубликованных авто, новостей и отзывов",
  "• /orders (или !orders) — последние заявки клиентов (контакты видны только в личке)",
  "• !status <номер_или_id> — проверить статус заявки",
  "• !unpublish <id> — снять авто, новость или отзыв с сайта",
  "• /clean — очистить дубли фото и перенести рыночные посты в «Новости»",
  "• /replymax <user_id> <текст> — ответить клиенту в MAX",
  "• /myid — показать ваш MAX User ID",
  "• /help (или !help) — эта справка"
].join("\n");

export async function handleMaxBotWebhook(request, env, helpers = {}) {
  const { callTelegram, telegramAdminIds = [], unpublishById, issueAdminMagicLink, cleanupCatalog, ingestMaxCarPost, syncTelegramChannel, fetchImpl = fetch } = helpers;
  const expectedSecret = String(env.MAX_WEBHOOK_SECRET || "").trim();
  const suppliedSecret = request.headers.get("x-max-bot-api-secret") || "";
  if (!expectedSecret || !safeSecretEqual(suppliedSecret, expectedSecret)) {
    return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
  if (!String(env.MAX_BOT_TOKEN || "").trim()) {
    return new Response(JSON.stringify({ ok: false, error: "MAX_BOT_TOKEN is not configured" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  let update;
  try {
    const raw = await request.text();
    if (raw.length > 65536) {
      return new Response(JSON.stringify({ ok: false, error: "Payload too large" }), { status: 413 });
    }
    update = JSON.parse(raw);
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "Bad JSON" }), { status: 400 });
  }

  const updateType = String(update?.update_type || "");
  if (updateType === "bot_started") {
    const userId = String(update?.user?.user_id || "");
    if (/^\d+$/.test(userId)) {
      await callMaxApi(
        env,
        `user_id=${encodeURIComponent(userId)}`,
        "Здравствуйте! Это AVTOY KOREA 🚘\n\nПомогаем с подбором и доставкой автомобилей из Кореи, Китая и ОАЭ.\nНапишите, какой автомобиль и в какой бюджет вы ищете — менеджер ответит вам здесь!",
        fetchImpl
      );
    }
    return Response.json({ ok: true });
  }

  if (updateType !== "message_created") {
    return Response.json({ ok: true, ignored: true });
  }

  const message = update?.message;
  if (!message || message?.sender?.is_bot === true) {
    return Response.json({ ok: true, ignored: true });
  }

  const senderId = String(message?.sender?.user_id ?? "").trim();
  const senderName = cleanLine(message?.sender?.name || message?.sender?.username || "Клиент", 120);
  const recipient = message?.recipient || {};
  const chatType = String(recipient.chat_type || "");
  const chatId = String(recipient.chat_id ?? "").trim();
  const text = cleanLine(message?.body?.text || "", 3500);

  const maxAdmins = getMaxAdminIds(env);
  const isMaxAdmin = /^\d+$/.test(senderId) && maxAdmins.includes(senderId);
  const configuredGroupChat = String(env.MAX_OPERATOR_CHAT_ID || "").trim();
  const kvPublicGroup = env.REVIEWS
    ? String((await env.REVIEWS.get("site_config:max_public_group_id").catch(() => "")) || "").trim()
    : "";
  const publicGroupChat = kvPublicGroup || String(env.MAX_PUBLIC_GROUP_ID || "").trim();
  const imageUrls = extractMaxImageUrls(message);

  const replyToDialog = bodyText =>
    chatId
      ? callMaxApi(env, `chat_id=${encodeURIComponent(chatId)}`, bodyText, fetchImpl)
      : callMaxApi(env, `user_id=${encodeURIComponent(senderId)}`, bodyText, fetchImpl);

  // 1. Group chat handling: operator group OR bound public group; strictly allowlisted admins, zero PII.
  if (chatType === "chat") {
    if (isMaxAdmin && /^[!/]bindgroup$/i.test(text) && env.REVIEWS && /^-?\d{1,24}$/.test(chatId) && chatId !== "0") {
      await env.REVIEWS.put("site_config:max_public_group_id", chatId);
      await callMaxApi(env, `chat_id=${encodeURIComponent(chatId)}`, "✅ Группа MAX привязана для двусторонней синхронизации автомобилей с сайтом и @avtoYkorea!", fetchImpl);
      return Response.json({ ok: true, command: "bindgroup", chatId });
    }

    const isPublicGroup = Boolean(publicGroupChat && chatId === publicGroupChat);
    const isOperatorGroup = Boolean(configuredGroupChat && chatId === configuredGroupChat);
    if (!isPublicGroup && (!isOperatorGroup || !isMaxAdmin)) {
      return Response.json({ ok: false, error: "Forbidden group or sender" }, { status: 403 });
    }
    if (!isMaxAdmin) {
      // Customers chatting in the bound public group must be ignored silently without leaking errors or forwarding group spam.
      return Response.json({ ok: true, ignored: true });
    }
    if (imageUrls.length > 0 && isCarListingPost({ text, hasMedia: true }) && typeof ingestMaxCarPost === "function") {
      const carSync = await ingestMaxCarPost({
        messageId: String(message?.body?.mid || message?.mid || Date.now()),
        chatId,
        senderId,
        text,
        imageUrls,
        fetchImpl
      });
      return Response.json({ ok: true, carSync });
    }
    if (/^[!/]help$/i.test(text)) {
      await callMaxApi(env, `chat_id=${encodeURIComponent(chatId)}`, "Команды группы AVTOY KOREA: !help — справка; !site — статистика каталога; !status <ID> — статус заявки. Контакты клиентов доступны только в личном чате с ботом.", fetchImpl);
      return Response.json({ ok: true, command: "help" });
    }
    if (/^[!/]site$/i.test(text) && env.REVIEWS) {
      const cars = await env.REVIEWS.list({ prefix: "car_approved:" });
      const reviews = await env.REVIEWS.list({ prefix: "approved:" });
      await callMaxApi(env, `chat_id=${encodeURIComponent(chatId)}`, `🌐 На сайте AVTOY KOREA опубликовано:\n🚘 Автомобилей: ${cars.keys.length}\n⭐ Отзывов: ${reviews.keys.length}`, fetchImpl);
      return Response.json({ ok: true, command: "site" });
    }
    const statusMatch = text.match(/^[!/]status\s+([A-Za-z0-9_-]{6,64})$/i);
    if (statusMatch && env.REVIEWS) {
      const keyId = statusMatch[1];
      const raw = (await env.REVIEWS.get(`order:${keyId}`)) || (await env.REVIEWS.get(`order_no:${keyId}`));
      if (!raw) {
        await callMaxApi(env, `chat_id=${encodeURIComponent(chatId)}`, "Заявка не найдена.", fetchImpl);
      } else {
        const ord = JSON.parse(raw);
        await callMaxApi(env, `chat_id=${encodeURIComponent(chatId)}`, `Заявка №${ord.number || ord.id}: статус «${ord.status || "new"}», модель: ${ord.model || "не указана"}. Контакты доступны в личном диалоге с ботом.`, fetchImpl);
      }
      return Response.json({ ok: true, command: "status" });
    }
    return Response.json({ ok: true, ignored: true });
  }

  // 2. Private dialog handling
  if (chatType !== "dialog") {
    return Response.json({ ok: true, ignored: true });
  }

  if (/^[!/]myid$/i.test(text)) {
    await replyToDialog(`Ваш MAX User ID: ${senderId}\nChat ID диалога: ${chatId || "—"}\nУкажите MAX User ID в переменной MAX_ADMIN_IDS.`);
    return Response.json({ ok: true, command: "myid" });
  }

  if (isMaxAdmin) {
    if (/^[!/](help|admin|start)$/i.test(text)) {
      await replyToDialog(MAX_ADMIN_HELP);
      return Response.json({ ok: true, command: "help" });
    }

    if (/^[!/]adminlink$/i.test(text) && typeof issueAdminMagicLink === "function") {
      const linkInfo = await issueAdminMagicLink();
      await replyToDialog(
        `🔐 Вход в Центр управления AVTOY KOREA:\n${linkInfo.magicUrl}\n\nКод для ручного ввода: ${linkInfo.code}\n(действует 5 минут, одноразовый)`
      );
      return Response.json({ ok: true, command: "adminlink" });
    }

    if (/^[!/]clean$/i.test(text) && typeof cleanupCatalog === "function") {
      const res = await cleanupCatalog();
      await replyToDialog(`✨ Автоочистка выполнена!\nОбновлено авто: ${res.cleanedCars}\nПеренесено в Новости: ${res.movedToNews || 0}\nСнято битых: ${res.removedBroken}`);
      return Response.json({ ok: true, command: "clean" });
    }

    const setMaxMatch = text.match(/^[!/]setmax\s+(\S+)$/i);
    if (setMaxMatch && env.REVIEWS) {
      const rawUrl = setMaxMatch[1].trim();
      if (!/^https:\/\/max\.ru\/[A-Za-z0-9_./?=-]+$/.test(rawUrl)) {
        await replyToDialog("❌ Укажите ссылку вида https://max.ru/ваш_бот");
        return Response.json({ ok: false, error: "invalid_max_url" });
      }
      await env.REVIEWS.put("site_config:max_bot_url", rawUrl);
      await replyToDialog(`✅ Все кнопки «Бот в MAX» на сайте теперь открывают:\n${rawUrl}`);
      return Response.json({ ok: true, command: "setmax", maxBotUrl: rawUrl });
    }

    const newsCmdMatch = text.match(/^[!/]news\s+([\s\S]+)$/i);
    if (newsCmdMatch && env.REVIEWS) {
      const newsId = `news_${senderId}_${Date.now()}`;
      const newsRec = {
        id: newsId,
        category: "news",
        kind: "text",
        text: newsCmdMatch[1].trim().slice(0, 3000),
        photos: [],
        videos: [],
        publishedAt: new Date().toISOString()
      };
      await env.REVIEWS.put("news_approved:" + newsId, JSON.stringify(newsRec));
      await replyToDialog(`📰 Новость опубликована на сайт!\nID: ${newsId}\nЧтобы снять: !unpublish ${newsId}`);
      return Response.json({ ok: true, command: "news", id: newsId });
    }

    if (/^[!/]site$/i.test(text) && env.REVIEWS) {
      const carsPage = await env.REVIEWS.list({ prefix: "car_approved:" });
      const newsPage = await env.REVIEWS.list({ prefix: "news_approved:" });
      const revPage = await env.REVIEWS.list({ prefix: "approved:" });
      const lines = [
        `🌐 Каталог AVTOY KOREA`,
        `🚘 Авто: ${carsPage.keys.length} · 📰 Новостей: ${newsPage.keys.length} · ⭐ Отзывов: ${revPage.keys.length}`,
        ""
      ];
      for (const k of carsPage.keys.slice(0, 15)) {
        const raw = await env.REVIEWS.get(k.name);
        if (!raw) continue;
        const c = JSON.parse(raw);
        const title = String(c.caption || "").split("\n").find(Boolean) || "Без названия";
        lines.push(`• ${c.id}: ${title.slice(0, 55)}`);
      }
      if (carsPage.keys.length > 15) lines.push(`…и ещё ${carsPage.keys.length - 15} авто`);
      lines.push("", "Чтобы снять публикацию: !unpublish <id>");
      await replyToDialog(lines.join("\n"));
      return Response.json({ ok: true, command: "site" });
    }

    if (/^[!/]orders$/i.test(text) && env.REVIEWS) {
      const ordPage = await env.REVIEWS.list({ prefix: "order:" });
      const orders = [];
      for (const k of ordPage.keys) {
        const raw = await env.REVIEWS.get(k.name);
        if (raw) orders.push(JSON.parse(raw));
      }
      orders.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
      if (!orders.length) {
        await replyToDialog("Заявок пока нет.");
      } else {
        const lines = ["📋 Последние заявки с сайта:", ""];
        for (const o of orders.slice(0, 10)) {
          lines.push(`№${o.number || o.id} [${o.status || "new"}] — ${o.name || "—"}, ${o.contact || "—"} (${o.model || "подбор"}, ${o.budget || "бюджет не указан"})`);
        }
        await replyToDialog(lines.join("\n"));
      }
      return Response.json({ ok: true, command: "orders" });
    }

    const statusMatch = text.match(/^[!/]status\s+([A-Za-z0-9_-]{6,64})$/i);
    if (statusMatch && env.REVIEWS) {
      const keyId = statusMatch[1];
      const raw = (await env.REVIEWS.get(`order:${keyId}`)) || (await env.REVIEWS.get(`order_no:${keyId}`));
      if (!raw) {
        await replyToDialog("Заявка не найдена.");
      } else {
        const o = JSON.parse(raw);
        await replyToDialog([
          `📋 Заявка №${o.number || o.id}`,
          `Статус: ${o.status || "new"}`,
          `Имя: ${o.name}`,
          `Контакт: ${o.contact}`,
          `Модель: ${o.model || "не указана"}`,
          `Бюджет: ${o.budget || "не указан"}`,
          `Страна: ${o.country || "не указана"}`,
          `Пожелания: ${o.details || "нет"}`
        ].join("\n"));
      }
      return Response.json({ ok: true, command: "status" });
    }

    const unpubMatch = text.match(/^[!/]unpublish\s+((?:car_|news_)?-?\d+_\d+)$/i);
    if (unpubMatch && typeof unpublishById === "function") {
      const targetId = unpubMatch[1];
      const ok = await unpublishById(targetId);
      await replyToDialog(ok ? `✅ Публикация ${targetId} снята с сайта.` : `Публикация ${targetId} не найдена на сайте.`);
      return Response.json({ ok: true, command: "unpublish", removed: Boolean(ok) });
    }

    const replyMatch = text.match(/^[!/]replymax\s+(\d{1,24})\s+([\s\S]+)$/i);
    if (replyMatch) {
      const res = await callMaxApi(env, `user_id=${encodeURIComponent(replyMatch[1])}`, replyMatch[2], fetchImpl);
      await replyToDialog(res.ok ? "✅ Ответ отправлен клиенту в MAX." : "❌ Не удалось отправить сообщение клиенту.");
      return Response.json({ ok: true, command: "replymax" });
    }

    if (/^[!/]synctg$/i.test(text) && typeof syncTelegramChannel === "function") {
      const res = await syncTelegramChannel();
      await replyToDialog(
        res?.ok
          ? `🔄 Синхронизация @avtoYkorea завершена.\n🚘 Новых авто: ${res.importedCars || 0}\n⏭ Дублей пропущено: ${res.skippedDuplicates || 0}`
          : "❌ Не удалось прочитать @avtoYkorea."
      );
      return Response.json({ ok: true, command: "synctg", result: res });
    }

    if (!/^[!/]/.test(text) && imageUrls.length > 0 && isCarListingPost({ text, hasMedia: true }) && typeof ingestMaxCarPost === "function") {
      const carSync = await ingestMaxCarPost({
        messageId: String(message?.body?.mid || message?.mid || Date.now()),
        chatId: chatId || senderId,
        senderId,
        text,
        imageUrls,
        fetchImpl
      });
      if (carSync?.skippedDuplicate) {
        await replyToDialog(`⏭ Такой автомобиль уже есть на сайте (${carSync.existingId}) — дубль пропущен.`);
      } else if (carSync?.ok) {
        await replyToDialog(
          `✅ Автомобиль опубликован на сайте (${carSync.id})` +
          (carSync.telegramCrossposted ? " и отправлен в @avtoYkorea!" : "!")
        );
      } else {
        await replyToDialog("⚠️ Не удалось сохранить автомобиль.");
      }
      return Response.json({ ok: true, carSync });
    }

    await replyToDialog("Команда не распознана. Отправьте /help для списка команд администратора.");
    return Response.json({ ok: true });
  }

  // 3. Regular customer writing to the MAX bot
  if (/^[!/]start/i.test(text)) {
    await replyToDialog("Здравствуйте! Это AVTOY KOREA 🚘\n\nПодбираем и доставляем автомобили из Южной Кореи, Китая и ОАЭ.\nНапишите марку/модель, бюджет и ваш телефон — передадим запрос менеджеру!");
    return Response.json({ ok: true });
  }

  if (text) {
    const notice = [
      "📩 Сообщение клиентом в бот MAX (AVTOY KOREA)",
      `От: ${senderName}`,
      `MAX User ID: ${senderId}`,
      "",
      text,
      "",
      `Ответить в MAX: /replymax ${senderId} текст`
    ].join("\n");

    await Promise.all([
      ...maxAdmins.map(id => callMaxApi(env, `user_id=${encodeURIComponent(id)}`, notice, fetchImpl)),
      ...(typeof callTelegram === "function"
        ? telegramAdminIds.map(id => callTelegram(env, "sendMessage", { chat_id: id, text: notice }).catch(() => null))
        : [])
    ]);

    await replyToDialog("Спасибо! Ваше обращение передано менеджеру AVTOY KOREA. Мы скоро ответим вам.");
  }

  return Response.json({ ok: true });
}

export function resolveMirrorCorsHeaders(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  const configured = String(env.ALLOWED_MIRROR_ORIGINS || "")
    .split(/[\s,]+/)
    .map(s => s.trim())
    .filter(Boolean);
  let allowed = false;
  try {
    const parsed = new URL(origin);
    if (configured.includes("*") || configured.includes(origin)) {
      allowed = true;
    } else if (
      parsed.protocol === "https:" &&
      (parsed.hostname.endsWith(".gitverse.ru") ||
        parsed.hostname.endsWith(".gitverse.site") ||
        parsed.hostname === "gitverse.ru" ||
        parsed.hostname.endsWith(".github.io") ||
        parsed.hostname.endsWith(".yandexcloud.net") ||
        parsed.hostname.endsWith(".avtoykorea.ru"))
    ) {
      allowed = true;
    } else if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      allowed = true;
    }
  } catch {
    allowed = false;
  }
  if (!allowed) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, accept, idempotency-key",
    "access-control-max-age": "86400",
    vary: "Origin"
  };
}
