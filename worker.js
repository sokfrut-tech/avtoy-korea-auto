import { mergeOrderedMediaItems, orderedMediaFromRecord } from "./media-order.js";
import { MAX_TELEGRAM_BOT_VIDEO_BYTES, deliverOrderToMax, handleMaxBotWebhook, resolveMirrorCorsHeaders } from "./max-worker-bridge.js";
import { cleanCarDisplayCaption, isMarketNewsRecord } from "./catalog-formatter.js";
import { ADMIN_PRO_CSP, ADMIN_PRO_HTML, enrichAdminItem, runAdminCatalogCleanup, sendOrEditTelegramPanel } from "./admin-suite.js";
import { buildHomepageJsonLd, buildRobotsTxt, buildSitemapXml, buildYandexMarketYml, renderCarLandingHtml, renderFaqAndDirectoryHtml, renderNewsLandingHtml, renderServerCatalogPreviewHtml } from "./seo-engine.js";

async function beginModerationEdit(callback, env, type, id, answer) {
 const adminId = String((callback.from && callback.from.id) || "");
 if (!env.REVIEWS) return answer("Хранилище не настроено", true);
 const isCar = type === "car";
 const key = (isCar ? "car_pending:" : "pending:") + id;
 const raw = await env.REVIEWS.get(key);
 if (!raw) return answer("Материал уже обработан или не найден", true);
 const item = JSON.parse(raw);
 const currentText = String(isCar ? item.caption || "" : item.text || "");
 const session = { type, id, createdAt: new Date().toISOString() };
 await env.REVIEWS.put("moderation_edit:" + adminId, JSON.stringify(session), { expirationTtl: 86400 });
 const label = isCar ? "описание автомобиля" : "текст отзыва";
 const photoCount = Array.isArray(item.photos) ? item.photos.length : 0;
 const photoHint = photoCount ? "\n\nФото: " + Array.from({ length: photoCount }, (_, i) => i + 1).join(" ") + "\n• УДАЛИТЬ ФОТО: номера через пробел, например УДАЛИТЬ ФОТО 2 4" : "";
 const instructions = "Текущий текст ниже. Чтобы не переписывать всё, ответьте одной командой:\n" +
  "• ЗАМЕНИТЬ: старый фрагмент => новый фрагмент\n" +
  "• УДАЛИТЬ: ненужный фрагмент\n" +
  "• ДОБАВИТЬ В КОНЕЦ: новый текст\n" +
  "Или отправьте полный исправленный текст, если хотите заменить всё. Команда должна быть ответом на это сообщение.";
 await callTelegram(env, "sendMessage", {
  chat_id: adminId,
  text: "✏️ РЕДАКТИРОВАНИЕ " + label.toUpperCase() + "\n\n" + instructions + photoHint + "\n\nТЕКУЩИЙ ТЕКСТ:\n" + (currentText || "— пусто —").slice(0, 3000),
  reply_markup: { force_reply: true, input_field_placeholder: "Команда правки или новый текст" }
 });
 return answer("Текущий текст показан. Можно изменить только нужный фрагмент");
}

function applyModerationTextEdit(currentText, instruction) {
 const current = String(currentText || "");
 const input = String(instruction || "").trim();
 let match = input.match(/^ЗАМЕНИТЬ\s*:\s*([\s\S]+?)\s*=>\s*([\s\S]*)$/i);
 if (match) {
  if (!current.includes(match[1])) return { error: "Не нашёл указанный фрагмент. Текст не изменён; проверьте точное совпадение." };
  return { text: current.replace(match[1], match[2]).trim() };
 }
 match = input.match(/^УДАЛИТЬ\s*:\s*([\s\S]+)$/i);
 if (match) {
  if (!current.includes(match[1])) return { error: "Не нашёл указанный фрагмент. Текст не изменён; проверьте точное совпадение." };
  return { text: current.replace(match[1], "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() };
 }
 match = input.match(/^ДОБАВИТЬ\s+В\s+КОНЕЦ\s*:\s*([\s\S]+)$/i);
 if (match) return { text: [current, match[1].trim()].filter(Boolean).join("\n\n") };
 match = input.match(/^ДОБАВИТЬ\s+В\s+НАЧАЛО\s*:\s*([\s\S]+)$/i);
 if (match) return { text: [match[1].trim(), current].filter(Boolean).join("\n\n") };
 return { text: input };
}

// --- Фото в редактировании и снятие материала с сайта ---
function parsePhotoNumbers(raw, count) {
 const numbers = [...new Set(String(raw).split(/[\s,]+/).filter(Boolean).map(Number))];
 if (!numbers.length || numbers.some(n => !Number.isInteger(n) || n < 1 || n > count)) return null;
 return numbers.sort((a, b) => a - b);
}

function removePhotosAt(item, numbers) {
 const photos = Array.isArray(item.photos) ? item.photos : [];
 const remaining = photos.filter((_, index) => !numbers.includes(index + 1));
 item.photos = remaining;
 if (Array.isArray(item.mediaItems)) {
  const keep = new Set(remaining.map(photo => String(photo.file_unique_id || photo.file_id || "")));
  item.mediaItems = item.mediaItems.filter(media => media.type === "video" || keep.has(String(media.file_unique_id || media.file_id || "")));
 }
 item.fileId = remaining.length ? remaining[remaining.length - 1].file_id : (Array.isArray(item.videos) && item.videos.length ? item.videos[0].file_id : null);
 return item;
}

async function requestPhotoDelete(session, adminId, rawNumbers, env) {
 const key = (session.type === "car" ? "car_pending:" : "pending:") + session.id;
 const raw = await env.REVIEWS.get(key);
 if (!raw) {
  await env.REVIEWS.delete("moderation_edit:" + adminId);
  return callTelegram(env, "sendMessage", { chat_id: adminId, text: "Материал уже обработан или не найден. Изменения не сохранены." });
 }
 const item = JSON.parse(raw);
 const count = Array.isArray(item.photos) ? item.photos.length : 0;
 const numbers = parsePhotoNumbers(rawNumbers, count);
 if (!numbers) {
  return callTelegram(env, "sendMessage", { chat_id: adminId, text: count ? "Укажите номера фото от 1 до " + count + ", например: УДАЛИТЬ ФОТО 2 4" : "В этом материале нет фото для удаления." });
 }
 session.photoDelete = numbers;
 await env.REVIEWS.put("moderation_edit:" + adminId, JSON.stringify(session), { expirationTtl: 86400 });
 return callTelegram(env, "sendMessage", {
  chat_id: adminId,
  text: "Удалить фото " + numbers.join(", ") + "? Останется фото: " + (count - numbers.length) + ".",
  reply_markup: { inline_keyboard: [[{ text: "✅ Да, удалить", callback_data: "mphoto:yes" }, { text: "❌ Нет", callback_data: "mphoto:no" }]] }
 });
}

async function handlePhotoDeleteCallback(callback, env, adminIds) {
 const answer = (text, alert = false) => callTelegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: alert });
 const adminId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(adminId) || !env.REVIEWS) return answer("Нет доступа", true);
 const rawSession = await env.REVIEWS.get("moderation_edit:" + adminId);
 const session = rawSession ? JSON.parse(rawSession) : null;
 if (!session || !Array.isArray(session.photoDelete)) return answer("Удаление фото не ожидает подтверждения", true);
 const numbers = session.photoDelete;
 delete session.photoDelete;
 await env.REVIEWS.put("moderation_edit:" + adminId, JSON.stringify(session), { expirationTtl: 86400 });
 if (callback.data === "mphoto:no") return answer("Фото не удалены");
 const key = (session.type === "car" ? "car_pending:" : "pending:") + session.id;
 const raw = await env.REVIEWS.get(key);
 if (!raw) { await env.REVIEWS.delete("moderation_edit:" + adminId); return answer("Материал уже обработан. Изменения не сохранены.", true); }
 const item = JSON.parse(raw);
 const count = Array.isArray(item.photos) ? item.photos.length : 0;
 if (numbers.some(n => n > count)) return answer("Список фото изменился. Повторите команду.", true);
 removePhotosAt(item, numbers);
 item.hasPhoto = item.photos.length > 0;
 if (session.type === "car") item.mediaType = item.photos.length ? "photo" : (postVideos(item).length ? "video" : "photo");
 item.photosEditedAt = new Date().toISOString();
 await env.REVIEWS.put(key, JSON.stringify(item));
 await writeLog(env, adminId, "удалено фото: " + numbers.join(", "), session.type === "car" ? "машина" : "отзыв", session.id, "");
 await callTelegram(env, "sendMessage", { chat_id: adminId, text: "Фото удалены. Осталось: " + item.photos.length + (item.photos.length ? " (номера 1–" + item.photos.length + ")" : "") + ".\nКогда всё готово, нажмите «✅ Опубликовать» на карточке модерации." });
 return answer("Фото удалены");
}

function siteLabel(id, record) {
 if (id.startsWith("car_")) {
  const firstLine = String(record.caption || "").split("\n").find(line => line.trim()) || "Без описания";
  return "Автомобиль: " + firstLine.trim().slice(0, 60);
 }
 if (id.startsWith("news_")) {
  const firstLine = String(record.text || record.caption || "").split("\n").find(line => line.trim()) || "Без заголовка";
  return "Новость: " + firstLine.trim().slice(0, 60);
 }
 const text = String(record.text || "").trim();
 return "Отзыв: " + (text ? "«" + text.slice(0, 50) + "»" : "видео без текста");
}

// Подсказка для администраторов: открывается из меню команд (слева внизу) и кнопкой под списком /site.
const ADMIN_HELP_TEXT = [
 "❓ Подсказка администратора",
 "",
 "Сайт:",
 "/site — список опубликованных автомобилей и отзывов.",
 "/adminlink — получить одноразовый код для входа в панель сайта.",
 "✏️ Изменить текст — нажмите у нужной публикации; ответьте командой ЗАМЕНИТЬ или УДАЛИТЬ.",
 "🗑 Снять с сайта — нажмите у нужной публикации и подтвердите действие.",
 "/log — журнал действий, последние 20.",
 "↩️ Отменить — 2 минуты после публикации или снятия.",
 "",
 "Карточка на модерации:",
 "✅ Опубликовать — выложить на сайт",
 "❌ Не публиковать — убрать из очереди",
 "🙈 Скрыть имя — только для отзывов",
 "✏️ Редактировать — правка текста",
 "📎 Для исходного качества отправляйте фото как ФАЙЛ/ДОКУМЕНТ, не как обычное фото.",
 "",
 "Правка текста (ответом на сообщение бота):",
 "ЗАМЕНИТЬ: старое => новое",
 "УДАЛИТЬ: фрагмент",
 "ДОБАВИТЬ В КОНЕЦ: текст",
 "УДАЛИТЬ ФОТО 2 4 — убрать фото по номерам",
 "",
 "Ответить клиенту:",
 "/reply <chat_id> текст"
].join("\n");

async function sendAdminHelp(env, chatId) {
 await callTelegram(env, "sendMessage", {
  chat_id: chatId,
  text: ADMIN_HELP_TEXT + "\n\n🎛 Новое: /panel — компактный Центр управления в одном сообщении (без спама в чате).",
  reply_markup: { inline_keyboard: [
  [{ text: "🎛 Панель управления", callback_data: "panel:home" }, { text: "🌐 Что на сайте", callback_data: "admincmd:site" }],
  [{ text: "🔐 Открыть панель сайта", url: "https://avtoy-korea-auto.sokfrut.workers.dev/admin" }]
 ] }
 });
}

async function setAdminCommands(env, adminId) {
 await callTelegram(env, "setMyCommands", {
  commands: [
   { command: "panel", description: "Центр управления (авто, новости, отзывы, заявки)" },
   { command: "news", description: "Опубликовать новость: /news текст" },
   { command: "setmax", description: "Указать ссылку на бота MAX: /setmax https://max.ru/..." },
   { command: "setyandex", description: "Подтвердить Яндекс Вебмастер: /setyandex код" },
   { command: "adminlink", description: "Вход в веб-панель в 1 клик" },
   { command: "admin", description: "Меню и подсказка администратора" },
   { command: "site", description: "Полный список карточек с фото" },
   { command: "log", description: "Журнал действий администраторов" },
   { command: "reply", description: "Ответить клиенту: /reply <chat_id> текст" }
  ],
  scope: { type: "chat", chat_id: Number(adminId) }
 });
}

async function showSiteList(chatId, env) {
 if (!env.REVIEWS) return callTelegram(env, "sendMessage", { chat_id: chatId, text: "Хранилище не настроено." });
 const cars = await env.REVIEWS.list({ prefix: "car_approved:" });
 const news = await env.REVIEWS.list({ prefix: "news_approved:" });
 const reviews = await env.REVIEWS.list({ prefix: "approved:" });
 const entries = [
  ...cars.keys.map(key => ({ key, type: "car" })),
  ...news.keys.map(key => ({ key, type: "news" })),
  ...reviews.keys.map(key => ({ key, type: "review" }))
 ];
 const items = [];
 for (const entry of entries) {
  const raw = await env.REVIEWS.get(entry.key.name);
  if (!raw) continue;
  const id = entry.key.name.replace(/^(car_approved|news_approved|approved):/, "");
  const record = JSON.parse(raw);
  const photos = entry.type === "car" ? postPhotos(record) : uniqueFileItems(Array.isArray(record.photos) && record.photos.length ? record.photos : (record.fileId && record.kind !== "video" ? [{ file_id: record.fileId }] : []));
  const videos = entry.type === "car" ? postVideos(record) : uniqueFileItems(Array.isArray(record.videos) && record.videos.length ? record.videos : (record.kind === "video" && record.fileId ? [{ file_id: record.fileId }] : []));
  items.push({ id, record, photos, videos, label: siteLabel(id, record), type: entry.type });
 }
 if (!items.length) return callTelegram(env, "sendMessage", { chat_id: chatId, text: "На сайте сейчас ничего не опубликовано." });
 const carsCount = items.filter(item => item.type === "car").length;
 const newsCount = items.filter(item => item.type === "news").length;
 const reviewsCount = items.length - carsCount - newsCount;
 await callTelegram(env, "sendMessage", {
  chat_id: chatId,
  text: "🌐 УПРАВЛЕНИЕ ПУБЛИКАЦИЯМИ\n\n🚘 Автомобилей: " + carsCount + "\n📰 Новостей: " + newsCount + "\n⭐ Отзывов: " + reviewsCount + "\n\nНиже — отдельные карточки. Фото, название и кнопки относятся только к одной публикации."
 });
 for (let index = 0; index < items.length; index++) {
  const item = items[index];
  const title = (item.type === "car" ? "🚘 АВТОМОБИЛЬ" : (item.type === "news" ? "📰 НОВОСТЬ" : "⭐ ОТЗЫВ")) + " · " + (index + 1) + "/" + items.length;
  const details = title + "\n" + item.label + "\n\nФото: " + item.photos.length + " · Видео: " + item.videos.length;
  const keyboard = { inline_keyboard: [[
   { text: "✏️ Изменить описание", callback_data: "siteedit:" + item.id },
   { text: "🗑 Снять с сайта", callback_data: "sitedel:" + item.id }
  ]] };
  const cover = item.photos[0];
  if (cover && cover.file_id) {
   await callTelegram(env, "sendPhoto", {
    chat_id: chatId, photo: cover.file_id, caption: details.slice(0, 1024), reply_markup: keyboard
   });
   const rest = item.photos.slice(1);
   for (let offset = 0; offset < rest.length; offset += 10) {
    const chunk = rest.slice(offset, offset + 10);
    if (chunk.length > 1) await callTelegram(env, "sendMediaGroup", {
     chat_id: chatId,
     media: chunk.map(photo => ({ type: "photo", media: photo.file_id }))
    });
    else if (chunk.length === 1) await callTelegram(env, "sendPhoto", { chat_id: chatId, photo: chunk[0].file_id, caption: "Дополнительное фото · " + (offset + 2) });
   }
  } else {
   await callTelegram(env, "sendMessage", { chat_id: chatId, text: details + (item.videos.length ? "\nВидео приложено" : "\n⚠️ Нет фотографии"), reply_markup: keyboard });
  }
 }
 return callTelegram(env, "sendMessage", { chat_id: chatId, text: "Готово. Нажимайте кнопки только под карточкой нужного автомобиля, новости или отзыва.", reply_markup: { inline_keyboard: [[{ text: "❓ Подсказка администратора", callback_data: "adminhelp" }]] } });
}

async function sendPendingCarCard(env, adminIds, car, id, lead) {
 const keyboard = { inline_keyboard: [[{ text: "✅ Опубликовать", callback_data: "carpub:" + id }, { text: "❌ Отклонить", callback_data: "carrej:" + id }], [{ text: "✏️ Редактировать описание", callback_data: "caredit:" + id }]] };
 const videos = postVideos(car);
 const oversizedVideo = videos.some(v => Number(v && v.file_size) > MAX_TELEGRAM_BOT_VIDEO_BYTES);
 const videoWarn = oversizedVideo ? "\n\n⚠️ Внимание: видео превышает лимит Telegram Bot API (20 МБ) и не сможет открываться на сайте (ошибка 404). Сожмите видео до 20 МБ перед публикацией." : "";
 await Promise.all(adminIds.map(async adminId => {
  await sendChannelMedia(env, adminId, postPhotos(car), videos, car.caption || "", car.mediaOrderKnown === true ? car.mediaItems : null);
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: lead + "\n\n" + (car.caption || "Описание отсутствует") + "\n\nИсточник: " + (car.sourceUrl || "не указан") + videoWarn, reply_markup: keyboard });
 }));
}

async function handleSiteDeleteCallback(callback, env, adminIds) {
 const answer = (text, alert = false) => callTelegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: alert });
 const fromId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(fromId)) return answer("Нет доступа", true);
 const chat = callback.message && callback.message.chat;
 const messageId = callback.message && callback.message.message_id;
 const data = String(callback.data || "");
 if (data === "sitedelno") {
  if (chat && messageId) await callTelegram(env, "deleteMessage", { chat_id: chat.id, message_id: messageId });
  return answer("Отменено");
 }
 const match = data.match(/^sitedel(ok)?:(car_-?\d+_\d+|news_[A-Za-z0-9_-]+|-?\d+_\d+)$/);
 if (!match || !env.REVIEWS) return answer("Материал не найден", true);
 const confirmed = Boolean(match[1]), id = match[2];
 const prefix = id.startsWith("car_") ? "car_approved:" : (id.startsWith("news_") ? "news_approved:" : "approved:");
 const raw = await env.REVIEWS.get(prefix + id);
 if (!raw) return answer("Уже не опубликовано на сайте", true);
 const record = JSON.parse(raw);
 if (!confirmed) {
  await callTelegram(env, "sendMessage", {
   chat_id: fromId,
   text: "Убрать с сайта?\n\n" + siteLabel(id, record) + "\n\nМатериал вернётся в «ожидает решения». Его можно будет опубликовать снова.",
   reply_markup: { inline_keyboard: [[{ text: "✅ Да, убрать", callback_data: "sitedelok:" + id }, { text: "❌ Нет", callback_data: "sitedelno" }]] }
  });
  return answer("Подтвердите действие");
 }
 const removed = await unpublishItem(env, adminIds, id);
 if (!removed) return answer("Уже не опубликовано на сайте", true);
 await writeLog(env, fromId, "снят с сайта", id.startsWith("car_") ? "машина" : (id.startsWith("news_") ? "новость" : "отзыв"), id, siteLabel(id, record));
 await offerUndo(env, fromId, id, { action: "restore", record }, "↩️ Снято с сайта. Материал в ожидании модерации.");
 if (chat && messageId) await callTelegram(env, "deleteMessage", { chat_id: chat.id, message_id: messageId });
 return answer("Снято с сайта. Материал вернулся в ожидание");
}

async function handleSiteEditCallback(callback, env, adminIds) {
 const answer = (text, alert = false) => callTelegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: alert });
 const adminId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(adminId) || !env.REVIEWS) return answer("Нет доступа", true);
 const match = String(callback.data || "").match(/^siteedit:(car_-?\d+_\d+|news_[A-Za-z0-9_-]+|-?\d+_\d+)$/);
 if (!match) return answer("Материал не найден", true);
 const id = match[1];
 const isCar = id.startsWith("car_");
 const isNews = id.startsWith("news_");
 const key = (isCar ? "car_approved:" : (isNews ? "news_approved:" : "approved:")) + id;
 const raw = await env.REVIEWS.get(key);
 if (!raw) return answer("Публикация уже снята с сайта", true);
 const record = JSON.parse(raw);
 const session = { type: isCar ? "car_site" : (isNews ? "news_site" : "review_site"), id, createdAt: new Date().toISOString() };
 await env.REVIEWS.put("moderation_edit:" + adminId, JSON.stringify(session), { expirationTtl: 86400 });
 const label = isCar ? "АВТОМОБИЛЯ" : (isNews ? "НОВОСТИ" : "ОТЗЫВА");
 const currentText = String(isCar ? record.caption || "" : record.text || record.caption || "");
 const instructions = "Текущий опубликованный текст ниже. Ответьте на это сообщение одной командой:\n" +
  "• ЗАМЕНИТЬ: старый фрагмент => новый фрагмент\n" +
  "• УДАЛИТЬ: ненужный фрагмент\n" +
  "• ДОБАВИТЬ В КОНЕЦ: новый текст\n" +
  "Или отправьте полный исправленный текст. Изменится только текст этой публикации; фотографии и другие объявления останутся без изменений.";
 await callTelegram(env, "sendMessage", {
  chat_id: adminId,
  text: "✏️ РЕДАКТИРОВАНИЕ ОПУБЛИКОВАННОГО " + label + "\n\n" + instructions + "\n\nТЕКУЩИЙ ТЕКСТ:\n" + (currentText || "— пусто —").slice(0, 3000),
  reply_markup: { force_reply: true, input_field_placeholder: "Команда правки или новый текст" }
 });
 return answer("Отправьте правку ответом на сообщение бота");
}

async function handleAdminModerationEditReply(msg, env, adminIds) {
 const adminId = String(msg.chat && msg.chat.id || "");
 if (!adminIds.includes(adminId) || !env.REVIEWS || !msg.reply_to_message) return false;
 const rawSession = await env.REVIEWS.get("moderation_edit:" + adminId);
 if (!rawSession) return false;
 const promptText = String(msg.reply_to_message.text || msg.reply_to_message.caption || "");
 if (!promptText.startsWith("✏️ РЕДАКТИРОВАНИЕ ")) return false;
 const session = JSON.parse(rawSession);
 if (!session || !["review", "car", "news", "car_site", "review_site", "news_site"].includes(session.type) || !session.id) return false;
 const instruction = String(msg.text || msg.caption || "").trim();
 if (!instruction) {
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: "Правка пустая. Отправьте команду изменения или полный текст ответом на сообщение редактирования." });
  return true;
 }
 const isPublished = session.type === "car_site" || session.type === "review_site" || session.type === "news_site";
 const isCar = session.type === "car" || session.type === "car_site";
 const isNews = session.type === "news" || session.type === "news_site";
 const key = isPublished
  ? (isCar ? "car_approved:" : (isNews ? "news_approved:" : "approved:")) + session.id
  : (isCar ? "car_pending:" : (isNews ? "news_pending:" : "pending:")) + session.id;
 const raw = await env.REVIEWS.get(key);
 if (!raw) {
  await env.REVIEWS.delete("moderation_edit:" + adminId);
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: "Материал уже обработан или не найден. Изменения не сохранены." });
  return true;
 }
 const item = JSON.parse(raw);
 const currentText = String(isCar ? item.caption || "" : item.text || "");
 const photoCommand = instruction.match(/^УДАЛИТЬ\s+ФОТО\s*:?\s*([\d\s,]+)$/i);
 if (photoCommand && !isPublished) { await requestPhotoDelete(session, adminId, photoCommand[1], env); return true; }
 const editResult = applyModerationTextEdit(currentText, instruction);
 if (editResult.error) {
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: editResult.error + "\n\nПопробуйте ещё раз ответом на сообщение редактирования." });
  return true;
 }
 const edited = cleanPublicationText(editResult.text);
 if (!edited) {
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: "После правки текст пустой. Материал не изменён." });
  return true;
 }
 if (isPublished) {
  if (isCar) {
   item.originalCaption = item.originalCaption === undefined ? item.caption : item.originalCaption;
   item.caption = edited.slice(0, 3000);
  } else if (isNews) {
   item.originalText = item.originalText === undefined ? item.text : item.originalText;
   item.text = cleanCarDisplayCaption(edited).slice(0, 3000);
  } else {
   item.originalText = item.originalText === undefined ? item.text : item.originalText;
   item.text = edited.slice(0, 1000);
   item.hasThanks = THANKS_PATTERN.test(item.text);
  }
  item.editedAt = new Date().toISOString();
  item.editedBy = adminId;
  await env.REVIEWS.put(key, JSON.stringify(item));
  await writeLog(env, adminId, "изменён текст опубликованного материала", isCar ? "машина" : (isNews ? "новость" : "отзыв"), session.id, siteLabel(session.id, item));
  await env.REVIEWS.delete("moderation_edit:" + adminId);
  await callTelegram(env, "sendMessage", {
   chat_id: adminId,
   text: "✅ Текст обновлён на сайте. Остальные объявления и фотографии не затронуты.\n\n" + (isCar ? item.caption : item.text).slice(0, 3000)
  });
  return true;
 }
 if (isCar) {
  item.originalCaption = item.originalCaption === undefined ? item.caption : item.originalCaption;
  item.caption = edited.slice(0, 3000);
  item.editedAt = new Date().toISOString();
  item.editedBy = adminId;
  await env.REVIEWS.put(key, JSON.stringify(item));
  const keyboard = { inline_keyboard: [
   [{ text: "✅ Опубликовать", callback_data: "carpub:" + session.id }, { text: "❌ Отклонить", callback_data: "carrej:" + session.id }],
   [{ text: "✏️ Редактировать описание", callback_data: "caredit:" + session.id }]
  ] };
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: "🚘 ОПИСАНИЕ АВТОМОБИЛЯ ОБНОВЛЕНО\n\n" + item.caption + "\n\nИсходный текст сохранён в хранилище.", reply_markup: keyboard });
 } else if (isNews) {
  item.originalText = item.originalText === undefined ? item.text : item.originalText;
  item.text = cleanCarDisplayCaption(edited).slice(0, 3000);
  item.editedAt = new Date().toISOString();
  item.editedBy = adminId;
  await env.REVIEWS.put(key, JSON.stringify(item));
  const keyboard = { inline_keyboard: [
   [{ text: "✅ Опубликовать новость", callback_data: "newspub:" + session.id }, { text: "❌ Отклонить", callback_data: "newsrej:" + session.id }],
   [{ text: "✏️ Редактировать текст", callback_data: "newsedit:" + session.id }]
  ] };
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: "📰 ТЕКСТ НОВОСТИ ОБНОВЛЁН\n\n" + item.text + "\n\nИсходный текст сохранён в хранилище.", reply_markup: keyboard });
 } else {
  item.originalText = item.originalText === undefined ? item.text : item.originalText;
  item.text = edited.slice(0, 1000);
  item.hasThanks = THANKS_PATTERN.test(item.text);
  item.editedAt = new Date().toISOString();
  item.editedBy = adminId;
  await env.REVIEWS.put(key, JSON.stringify(item));
  const keyboard = { inline_keyboard: [
   [{ text: "✅ Опубликовать", callback_data: "pub:" + session.id }, { text: "❌ Не публиковать", callback_data: "rej:" + session.id }],
   [{ text: "🙈 Скрыть имя", callback_data: "anon:" + session.id }, { text: "✏️ Редактировать текст", callback_data: "edit:" + session.id }]
  ] };
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: formatReviewCard(item) + "\n\nТекст обновлён. Исходный текст сохранён в хранилище.", reply_markup: keyboard });
 }
 await env.REVIEWS.delete("moderation_edit:" + adminId);
 return true;
}

// --- Отзывы: модерация администратором через кнопки в личке с ботом ---
const THANKS_PATTERN = /спасибо|благодар/i;

// Убираем рекламный хвост канала из описаний, оставляя полезный текст публикации.
// На сайте в описании машины не показываем контакты продавца: строки с именем и связью по контакту.
function publicCarCaption(value) {
 return cleanCarDisplayCaption(
  cleanPublicationText(value)
   .split("\n")
   .filter(line => !/^\s*(?:📲|📞|☎️?|👤|✉️?)?\s*(?:контакт|продавец|менеджер|связ|звон|позвон|тел\b|телефон|whats?app|viber|telegram|телеграм|написать|писать)/i.test(line))
   .join("\n")
   .replace(/\n{3,}/g, "\n\n")
   .trim()
 );
}

function cleanPublicationText(value) {
 return String(value || "")
  .replace(/\r/g, "")
  // Remove Telegram/channel presentation rather than reproducing a social post on the website.
  .replace(/(?:^|\n)\s*(?:Источник|Переслано от|Forwarded from|Просмотры|Комментарии|Реакции)\s*[:：]?.*$/gim, "")
  .replace(/(?:^|\n)\s*Для заказа аналогичного автомобиля обращайтесь\s*:?[^]*$/i, "")
  .replace(/(?:https?:\/\/)?t\.me\/[\w+/?=&%-]+/gi, "")
  .replace(/^\s*@[\w]{3,}\s*$/gm, "")
  .replace(/^\s*#[\p{L}\p{N}_]+(?:\s+#[\p{L}\p{N}_]+)*\s*$/gmu, "")
  .replace(/^\s*(?:🔥|❤️|❤|👍|👎|👏|💬|👁️?|📲|📞|☎️?|👤|✉️?|▶️?|🎥|📷|🚘|🚗|⭐|✨|💯|🙏|😊|😍|😁|🥰|🤝|✅|❌|⚡|💥|🎉|💪|🫶|🤩|😎|🙌|🧡|💙|💚|💛|🖤|🤍|💬|🔗|➡️?|⬇️?|⬆️?)(?:\s|\uFE0F|\u200D|\u{1F3FB}-\u{1F3FF})*$/gmu, "")
  // Remove phone numbers and contact-only lines; keep the customer's actual words.
  .replace(/(?<!\d)(?:\+?7|8)[\s().-]*\d(?:[\s().-]*\d){9}(?!\d)|(?<!\d)9(?:[\s().-]*\d){9}(?!\d)/g, "")
  .replace(/^\s*(?:тел(?:ефон)?|whats?app(?:\s*\/\s*telegram)?|telegram|телеграм|контакт|продавец|менеджер)\s*[:：]?.*$/gim, "")
  // Emojis are useful in Telegram but are not part of the AVTOY KOREA website typography.
  .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
  .replace(/^\s*Видео\s*$/gim, "")
  .replace(/^\s*[-–—|,;:·•]+\s*$/gm, "")
  .replace(/[ \t]{2,}/g, " ")
  .replace(/\n[ \t]+/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
}

async function callTelegram(env, method, payload) {
 const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload)
 });
 if (!response.ok) throw new Error("Telegram HTTP request failed");
 const result = await response.json();
 // Telegram may return HTTP 200 with { ok: false }; treat that as a failed delivery.
 if (!result || result.ok !== true) throw new Error("Telegram API rejected the request");
 return result;
}

// Правило публикации: текстовый отзыв — только с фото автомобиля; видео публикуется по решению администратора.
function reviewRuleProblem(review) {
 if (review.kind === "text" && !review.hasPhoto) return "нет фото автомобиля";
 return null;
}

function formatReviewCard(review) {
 const kindLabel = review.kind === "video" ? "видео" : "текст";
 const videos = Array.isArray(review.videos) ? review.videos : [];
 const oversized = videos.some(v => Number(v && v.file_size) > MAX_TELEGRAM_BOT_VIDEO_BYTES) || Number(review.fileSize || 0) > MAX_TELEGRAM_BOT_VIDEO_BYTES;
 const check = review.kind === "video"
  ? (oversized ? "Видео ⚠️ >20 МБ (не откроется на сайте через Telegram API — сожмите до 20 МБ)" : "Видео")
  : `Фото автомобиля: ${review.hasPhoto ? "✅ есть" : "❌ не приложено"}`;
 return ["🚘 Новый отзыв: " + kindLabel, `От: ${review.anonymous ? "скрыто" : review.name}`, `Текст: «${review.text || "без текста"}»`, check].join("\n");
}

// Бот читает только одну группу (TELEGRAM_REVIEW_GROUP_ID) и только сообщения с командой /review.

// Telegram PhotoSize contains several renditions of one image. Never rely on array
// position: choose the greatest pixel area, then file_size; preserve original order
// only as a deterministic tie-breaker for older fixtures/records without metadata.
function largestPhotoSize(photos) {
 if (!Array.isArray(photos)) return null;
 let best = null;
 let bestArea = -1;
 let bestBytes = -1;
 let bestIndex = -1;
 photos.forEach((item, index) => {
  if (!item || !item.file_id) return;
  const width = Number(item.width) || 0;
  const height = Number(item.height) || 0;
  const area = width > 0 && height > 0 ? width * height : -1;
  const bytes = Number(item.file_size) || -1;
  if (area > bestArea || (area === bestArea && bytes > bestBytes) || (area === bestArea && bytes === bestBytes && index > bestIndex)) {
   best = item;
   bestArea = area;
   bestBytes = bytes;
   bestIndex = index;
  }
 });
 return best;
}

function largestPhotoItem(photos) {
 const best = largestPhotoSize(photos);
 return best ? photoItemFrom(best) : null;
}

// Keep Telegram's stable media identity and rendition metadata in storage.
// file_id can differ for the same original image; file_unique_id identifies it.
function photoItemFrom(raw) {
 const item = { file_id: String(raw.file_id) };
 if (raw.file_unique_id) item.file_unique_id = String(raw.file_unique_id);
 for (const field of ["width", "height", "file_size"]) {
  const value = Number(raw[field]);
  if (Number.isFinite(value) && value > 0) item[field] = value;
 }
 if (typeof raw.mime_type === "string" && /^image\/(jpeg|png|webp|gif)$/i.test(raw.mime_type)) item.mime_type = raw.mime_type.toLowerCase();
 if (typeof raw.file_name === "string" && raw.file_name.length <= 255) item.file_name = raw.file_name;
 return item;
}

// Telegram photo messages are compressed renditions. An image sent as a document
// keeps the uploaded file bytes; accept only safe raster image MIME types.
function imageDocumentItemFrom(document) {
 if (!document || !document.file_id || typeof document.mime_type !== "string" || !/^image\/(jpeg|png|webp|gif)$/i.test(document.mime_type)) return null;
 return photoItemFrom(document);
}

// Идентификатор отзыва для альбома: один отзыв на весь media_group_id, иначе — по сообщению.
function reviewIdFor(chatId, msg) {
 const groupId = msg.media_group_id ? String(msg.media_group_id).replace(/[^0-9]/g, "").slice(0, 40) : "";
 return groupId ? `${chatId}_${groupId}` : `${chatId}_${msg.message_id}`;
}

function groupReviewPhotoIds(review) {
 const list = Array.isArray(review.photos) && review.photos.length ? review.photos : (review.fileId && review.kind !== "video" ? [{ file_id: review.fileId }] : []);
 return list.map(item => item.file_id).filter(Boolean);
}

// Добавляет фото к отзыву без дублей; возвращает обновлённый отзыв.
function addPhotoToReview(review, photoItem) {
 review.photos = Array.isArray(review.photos) ? review.photos : [];
 review.photos = uniqueFileItems([...review.photos, ...(photoItem ? [photoItem] : [])]);
 review.hasPhoto = review.photos.length > 0;
 if (!review.fileId && review.photos.length) review.fileId = review.photos[0].file_id;
 return review;
}

// Отправка карточки отзыва администраторам: все фото и видео, кнопки модерации.
async function sendReviewCardTo(env, adminIds, review, id, lead) {
 const photos = uniqueFileItems(review.photos && review.photos.length ? review.photos : (review.fileId && review.kind !== "video" ? [{file_id:review.fileId}] : []));
 const videos = uniqueFileItems(review.videos && review.videos.length ? review.videos : (review.kind === "video" && review.fileId ? [{file_id:review.fileId}] : []));
 const keyboard = { inline_keyboard: [
  [{ text: "✅ Опубликовать", callback_data: `pub:${id}` }, { text: "❌ Не публиковать", callback_data: `rej:${id}` }],
  [{ text: "🙈 Скрыть имя", callback_data: `anon:${id}` }, { text: "✏️ Редактировать текст", callback_data: `edit:${id}` }]
 ] };
 await Promise.all(adminIds.map(async adminId => {
  await sendChannelMedia(env, adminId, photos, videos, review.text ? String(review.text).slice(0, 1024) : "", review.mediaOrderKnown === true ? review.mediaItems : null);
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: (lead ? lead + "\n\n" : "") + formatReviewCard(review) + (photos.length + videos.length > 1 ? "\nФотографий: " + photos.length + (videos.length ? ", видео: " + videos.length : "") : ""), reply_markup: keyboard });
 }));
}

// Пост из группы отзывов, пересланный администратором в личку. Запись определяется исходным
// сообщением группы, а не сообщением бота: после очистки истории бота карточки могут пропасть,
// но записи в хранилище остаются. Поэтому:
//  - уже опубликован — сообщаем, повторно не публикуем;
//  - ожидает модерации — заново присылаем карточку с кнопками;
//  - отклонён или не было — новая попытка модерации.
async function handleForwardedGroupPost(msg, env, adminIds) {
 const reviewGroupId = String(env.TELEGRAM_REVIEW_GROUP_ID || "").trim();
 const origin = msg.forward_origin || null;
 if (!reviewGroupId || !origin || origin.type !== "chat" || String(origin.chat && origin.chat.id) !== reviewGroupId) return false;
 const chatId = String(msg.chat && msg.chat.id || "");
 if (!adminIds.includes(chatId)) return false;
 if (!env.REVIEWS) {
  await callTelegram(env, "sendMessage", { chat_id: chatId, text: "Хранилище REVIEWS не настроено. Пост не принят." });
  return true;
 }
 const ownId = reviewGroupId + "_" + String(origin.message_id);
 // Части альбома (общий media_group_id бота) сводятся к одной записи.
 const batchKey = msg.media_group_id ? "fwd_batch:" + chatId + "_" + String(msg.media_group_id) : null;
 const batchRaw = batchKey ? await env.REVIEWS.get(batchKey) : null;
 const batch = batchRaw ? JSON.parse(batchRaw) : null;
 const privateId = String(msg.message_id);
 const id = (await env.REVIEWS.get("fwd_origin:" + ownId)) || (batch && batch.id) || ownId;
 const batchStart = !batch || batch.start === privateId;
 if (batchKey && !batch) await env.REVIEWS.put(batchKey, JSON.stringify({ id, start: privateId }), { expirationTtl: 2592000 });
 await env.REVIEWS.put("fwd_origin:" + ownId, id, { expirationTtl: 2592000 });
 const photos = largestPhotoOf(msg.photo);
 const videos = msg.video && msg.video.file_id ? [{ file_id: msg.video.file_id }] : [];
 const text = String(msg.caption || msg.text || "").trim().replace(/^\/review(@\w+)?/i, "").trim().slice(0, 1000);
 if (!batchStart) {
  const raw = await env.REVIEWS.get("pending:" + id);
  if (raw) {
   const review = JSON.parse(raw);
   review.photos = uniqueFileItems([...(Array.isArray(review.photos) ? review.photos : []), ...photos]);
   review.videos = uniqueFileItems([...(Array.isArray(review.videos) ? review.videos : []), ...videos]);
   review.hasPhoto = review.photos.length > 0;
   if (!review.fileId) review.fileId = (review.photos[0] || review.videos[0] || {}).file_id || null;
   if (!review.text && text) review.text = text;
   await env.REVIEWS.put("pending:" + id, JSON.stringify(review));
  }
  return true;
 }
 if (await env.REVIEWS.get("approved:" + id)) {
  await Promise.all(adminIds.map(adminId => callTelegram(env, "sendMessage", { chat_id: adminId, text: "✅ Этот отзыв уже опубликован на сайте. Повторная публикация не создана." })));
  return true;
 }
 const pendingRaw = await env.REVIEWS.get("pending:" + id);
 if (pendingRaw) {
  await sendReviewCardTo(env, adminIds, JSON.parse(pendingRaw), id, "🔁 Повторная пересылка: отзыв ещё ожидает решения модератора.");
  return true;
 }
 if (!text && !photos.length && !videos.length) {
  await callTelegram(env, "sendMessage", { chat_id: chatId, text: "Отзыв не принят: в посте нет текста, фото или видео." });
  return true;
 }
 const review = {
  id, kind: videos.length ? "video" : "text", text, name: "Клиент",
  fileId: videos[0] ? videos[0].file_id : (photos[0] ? photos[0].file_id : null),
  photos, videos, hasPhoto: photos.length > 0, hasThanks: THANKS_PATTERN.test(text), anonymous: false,
  createdAt: new Date().toISOString(), sourceUrl: "Пересылка из группы отзывов"
 };
 await env.REVIEWS.put("pending:" + id, JSON.stringify(review));
 await sendReviewCardTo(env, adminIds, review, id, "");
 return true;
}

// Все части одного альбома приходят почти одновременно. Без очереди каждая часть видит,
// что записи ещё нет, и создаёт свою карточку. Поэтому части одного альбома обрабатываются
// по очереди внутри одного экземпляра Durable Object (AlbumSerializer), ключ — чат + media_group_id.
// Если привязка не настроена (например, в тестах), обработка идёт напрямую.
async function handleForwardedGroupPostSerialized(msg, env, adminIds) {
 const origin = msg.forward_origin || null;
 const isGroupForward = Boolean(origin && origin.type === "chat");
 if (!isGroupForward || !msg.media_group_id || !env.ALBUM_SERIALIZER) {
  return handleForwardedGroupPost(msg, env, adminIds);
 }
 const albumKey = "album:" + String(msg.chat && msg.chat.id || "") + "_" + String(msg.media_group_id);
 const stub = env.ALBUM_SERIALIZER.get(env.ALBUM_SERIALIZER.idFromName(albumKey));
 const response = await stub.fetch("https://album.internal/process", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ msg, adminIds })
 });
 if (!response.ok) throw new Error("Album serializer failed: " + response.status);
 return (await response.json()).handled === true;
}

// Channel album parts can arrive as parallel webhook requests too. Serialize them
// by media_group_id so every photo is merged before the next part reads/writes KV.
async function stageChannelPostSerialized(post, env, adminIds) {
 if (!post.media_group_id || !env.ALBUM_SERIALIZER) return stageChannelPost(post, env, adminIds);
 const albumKey = "channel-album:" + String(post.chat && post.chat.id || "") + "_" + String(post.media_group_id);
 const stub = env.ALBUM_SERIALIZER.get(env.ALBUM_SERIALIZER.idFromName(albumKey));
 const response = await stub.fetch("https://album.internal/process", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ type: "channel", msg: post, adminIds })
 });
 if (!response.ok) throw new Error("Channel album serializer failed: " + response.status);
 return (await response.json()).handled === true;
}

export class AlbumSerializer {
 constructor(state, env) {
  this.env = env;
  this.chain = Promise.resolve();
 }

 async fetch(request) {
  const { msg, adminIds, type } = await request.json();
  // Очередь: каждая часть альбома ждёт завершения предыдущей, даже если KV отвечает медленно.
  const run = this.chain.then(() => type === "channel"
   ? stageChannelPost(msg, this.env, adminIds)
   : type === "group_media"
    ? stageGroupMedia(msg, this.env, adminIds)
    : handleForwardedGroupPost(msg, this.env, adminIds));
  this.chain = run.catch(() => {});
  const handled = await run;
  return Response.json({ handled });
 }
}

async function handleAdminMediaUpload(msg, env, adminIds) {
 const adminId = String(msg.chat && msg.chat.id || "");
 if (!adminIds.includes(adminId) || (msg.forward_origin && msg.forward_origin.type === "channel")) return false;
 const photo = largestPhotoItem(msg.photo);
 const video = msg.video || null;
 if (!photo && !video) return false;
 if (!env.REVIEWS) {
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"Хранилище REVIEWS не настроено. Медиа не принято."});
  return true;
 }
 const id = msg.media_group_id ? reviewIdFor(adminId, msg) : adminId + "_" + String(msg.message_id);
 const uploadKey = "admin_upload:" + id;
 let state = JSON.parse(await env.REVIEWS.get(uploadKey) || "null");
 if (state && state.status === "approved") {
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"Это медиа уже опубликовано на сайте. Чтобы убрать его, откройте /site."});
  return true;
 }
 // После отказа то же медиа можно прислать заново: появится новая карточка.
 if (state && state.status === "rejected") state = null;
 if (!state) {
  const caption = String(msg.caption || "").trim().slice(0,1000);
  const review = {id,kind:video ? "video" : "text",text:caption,name:"Администратор загрузил",fileId:video ? video.file_id : photo.file_id,photos:photo ? [photo] : [],hasPhoto:Boolean(photo),hasThanks:THANKS_PATTERN.test(caption),anonymous:false,createdAt:new Date().toISOString(),sourceUrl:"Загрузка администратора"};
  state = {review,cardSent:false,status:"pending"};
  await env.REVIEWS.put("pending:" + id,JSON.stringify(review));
  await env.REVIEWS.put(uploadKey,JSON.stringify(state),{expirationTtl:2592000});
 } else if (msg.media_group_id && photo) {
  // Следующие фото альбома добавляются к тому же отзыву.
  const review = addPhotoToReview(state.review, photo);
  if (!review.text && msg.caption) review.text = String(msg.caption).trim().slice(0,1000);
  await env.REVIEWS.put("pending:" + id,JSON.stringify(review));
  state.review = review;
  await env.REVIEWS.put(uploadKey,JSON.stringify(state),{expirationTtl:2592000});
  if (state.cardSent) {
   await callTelegram(env,"sendMessage",{chat_id:adminId,text:"Добавлено фото в альбом. Всего фото в отзыве: " + review.photos.length + ".",reply_markup:{inline_keyboard:[[{text:"✅ Опубликовать",callback_data:"pub:" + id},{text:"❌ Не публиковать",callback_data:"rej:" + id}]]}});
   return true;
  }
 }
 // Повторная отправка того же медиа: карточка с кнопками приходит снова.
 if (state.cardSent && !(msg.media_group_id && photo)) {
  const pendingRaw = await env.REVIEWS.get("pending:" + id);
  if (pendingRaw) {
   await sendReviewCardTo(env, [adminId], JSON.parse(pendingRaw), id, "🔁 Повторная отправка: материал ещё ожидает решения модератора.");
  } else {
   await callTelegram(env,"sendMessage",{chat_id:adminId,text:"Материал уже обработан. Опубликованное можно посмотреть и убрать в /site."});
  }
  return true;
 }
 if (!state.cardSent) {
  const review = state.review;
  const keyboard = {inline_keyboard:[[{text:"✅ Опубликовать",callback_data:"pub:" + id},{text:"❌ Не публиковать",callback_data:"rej:" + id}],[{text:"🙈 Скрыть имя",callback_data:"anon:" + id}],[{text:"🚘 Как АВТОМОБИЛЬ",callback_data:"pubascar:" + id},{text:"📰 Как НОВОСТЬ",callback_data:"pubasnews:" + id}]]};
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:formatReviewCard(review) + "\n\nМедиа загружено вами в личный чат с ботом. Выберите, куда опубликовать: Отзыв, Автомобиль или Новость.",reply_markup:keyboard});
  state.cardSent = true;
  await env.REVIEWS.put(uploadKey,JSON.stringify(state),{expirationTtl:2592000});
 }
 return true;
}

async function handleReviewSubmission(msg, env, adminIds) {
 const reviewGroupId = String(env.TELEGRAM_REVIEW_GROUP_ID || "").trim();
 if (!reviewGroupId || String(msg.chat.id) !== reviewGroupId) return;
 // Admin media is handled by stageGroupMedia; do not create a second parallel review record.
 if (adminIds.includes(String((msg.from && msg.from.id) || ""))) return;
 const body = String(msg.text || msg.caption || "").trim();
 const isCommand = /^\/review(@\w+)?(\s|$)/i.test(body);
 const photoItem = largestPhotoItem(msg.photo) || imageDocumentItemFrom(msg.document);
 const chatId = String(msg.chat.id);
 if (!isCommand) {
  // Остальные фото альбома без команды: сохраняем к отзыву или ждём команду /review.
  if (!msg.media_group_id || !photoItem || !env.REVIEWS) return;
  const albumId = reviewIdFor(chatId, msg);
  const existing = await env.REVIEWS.get("pending:" + albumId);
  if (existing) {
   const review = addPhotoToReview(JSON.parse(existing), photoItem);
   await env.REVIEWS.put("pending:" + albumId, JSON.stringify(review));
   await Promise.all(adminIds.map(adminId => callTelegram(env, "sendMessage", { chat_id: adminId, text: "Добавлено фото в альбом. Всего фото в отзыве: " + review.photos.length + "." })));
   return;
  }
  const stashRaw = await env.REVIEWS.get("album_stash:" + albumId);
  const stash = uniqueFileItems([...(stashRaw ? JSON.parse(stashRaw) : []), photoItem]);
  await env.REVIEWS.put("album_stash:" + albumId, JSON.stringify(stash), { expirationTtl: 2592000 });
  return;
 }
 const text = body.replace(/^\/review(@\w+)?/i, "").trim().slice(0, 1000);
 const video = msg.video ? msg.video.file_id : null;
 if (!text && !video && !photoItem) return;
 const id = reviewIdFor(chatId, msg);
 // Порядок фото сохраняется: сначала пришедшие раньше команды, затем фото из команды.
 const photos = [];
 if (msg.media_group_id && env.REVIEWS) {
  const stashRaw = await env.REVIEWS.get("album_stash:" + id);
  photos.push(...uniqueFileItems(stashRaw ? JSON.parse(stashRaw) : []));
  await env.REVIEWS.delete("album_stash:" + id);
 }
 if (photoItem) photos.push(photoItem);
 const uniquePhotos = uniqueFileItems(photos);
 const review = {
  id,
  kind: video ? "video" : "text",
  text,
  name: String((msg.from && msg.from.first_name) || "Клиент").slice(0, 50),
  fileId: video || (uniquePhotos[0] && uniquePhotos[0].file_id) || null,
  photos: uniquePhotos,
  hasPhoto: uniquePhotos.length > 0,
  hasThanks: THANKS_PATTERN.test(text),
  anonymous: false,
  createdAt: new Date().toISOString()
 };
 if (!env.REVIEWS) {
  await Promise.all(adminIds.map(adminId => callTelegram(env, "sendMessage", { chat_id: adminId, text: "Отзыв получен, но хранилище отзывов не настроено (REVIEWS)." })));
  return;
 }
 await env.REVIEWS.put(`pending:${id}`, JSON.stringify(review));
 const keyboard = { inline_keyboard: [
  [{ text: "✅ Опубликовать", callback_data: `pub:${id}` }, { text: "❌ Не публиковать", callback_data: `rej:${id}` }],
  [{ text: "🙈 Скрыть имя", callback_data: `anon:${id}` }, { text: "✏️ Редактировать текст", callback_data: `edit:${id}` }]
 ] };
 await Promise.all(adminIds.map(async adminId => {
  const ids = groupReviewPhotoIds(review);
  if (review.kind === "video" && review.fileId) {
   await callTelegram(env, "sendVideo", { chat_id: adminId, video: review.fileId });
  } else {
   const photoItems = uniqueFileItems(review.photos && review.photos.length ? review.photos : (review.fileId ? [{file_id:review.fileId}] : []));
   let captionSent = false;
   for (const photo of photoItems) {
    const isDocument = Boolean(photo.mime_type);
    const method = isDocument ? "sendDocument" : "sendPhoto";
    const field = isDocument ? "document" : "photo";
    await callTelegram(env, method, { chat_id: adminId, [field]: photo.file_id, ...(!captionSent && text ? { caption: text.slice(0, 1024) } : {}) });
    if (text) captionSent = true;
   }
  }
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: formatReviewCard(review) + (ids.length > 1 ? "\nФотографий: " + ids.length : ""), reply_markup: keyboard });
 }));
}

// --- Журнал, причины отказа, проверка перед публикацией, отмена ---
const REJECT_REASONS = { "1": "Не по теме", "2": "Нет фото автомобиля", "3": "Дубль", "4": "Другое" };

async function writeLog(env, adminId, action, kind, id, detail) {
 if (!env.REVIEWS) return;
 const at = new Date().toISOString();
 const key = "log:" + at + "_" + Math.random().toString(36).slice(2, 8);
 await env.REVIEWS.put(key, JSON.stringify({ at, adminId: String(adminId), action, kind, id, detail: String(detail || "").slice(0, 120) }), { expirationTtl: 2592000 });
}

async function showLog(chatId, env) {
 if (!env.REVIEWS) return callTelegram(env, "sendMessage", { chat_id: chatId, text: "Хранилище не настроено." });
 const list = await env.REVIEWS.list({ prefix: "log:" });
 const names = list.keys.map(k => k.name).slice(-20).reverse();
 if (!names.length) return callTelegram(env, "sendMessage", { chat_id: chatId, text: "Журнал пока пуст." });
 const lines = [];
 for (const name of names) {
  const raw = await env.REVIEWS.get(name);
  if (!raw) continue;
  const e = JSON.parse(raw);
  const when = new Date(Date.parse(e.at) + 3 * 3600 * 1000).toISOString().slice(5, 16).replace("T", " ");
  lines.push(when + " — " + e.action + " (" + e.kind + ")" + (e.detail ? ": " + e.detail : ""));
 }
 return callTelegram(env, "sendMessage", { chat_id: chatId, text: "📜 Журнал, последние " + lines.length + " (время Москва):\n\n" + lines.join("\n") });
}

// Предупреждения перед публикацией: телефон, ссылка или ник в тексте, нет фото.
function publishWarnings(text, photoCount) {
 const body = String(text || "");
 const warnings = [];
 if (/(?<!\d)(?:\+?7|8)[\s().-]*\d(?:[\s().-]*\d){9}(?!\d)/.test(body)) warnings.push("в тексте есть телефон");
 if (/https?:\/\/|t\.me\/|@[A-Za-z0-9_]{4,}/i.test(body)) warnings.push("в тексте есть ссылка или ник");
 if (!photoCount) warnings.push("нет фото");
 return warnings;
}

async function askPublishCheck(env, adminId, kind, id, warnings) {
 const isCar = kind === "car";
 await callTelegram(env, "sendMessage", {
  chat_id: adminId,
  text: "⚠️ Перед публикацией проверьте:\n• " + warnings.join("\n• ") + "\n\nЕсли всё в порядке, опубликуйте без проверки.",
  reply_markup: { inline_keyboard: [
   [{ text: "✅ Всё равно опубликовать", callback_data: (isCar ? "carpubforce:" : "pubforce:") + id }],
   [{ text: "✏️ Исправить", callback_data: (isCar ? "caredit:" : "edit:") + id }]
  ] }
 });
}

async function askRejectReason(env, adminId, id) {
 const buttons = Object.entries(REJECT_REASONS).map(([n, label]) => ({ text: label, callback_data: "rejr:" + n + ":" + id }));
 await callTelegram(env, "sendMessage", {
  chat_id: adminId,
  text: "Причина отказа? Она попадёт в журнал, автор ничего не получит.",
  reply_markup: { inline_keyboard: [buttons.slice(0, 2), buttons.slice(2)] }
 });
}

async function handleRejectReasonCallback(callback, env, adminIds) {
 const answer = (text, alert = false) => callTelegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: alert });
 const fromId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(fromId)) return answer("Нет доступа", true);
 const match = String(callback.data || "").match(/^rejr:([1-4]):((?:car_)?-?\d+_\d+)$/);
 if (!match) return answer("Причина не распознана", true);
 const label = REJECT_REASONS[match[1]];
 const id = match[2];
 await writeLog(env, fromId, "отказ: " + label, id.startsWith("car_") ? "машина" : "отзыв", id, "");
 if (callback.message) await callTelegram(env, "deleteMessage", { chat_id: callback.message.chat.id, message_id: callback.message.message_id }).catch(() => {});
 return answer("Причина записана: " + label);
}

// Кнопка «Отменить» на 2 минуты после публикации или снятия.
async function offerUndo(env, adminId, id, state, text, extraRows) {
 await env.REVIEWS.put("undo:" + id, JSON.stringify(state), { expirationTtl: 120 });
 await callTelegram(env, "sendMessage", {
  chat_id: adminId,
  text: text + "\n\nОтменить можно в течение 2 минут.",
  reply_markup: { inline_keyboard: [[{ text: "↩️ Отменить", callback_data: "undo:" + id }], ...(extraRows || [])] }
 });
}

// Снимает материал с сайта и возвращает в ожидание. Возвращает прежнюю запись или null.
async function unpublishItem(env, adminIds, id) {
 const isCar = id.startsWith("car_");
 const isNews = id.startsWith("news_");
 const storedKey = (isCar ? "car_approved:" : (isNews ? "news_approved:" : "approved:")) + id;
 const raw = await env.REVIEWS.get(storedKey);
 if (!raw) return null;
 const record = JSON.parse(raw);
 if (isCar) {
  const car = { ...record };
  delete car.publishedAt;
  await env.REVIEWS.put("car_pending:" + id, JSON.stringify(car));
  await env.REVIEWS.delete(storedKey);
  await sendPendingCarCard(env, adminIds, car, id, "↩️ Снято с сайта. Объявление снова ожидает решения модератора.");
 } else if (isNews) {
  const newsItem = { ...record };
  delete newsItem.publishedAt;
  await env.REVIEWS.put("news_pending:" + id, JSON.stringify(newsItem));
  await env.REVIEWS.delete(storedKey);
  await Promise.all(adminIds.map(adminId => callTelegram(env, "sendMessage", {
   chat_id: adminId,
   text: "↩️ Новость снята с сайта и перемещена в очередь модерации.\n\n" + String(newsItem.text || newsItem.caption || "").slice(0, 1500),
   reply_markup: { inline_keyboard: [[{ text: "✅ Опубликовать снова", callback_data: "newspub:" + id }, { text: "❌ Удалить", callback_data: "newsrej:" + id }]] }
  })));
 } else {
  const photos = Array.isArray(record.photos) ? record.photos : [];
  const review = {
   id, kind: record.kind, text: record.text, name: record.name, anonymous: !record.name, fileId: record.fileId,
   photos, videos: Array.isArray(record.videos) ? record.videos : [],
   hasPhoto: photos.length > 0 || Boolean(record.fileId),
   unpublishedAt: new Date().toISOString()
  };
  await env.REVIEWS.put("pending:" + id, JSON.stringify(review));
  await env.REVIEWS.delete(storedKey);
  const uploadRaw = await env.REVIEWS.get("admin_upload:" + id);
  if (uploadRaw) { const uploadState = JSON.parse(uploadRaw); uploadState.status = "pending"; await env.REVIEWS.put("admin_upload:" + id, JSON.stringify(uploadState), {expirationTtl:2592000}); }
  await sendReviewCardTo(env, adminIds, review, id, "↩️ Снято с сайта. Отзыв снова ожидает решения модератора.");
 }
 return record;
}

async function handleUndoCallback(callback, env, adminIds) {
 const answer = (text, alert = false) => callTelegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: alert });
 const fromId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(fromId)) return answer("Нет доступа", true);
 const match = String(callback.data || "").match(/^undo:(car_-?\d+_\d+|news_[A-Za-z0-9_-]+|-?\d+_\d+)$/);
 if (!match || !env.REVIEWS) return answer("Не распознано", true);
 const id = match[1];
 const raw = await env.REVIEWS.get("undo:" + id);
 if (!raw) return answer("Время для отмены вышло", true);
 const state = JSON.parse(raw);
 await env.REVIEWS.delete("undo:" + id);
 const isCar = id.startsWith("car_");
 const isNews = id.startsWith("news_");
 const kind = isCar ? "машина" : (isNews ? "новость" : "отзыв");
 if (state.action === "unpublish") {
  const done = await unpublishItem(env, adminIds, id);
  if (!done) return answer("Уже не на сайте", true);
  await writeLog(env, fromId, "отмена публикации", kind, id, "");
  return answer("Публикация отменена");
 }
  await env.REVIEWS.put((isCar ? "car_approved:" : (isNews ? "news_approved:" : "approved:")) + id, JSON.stringify(state.record));
  await env.REVIEWS.delete((isCar ? "car_pending:" : (isNews ? "news_pending:" : "pending:")) + id);
  await writeLog(env, fromId, "отмена снятия", kind, id, "");
  return answer("Снова опубликовано на сайте");
}

async function handleReviewCallback(callback, env, adminIds) {
 const answer = (text, alert = false) => callTelegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: alert });
 const fromId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(fromId)) return answer("Нет доступа", true);
 const match = String(callback.data || "").match(/^(pub|pubforce|rej|anon|edit):(-?\d+_\d+)$/);
 if (!match || !env.REVIEWS) return answer("Отзыв не найден", true);
 const [, action, id] = match;
 const raw = await env.REVIEWS.get(`pending:${id}`);
 if (!raw) return answer("Отзыв уже обработан или не найден", true);
 const review = JSON.parse(raw);
 if (action === "edit") return beginModerationEdit(callback, env, "review", id, answer);
 if (action === "anon") {
  review.anonymous = true;
  await env.REVIEWS.put(`pending:${id}`, JSON.stringify(review));
  return answer("Имя будет скрыто");
 }
 if (action === "rej") {
  await env.REVIEWS.delete(`pending:${id}`);
  const uploadRaw = await env.REVIEWS.get("admin_upload:" + id);
  if (uploadRaw) { const uploadState = JSON.parse(uploadRaw); uploadState.status = "rejected"; await env.REVIEWS.put("admin_upload:" + id,JSON.stringify(uploadState),{expirationTtl:2592000}); }
  await askRejectReason(env, fromId, id);
  return answer("Не публикуется");
 }
 const problem = reviewRuleProblem(review);
 if (problem) return answer(`Нельзя опубликовать: ${problem}`, true);
 if (action === "pub") {
  const warnings = publishWarnings(review.text, Array.isArray(review.photos) && review.photos.length ? review.photos.length : (review.fileId ? 1 : 0));
  if (warnings.length) { await askPublishCheck(env, fromId, "review", id, warnings); return answer("Проверьте перед публикацией"); }
 }
 const published = {
  id,
  kind: review.kind,
  text: review.text,
  name: review.anonymous ? "" : review.name,
  fileId: review.fileId,
  videos: Array.isArray(review.videos) ? review.videos : [],
  mediaItems: Array.isArray(review.mediaItems) ? review.mediaItems : [],
  mediaOrderKnown: review.mediaOrderKnown === true,
  anonymous: Boolean(review.anonymous),
  photos: Array.isArray(review.photos) && review.photos.length ? review.photos : (review.fileId && review.kind !== "video" ? [{file_id:review.fileId}] : []),
  publishedAt: new Date().toISOString()
 };
 await env.REVIEWS.put(`approved:${id}`, JSON.stringify(published));
 await env.REVIEWS.delete(`pending:${id}`);
 const uploadRaw = await env.REVIEWS.get("admin_upload:" + id);
 if (uploadRaw) { const uploadState = JSON.parse(uploadRaw); uploadState.status = "approved"; await env.REVIEWS.put("admin_upload:" + id,JSON.stringify(uploadState),{expirationTtl:2592000}); }
 await writeLog(env, fromId, "опубликован", "отзыв", id, siteLabel(id, published));
 await offerUndo(env, fromId, id, { action: "unpublish" }, "🌐 Отзыв опубликован на сайте.", [[{ text: "🗑 Убрать с сайта", callback_data: "sitedel:" + id }]]);
 return answer("Опубликовано на сайте");
}

// --- Импорт канала: сначала администратор выбирает тип, затем отдельная модерация ---
function sourcePostDate(post) {
 const value = Number(post.sourceDate || post.date || 0);
 return value > 0 ? value : 0;
}

// --- Пересылка постов из канала @avtoYkorea ---
// Одна пересылка альбома приходит несколькими сообщениями с общим media_group_id.
// Все части одной пересылки сводятся к одной записи: её ID — первое сообщение канала.
function channelPostId(chat, messageNumber) {
 return String(chat.id) + "_" + String(messageNumber);
}

function messageNumberOf(id) {
 return String(id).slice(String(id).lastIndexOf("_") + 1);
}

// Уникальные файлы по file_id, порядок сохраняется.
function uniqueFileItems(list) {
 const seen = new Set();
 const out = [];
 for (const item of Array.isArray(list) ? list : []) {
  const raw = item && typeof item === "object" ? item : { file_id: item };
  if (!raw.file_id) continue;
  const key = raw.file_unique_id ? "u:" + String(raw.file_unique_id) : "f:" + String(raw.file_id);
  if (seen.has(key)) continue;
  seen.add(key);
  out.push(photoItemFrom(raw));
 }
 return out;
}

function orderedItemsFromPost(post) {
 const sourceId = Number(post && (post.sourceMessageId || post.message_id));
 const photos = postPhotos(post);
 const videos = postVideos(post);
 // A single Telegram message carries one media object. Multiple legacy objects
 // have already lost their per-part message IDs, so do not invent a shared ID.
 const sourceMessageId = photos.length + videos.length === 1 && Number.isSafeInteger(sourceId) && sourceId > 0 ? sourceId : null;
 const photoItems = photos.map(item => ({ ...item, type: item.mime_type ? "document" : "photo", sourceMessageId }));
 const videoItems = videos.map(item => ({ ...item, type: "video", sourceMessageId }));
 return [...photoItems, ...videoItems];
}

function mergePostMediaOrder(post, incomingItems) {
 const merged = mergeOrderedMediaItems(Array.isArray(post.mediaItems) ? post.mediaItems : [], incomingItems);
 post.mediaItems = merged.mediaItems;
 post.mediaOrderKnown = merged.mediaOrderKnown;
 return post;
}

function publicCarMediaOrder(car, photos, videos) {
 const ordered = orderedMediaFromRecord(car);
 const identity = item => String(item.file_unique_id || item.file_id || "");
 if (ordered.mediaOrderKnown) {
  const output = [];
  for (const item of ordered.mediaItems) {
   const photoIndex = photos.findIndex(candidate => identity(candidate) === identity(item));
   if (photoIndex >= 0) { output.push({ url: "/api/car-media/" + car.id + "/photo/" + photoIndex, type: "photo" }); continue; }
   const videoIndex = videos.findIndex(candidate => identity(candidate) === identity(item));
   if (videoIndex >= 0) output.push({ url: "/api/car-media/" + car.id + "/video/" + videoIndex, type: "video" });
  }
  return { mediaItems: output, mediaOrderKnown: output.length === ordered.mediaItems.length };
 }
 // Legacy mixed albums without source message IDs fall back deterministically to photos -> videos
 // so existing published listings never lose their media on the live site.
 const mediaItems = [
  ...photos.map((_, index) => ({ url: "/api/car-media/" + car.id + "/photo/" + index, type: "photo" })),
  ...videos.map((_, index) => ({ url: "/api/car-media/" + car.id + "/video/" + index, type: "video" }))
 ];
 return { mediaItems, mediaOrderKnown: false };
}

function publicReviewMediaOrder(review, photos, videos) {
 const ordered = orderedMediaFromRecord(review);
 const identity = item => String(item.file_unique_id || item.file_id || "");
 if (ordered.mediaOrderKnown) {
  const output = [];
  for (const item of ordered.mediaItems) {
   const photoIndex = photos.findIndex(candidate => identity(candidate) === identity(item));
   if (photoIndex >= 0) { output.push({ url: "/api/review-media/" + review.id + "/photo/" + photoIndex, type: "photo" }); continue; }
   const videoIndex = videos.findIndex(candidate => identity(candidate) === identity(item));
   if (videoIndex >= 0) output.push({ url: "/api/review-media/" + review.id + "/video/" + videoIndex, type: "video" });
  }
  return { mediaItems: output, mediaOrderKnown: output.length === ordered.mediaItems.length };
 }
 const mixedLegacy = photos.length > 0 && videos.length > 0;
 if (mixedLegacy) return { mediaItems: [], mediaOrderKnown: false };
 const mediaItems = [
  ...photos.map((_, index) => ({ url: "/api/review-media/" + review.id + "/photo/" + index, type: "photo" })),
  ...videos.map((_, index) => ({ url: "/api/review-media/" + review.id + "/video/" + index, type: "video" }))
 ];
 return { mediaItems, mediaOrderKnown: false };
}

function postPhotos(post) {
 const items = Array.isArray(post.photos) ? post.photos : (Array.isArray(post.photo) ? post.photo : []);
 const documentPhoto = imageDocumentItemFrom(post.document);
 return uniqueFileItems([...items, ...(documentPhoto ? [documentPhoto] : [])]);
}

// Hide clearly undersized photo renditions from published vehicle galleries.
// Unknown dimensions remain visible pending manual review.
function catalogPhotoItems(car) {
 const source = Array.isArray(car.photos) ? car.photos : (car.fileId && car.mediaType !== "video" ? [{file_id:car.fileId}] : []);
 return uniqueFileItems(source).filter(photo => {
  const width = Number(photo.width) || 0, height = Number(photo.height) || 0;
  if (!width || !height) return true;
  return Math.max(width, height) >= 1280 && width * height >= 900000;
 });
}

function postVideos(post) {
 if (Array.isArray(post.videos) && post.videos.length) return uniqueFileItems(post.videos);
 return uniqueFileItems(post.video && post.video.file_id ? [post.video] : []);
}

// Один исходный снимок Telegram = один элемент альбома; берём его максимальную rendition.
function largestPhotoOf(photo) {
 const best = largestPhotoSize(photo);
 return best ? [photoItemFrom(best)] : [];
}

// Отправка всех фото и видео записи администратору.
async function sendChannelMedia(env, adminId, photos, videos, caption, orderedItems = null) {
 if (Array.isArray(orderedItems) && orderedItems.length && orderedItems.every(item => Number.isSafeInteger(Number(item.sourceMessageId)) && Number(item.sourceMessageId) > 0)) {
  let first = true;
  for (const item of orderedItems) {
   const type = item.type === "video" ? "video" : (item.type === "document" || item.mime_type ? "document" : "photo");
   const field = type;
   const payload = {chat_id:adminId,[field]:item.file_id,...(first && caption ? {caption:String(caption).slice(0,1024)} : {})};
   await callTelegram(env,type === "video" ? "sendVideo" : (type === "document" ? "sendDocument" : "sendPhoto"),payload);
   first = false;
  }
  return;
 }
 // Legacy photo-only or video-only records keep their original per-type order.
 for (let offset = 0; offset < photos.length; offset += 10) {
  const chunk = photos.slice(offset, offset + 10);
  const documentItems = chunk.filter(photo => photo.mime_type);
  const photoItems = chunk.filter(photo => !photo.mime_type);
  for (const photo of documentItems) {
   await callTelegram(env, "sendDocument", { chat_id: adminId, document: photo.file_id, ...(offset === 0 && caption ? { caption: caption.slice(0, 1024) } : {}) });
  }
  if (photoItems.length > 1) {
   const media = photoItems.map((photo, index) => ({ type: "photo", media: photo.file_id, ...(offset === 0 && documentItems.length === 0 && index === 0 && caption ? { caption: caption.slice(0, 1024) } : {}) }));
   await callTelegram(env, "sendMediaGroup", { chat_id: adminId, media });
  } else if (photoItems.length === 1) {
   await callTelegram(env, "sendPhoto", { chat_id: adminId, photo: photoItems[0].file_id, ...(offset === 0 && documentItems.length === 0 && caption ? { caption: caption.slice(0, 1024) } : {}) });
  }
 }
 for (const video of videos) await callTelegram(env, "sendVideo", { chat_id: adminId, video: video.file_id });
}

// Exact-byte deduplication is scoped to one car publication. Telegram's
// stable IDs catch ordinary re-forwards; SHA-256 catches identical bytes
// uploaded again under a new ID. Verification failures keep the image (fail open).
async function uniquePhotoFilesByContent(items, env) {
 const seen = new Set();
 const output = [];
 const maxBytes = 12 * 1024 * 1024;
 let inspected = 0;
 for (const item of uniqueFileItems(items)) {
  let digest = null;
  if (inspected < 30 && env.TELEGRAM_BOT_TOKEN && item.file_id && globalThis.crypto && crypto.subtle) {
   inspected++;
   try {
    const info = await callTelegram(env, "getFile", { file_id: item.file_id });
    const path = info && info.result && info.result.file_path;
    if (path) {
     const response = await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + path);
     if (response.ok) {
      const declaredSize = Number(response.headers.get("content-length") || 0);
      if (!declaredSize || declaredSize <= maxBytes) {
       const bytes = await response.arrayBuffer();
       if (bytes.byteLength > 0 && bytes.byteLength <= maxBytes) {
        const hash = await crypto.subtle.digest("SHA-256", bytes);
        digest = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
       }
      }
     }
    }
   } catch (_) {
    // Never discard media just because the verification service failed.
   }
  }
  const key = digest ? "sha256:" + digest : null;
  if (key && seen.has(key)) continue;
  if (key) seen.add(key);
  output.push(item);
 }
 return output;
}

function carPhotoQualityNote(photos) {
 const list = Array.isArray(photos) ? photos : [];
 if (!list.length) return "⚠️ Нет фотографий автомобиля.";
 const weak = list.map((photo, index) => ({ photo, index })).filter(({ photo }) => {
  const width = Number(photo.width) || 0, height = Number(photo.height) || 0;
  const known = width > 0 && height > 0;
  return (known && (Math.max(width, height) < 1280 || width * height < 900000)) ||
   (Number(photo.file_size) > 0 && Number(photo.file_size) < 120000);
 });
 const unknown = list.filter(photo => !(Number(photo.width) > 0 && Number(photo.height) > 0)).length;
 if (!weak.length && !unknown) return "✅ Разрешение фото: проверка пройдена.";
 if (weak.length) return "⚠️ Слабое разрешение: фото " + weak.map(item => item.index + 1).join(", ") + ". Запросите оригиналы как ФАЙЛ/ДОКУМЕНТ; не публикуйте размытые снимки.";
 return "ℹ️ Разрешение части фото не удалось проверить. Для гарантии качества запросите оригиналы как ФАЙЛ/ДОКУМЕНТ.";
}

async function handleCarPost(post, env, adminIds) {
 const chat = post.chat || {};
 if (String(chat.username || "").toLowerCase() !== "avtoykorea") return;
 const created = sourcePostDate(post);
 const cutoff = Math.floor(Date.UTC(2026, 0, 1) / 1000);
 if (!created || created < cutoff) {
  await Promise.all(adminIds.map(adminId => callTelegram(env, "sendMessage", {
   chat_id: adminId,
   text: "⏭ Автомобиль не импортирован: публикация создана до 1 января 2026 года или дата источника недоступна. Для отзывов такого ограничения нет."
  })));
  return;
 }
 const caption = cleanPublicationText(post.caption || post.text).slice(0, 3000);
 const photos = await uniquePhotoFilesByContent(postPhotos(post), env);
 const videos = postVideos(post);
 const fileId = photos.length ? photos[photos.length - 1].file_id : (videos.length ? videos[0].file_id : null);
 if (!caption && !fileId) return;
 if (!env.REVIEWS) { await Promise.all(adminIds.map(id => callTelegram(env, "sendMessage", {chat_id:id,text:"Объявление получено, но хранилище REVIEWS не настроено."}))); return; }
 const id = "car_" + String(chat.id).replace(/-/g,"") + "_" + messageNumberOf(post.message_id);
 const approved = await env.REVIEWS.get("car_approved:" + id);
 if (approved) {
  await Promise.all(adminIds.map(adminId => callTelegram(env,"sendMessage",{chat_id:adminId,text:"✅ Этот автомобиль уже опубликован на сайте. Повторная публикация не создана: https://t.me/" + chat.username + "/" + messageNumberOf(post.message_id)})));
  return;
 }
 const existing = await env.REVIEWS.get("car_pending:" + id);
 if (existing) {
  const saved = JSON.parse(existing);
  const keyboard = {inline_keyboard:[[{text:"✅ Опубликовать",callback_data:"carpub:" + id},{text:"❌ Отклонить",callback_data:"carrej:" + id}],[{text:"✏️ Редактировать описание",callback_data:"caredit:" + id}]]};
  await Promise.all(adminIds.map(async adminId => {
   await sendChannelMedia(env, adminId, postPhotos(saved), postVideos(saved), saved.caption || "", saved.mediaOrderKnown === true ? saved.mediaItems : null);
   await callTelegram(env,"sendMessage",{chat_id:adminId,text:"🔁 Повторная отправка: автомобиль всё ещё ожидает решения модератора.\n\n" + (saved.caption || "Описание отсутствует") + "\n\nИсточник: " + saved.sourceUrl,reply_markup:keyboard});
  }));
  return;
 }
 const hasSourceMediaItems = Array.isArray(post.mediaItems) && post.mediaItems.length > 0;
 const sourceMedia = hasSourceMediaItems
  ? mergeOrderedMediaItems([],post.mediaItems)
  : mergeOrderedMediaItems([],orderedItemsFromPost(post));
 if (hasSourceMediaItems) sourceMedia.mediaOrderKnown = post.mediaOrderKnown === true && sourceMedia.mediaOrderKnown;
 const mediaItems = sourceMedia.mediaItems.filter(item => {
  const identity = String(item.file_unique_id || item.file_id || "");
  return [...photos,...videos].some(candidate => String(candidate.file_unique_id || candidate.file_id || "") === identity);
 });
 const car = {id,caption,fileId,photos,videos,mediaItems,mediaOrderKnown:sourceMedia.mediaOrderKnown && mediaItems.length === sourceMedia.mediaItems.length,mediaType:videos.length && !photos.length ? "video" : "photo",sourceUrl:"https://t.me/" + chat.username + "/" + messageNumberOf(post.message_id),createdAt:new Date().toISOString(),sourceDate:created};
 await env.REVIEWS.put("car_pending:" + id, JSON.stringify(car));
 const keyboard = {inline_keyboard:[[{text:"✅ Опубликовать",callback_data:"carpub:" + id},{text:"❌ Отклонить",callback_data:"carrej:" + id}],[{text:"✏️ Редактировать описание",callback_data:"caredit:" + id}]]};
 await Promise.all(adminIds.map(async adminId => {
  await sendChannelMedia(env, adminId, photos, videos, caption, mediaItems.length && sourceMedia.mediaOrderKnown ? mediaItems : null);
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"🚘 ОДИН АВТОМОБИЛЬ · " + (caption.split(String.fromCharCode(10)).find(line => line.trim()) || "Без названия").slice(0,90) + "\nФотографий: " + photos.length + (videos.length ? "\nВидео: " + videos.length : "") + "\n" + carPhotoQualityNote(photos) + "\n\n" + (caption || "Описание отсутствует") + "\n\nИсточник: " + car.sourceUrl,reply_markup:keyboard});
 }));
}

async function handleImportedReview(post, env, adminIds) {
 const chat = post.chat || {};
 if ((String(chat.username || "").toLowerCase() !== "avtoykorea" && post.sourceType !== "group") || !env.REVIEWS) return;
 const text = cleanPublicationText(post.caption || post.text).slice(0, 1000);
 const photoItems = postPhotos(post);
 const videoItems = postVideos(post);
 const photoIds = photoItems.map(item => item.file_id);
 const photo = photoIds[0] || null;
 const video = videoItems[0] ? videoItems[0].file_id : null;
 if (!text && !photo && !video) {
  await Promise.all(adminIds.map(adminId => callTelegram(env,"sendMessage",{chat_id:adminId,text:"Отзыв не импортирован: в публикации нет текста, фото или видео."})));
  return;
 }
 const number = messageNumberOf(post.message_id);
 const id = channelPostId(chat, number);
 if (await env.REVIEWS.get("approved:" + id)) return;
 const existingReview = await env.REVIEWS.get("pending:" + id);
 const hasSourceMediaItems = Array.isArray(post.mediaItems) && post.mediaItems.length > 0;
 const sourceMedia = hasSourceMediaItems
  ? mergeOrderedMediaItems([],post.mediaItems)
  : mergeOrderedMediaItems([],orderedItemsFromPost(post));
 if (hasSourceMediaItems) sourceMedia.mediaOrderKnown = post.mediaOrderKnown === true && sourceMedia.mediaOrderKnown;
 const review = existingReview ? JSON.parse(existingReview) : {
  id,kind:video ? "video" : "text",text,name:"Клиент",fileId:video || photo || null,photos:photoItems,videos:videoItems,mediaItems:sourceMedia.mediaItems,mediaOrderKnown:sourceMedia.mediaOrderKnown,hasPhoto:Boolean(photo),hasThanks:THANKS_PATTERN.test(text),anonymous:false,createdAt:new Date().toISOString(),sourceUrl:post.sourceUrl || (chat.username ? "https://t.me/" + chat.username + "/" + number : "Пересылка администратора")
 };
 if (existingReview) {
  review.photos = uniqueFileItems([...(Array.isArray(review.photos) ? review.photos : (review.fileId && review.kind !== "video" ? [{file_id:review.fileId}] : [])), ...photoItems]);
  review.videos = uniqueFileItems([...(Array.isArray(review.videos) ? review.videos : (review.kind === "video" && review.fileId ? [{file_id:review.fileId}] : [])), ...videoItems]);
  const hadCanonicalOrder = Array.isArray(review.mediaItems) && review.mediaItems.length > 0;
  const mergedMedia = mergeOrderedMediaItems(review.mediaItems || [],sourceMedia.mediaItems);
  review.mediaItems = mergedMedia.mediaItems;
  review.mediaOrderKnown = hadCanonicalOrder && review.mediaOrderKnown === true && mergedMedia.mediaOrderKnown;
  if (!review.fileId) review.fileId = video || photo || null;
  review.hasPhoto = Boolean(review.photos.length || photo);
  if (!review.text && text) review.text = text;
  await env.REVIEWS.put("pending:" + id,JSON.stringify(review));
 } else await env.REVIEWS.put("pending:" + id,JSON.stringify(review));
 const keyboard = {inline_keyboard:[[{text:"✅ Опубликовать",callback_data:"pub:" + id},{text:"❌ Не публиковать",callback_data:"rej:" + id}],[{text:"🙈 Скрыть имя",callback_data:"anon:" + id},{text:"✏️ Редактировать текст",callback_data:"edit:" + id}]]};
 const deliveryKey = "review_delivery:" + id;
 const delivery = JSON.parse(await env.REVIEWS.get(deliveryKey) || "{}");
 // A new moderation attempt after rejection must not inherit the previous
 // attempt's "card already sent" flags.
 if (!existingReview) delivery.admins = {};
 delivery.admins = delivery.admins || {};
 for (const adminId of adminIds) {
  const status = delivery.admins[String(adminId)] || {mediaSent:!review.fileId && !(review.photos && review.photos.length),cardSent:false};
  if (!status.mediaSent) {
   const photosToSend = uniqueFileItems(review.photos && review.photos.length ? review.photos : (review.fileId && review.kind !== "video" ? [{file_id:review.fileId}] : []));
   const videosToSend = uniqueFileItems(review.videos && review.videos.length ? review.videos : (review.kind === "video" && review.fileId ? [{file_id:review.fileId}] : []));
   await sendChannelMedia(env,adminId,photosToSend,videosToSend,text,review.mediaOrderKnown === true ? review.mediaItems : null);
   status.mediaSent = true;
   delivery.admins[String(adminId)] = status;
   await env.REVIEWS.put(deliveryKey,JSON.stringify(delivery),{expirationTtl:2592000});
  }
  if (!status.cardSent) {
   await callTelegram(env,"sendMessage",{chat_id:adminId,text:formatReviewCard(review) + "\n\nФотографий: " + (review.photos || []).length + (review.videos && review.videos.length ? "\nВидео: " + review.videos.length : "") + "\nИсточник: " + review.sourceUrl,reply_markup:keyboard});
   status.cardSent = true;
   delivery.admins[String(adminId)] = status;
   await env.REVIEWS.put(deliveryKey,JSON.stringify(delivery),{expirationTtl:2592000});
  }
 }
}

async function handleNewsPost(post, env, adminIds) {
 const chat = post.chat || {};
 if (!env.REVIEWS) return;
 const text = cleanCarDisplayCaption(cleanPublicationText(post.caption || post.text)).slice(0, 3000);
 const photos = postPhotos(post);
 const videos = postVideos(post);
 if (!text && !photos.length && !videos.length) {
  await Promise.all(adminIds.map(adminId => callTelegram(env,"sendMessage",{chat_id:adminId,text:"Новость не импортирована: нет текста, фото или видео."})));
  return;
 }
 const number = messageNumberOf(post.message_id);
 const id = "news_" + String(chat.id || "admin").replace(/-/g,"") + "_" + number;
 if (await env.REVIEWS.get("news_approved:" + id)) {
  await Promise.all(adminIds.map(adminId => callTelegram(env,"sendMessage",{chat_id:adminId,text:"✅ Эта новость уже опубликована на сайте."})));
  return;
 }
 const newsItem = {
  id,
  category: "news",
  kind: videos.length ? "video" : "text",
  text,
  fileId: photos[0]?.file_id || videos[0]?.file_id || null,
  photos,
  videos,
  mediaItems: Array.isArray(post.mediaItems) ? post.mediaItems : [],
  mediaOrderKnown: post.mediaOrderKnown === true,
  createdAt: new Date().toISOString()
 };
 await env.REVIEWS.put("news_pending:" + id, JSON.stringify(newsItem));
 const keyboard = {inline_keyboard:[[{text:"✅ Опубликовать новость",callback_data:"newspub:" + id},{text:"❌ Отклонить",callback_data:"newsrej:" + id}],[{text:"✏️ Редактировать текст",callback_data:"newsedit:" + id}]]};
 await Promise.all(adminIds.map(async adminId => {
  await sendChannelMedia(env, adminId, photos, videos, text, newsItem.mediaOrderKnown ? newsItem.mediaItems : null);
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"📰 НОВОСТЬ НА МОДЕРАЦИИ\n\n" + (text || "Без текста") + "\n\nФото: " + photos.length + " · Видео: " + videos.length,reply_markup:keyboard});
 }));
}

async function handleNewsCallback(callback, env, adminIds) {
 const answer = (text, alert=false) => callTelegram(env,"answerCallbackQuery",{callback_query_id:callback.id,text,show_alert:alert});
 const fromId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(fromId)) return answer("Нет доступа",true);
 const match = String(callback.data || "").match(/^news(pub|rej|edit):(news_-?[0-9a-z_]+)$/i);
 if (!match || !env.REVIEWS) return answer("Новость не найдена",true);
 const [, action, id] = match;
 const raw = await env.REVIEWS.get("news_pending:" + id);
 if (!raw) return answer("Новость уже обработана или не найдена",true);
 const newsItem = JSON.parse(raw);
 if (action === "edit") {
  await env.REVIEWS.put("moderation_edit:" + fromId, JSON.stringify({ type: "news", id, createdAt: new Date().toISOString() }), { expirationTtl: 86400 });
  await callTelegram(env, "sendMessage", {
   chat_id: fromId,
   text: "✏️ РЕДАКТИРОВАНИЕ НОВОСТИ\n\nОтправьте исправленный текст ответом на это сообщение:\n\n" + (newsItem.text || "— пусто —").slice(0, 3000),
   reply_markup: { force_reply: true }
  });
  return answer("Отправьте новый текст ответом");
 }
 if (action === "rej") {
  await env.REVIEWS.delete("news_pending:" + id);
  return answer("Новость отклонена");
 }
 await env.REVIEWS.put("news_approved:" + id, JSON.stringify({ ...newsItem, publishedAt: new Date().toISOString() }));
 await env.REVIEWS.delete("news_pending:" + id);
 await writeLog(env, fromId, "опубликована", "новость", id, siteLabel(id, newsItem));
 await offerUndo(env, fromId, id, { action: "unpublish" }, "📰 Новость опубликована на сайте!", [[{ text: "🗑 Убрать с сайта", callback_data: "sitedel:" + id }]]);
 return answer("Новость опубликована на сайте");
}

async function handleImportChoice(callback, env, adminIds) {
 const answer = (text, alert=false) => callTelegram(env,"answerCallbackQuery",{callback_query_id:callback.id,text,show_alert:alert});
 const fromId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(fromId)) return answer("Нет доступа",true);
 const match = String(callback.data || "").match(/^imp:(car|review|news):(-?\d+_\d+)$/);
 if (!match || !env.REVIEWS) return answer("Импорт не найден",true);
 const [,kind,id] = match;
 const key = "import_pending:" + id;
 const raw = await env.REVIEWS.get(key);
 if (!raw) return answer("Публикация уже обработана или не найдена",true);
 const entry = JSON.parse(raw);
 const post = entry && entry.post ? entry.post : entry;
 if (kind === "car") await handleCarPost(post,env,adminIds);
 else if (kind === "news") await handleNewsPost(post,env,adminIds);
 else await handleImportedReview(post,env,adminIds);
 await env.REVIEWS.delete(key);
 return answer(kind === "car" ? "Передано в модерацию автомобилей" : (kind === "news" ? "Передано в модерацию новостей" : "Передано в модерацию отзывов"));
}

async function resendChannelImportEntry(entry, id, env, adminIds) {
 const post = entry && entry.post ? entry.post : entry;
 const keyboard = {inline_keyboard:[[{text:"🚗 Автомобиль",callback_data:"imp:car:" + id},{text:"⭐ Отзыв",callback_data:"imp:review:" + id},{text:"📰 Новость",callback_data:"imp:news:" + id}]]};
 const photos = postPhotos(post);
 const videos = postVideos(post);
 const caption = String(post.caption || post.text || "Без текста").slice(0,2500);
 await Promise.all(adminIds.map(async adminId => {
  await sendChannelMedia(env, adminId, photos, videos, post.caption ? String(post.caption) : "", post.mediaOrderKnown === true ? post.mediaItems : null);
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"🔁 Повторная пересылка из @avtoYkorea. Публикация ещё не опубликована; выберите действие.\n\n" + caption + "\n\nИсточник: https://t.me/" + (post.chat && post.chat.username || "avtoYkorea") + "/" + post.message_id,reply_markup:keyboard}); }));
}

// Другие части той же пересылки альбома: добавляем фото и видео к уже существующей записи, без новых карточек.
async function mergeChannelPartMedia(post, id, env) {
 const photos = [...largestPhotoOf(post.photo), ...(imageDocumentItemFrom(post.document) ? [imageDocumentItemFrom(post.document)] : [])];
 const videos = postVideos(post);
 const incomingItems = [...photos.map(item => ({...item,type:item.mime_type ? "document" : "photo",sourceMessageId:Number(post.message_id)||null})), ...videos.map(item => ({...item,type:"video",sourceMessageId:Number(post.message_id)||null}))];
 if (!photos.length && !videos.length) return;
 const importKey = "import_pending:" + id;
 const importRaw = await env.REVIEWS.get(importKey);
 if (importRaw) {
  const entry = JSON.parse(importRaw);
  const saved = entry.post || entry;
  const hadSavedMedia = (Array.isArray(saved.photo) && saved.photo.length) || (Array.isArray(saved.videos) && saved.videos.length);
  const hadCanonicalOrder = Array.isArray(saved.mediaItems) && saved.mediaItems.length > 0;
  saved.photo = uniqueFileItems([...(Array.isArray(saved.photo) ? saved.photo : []), ...photos]);
  saved.videos = uniqueFileItems([...(Array.isArray(saved.videos) ? saved.videos : []), ...videos]);
  const mergedOrder = mergeOrderedMediaItems(saved.mediaItems || [],incomingItems);
  saved.mediaItems = mergedOrder.mediaItems;
  saved.mediaOrderKnown = hadCanonicalOrder ? (saved.mediaOrderKnown === true && mergedOrder.mediaOrderKnown) : (!hadSavedMedia && mergedOrder.mediaOrderKnown);
  if (!saved.caption && post.caption) saved.caption = post.caption;
  entry.post = saved;
  entry.photo = saved.photo;
  entry.caption = saved.caption;
  await env.REVIEWS.put(importKey, JSON.stringify(entry), { expirationTtl: 2592000 });
  return;
 }
 const reviewKey = "pending:" + id;
 const reviewRaw = await env.REVIEWS.get(reviewKey);
 if (reviewRaw) {
  const review = JSON.parse(reviewRaw);
  const hadReviewMedia = (Array.isArray(review.photos) && review.photos.length) || (Array.isArray(review.videos) && review.videos.length) || Boolean(review.fileId);
  const hadCanonicalOrder = Array.isArray(review.mediaItems) && review.mediaItems.length > 0;
  review.photos = uniqueFileItems([...(Array.isArray(review.photos) ? review.photos : (review.fileId && review.kind !== "video" ? [{file_id:review.fileId}] : [])), ...photos]);
  review.videos = uniqueFileItems([...(Array.isArray(review.videos) ? review.videos : (review.kind === "video" && review.fileId ? [{file_id:review.fileId}] : [])), ...videos]);
  const mergedOrder = mergeOrderedMediaItems(review.mediaItems || [],incomingItems);
  review.mediaItems = mergedOrder.mediaItems;
  review.mediaOrderKnown = hadCanonicalOrder ? (review.mediaOrderKnown === true && mergedOrder.mediaOrderKnown) : (!hadReviewMedia && mergedOrder.mediaOrderKnown);
  review.hasPhoto = Boolean(review.photos.length);
  if (!review.fileId) review.fileId = (review.photos[0] || review.videos[0] || {}).file_id || null;
  await env.REVIEWS.put(reviewKey, JSON.stringify(review));
  return;
 }
 const number = messageNumberOf(id);
 const carKey = "car_pending:car_" + String(id).slice(0, String(id).lastIndexOf("_")).replace(/-/g,"") + "_" + number;
 const carRaw = await env.REVIEWS.get(carKey);
 if (carRaw) {
  const car = JSON.parse(carRaw);
  const hadCarMedia = (Array.isArray(car.photos) && car.photos.length) || (Array.isArray(car.videos) && car.videos.length) || Boolean(car.fileId);
  const hadCanonicalOrder = Array.isArray(car.mediaItems) && car.mediaItems.length > 0;
  car.photos = uniqueFileItems([...(Array.isArray(car.photos) ? car.photos : []), ...photos]);
  car.videos = uniqueFileItems([...(Array.isArray(car.videos) ? car.videos : []), ...videos]);
  const mergedOrder = mergeOrderedMediaItems(car.mediaItems || [],incomingItems);
  car.mediaItems = mergedOrder.mediaItems;
  car.mediaOrderKnown = hadCanonicalOrder ? (car.mediaOrderKnown === true && mergedOrder.mediaOrderKnown) : (!hadCarMedia && mergedOrder.mediaOrderKnown);
  if (!car.fileId) car.fileId = (car.photos[car.photos.length - 1] || car.videos[0] || {}).file_id || null;
  await env.REVIEWS.put(carKey, JSON.stringify(car));
  return;
 }
 const newsKey = "news_pending:news_" + String(id).slice(0, String(id).lastIndexOf("_")).replace(/-/g,"") + "_" + number;
 const newsRaw = await env.REVIEWS.get(newsKey);
 if (newsRaw) {
  const newsItem = JSON.parse(newsRaw);
  const hadMedia = (Array.isArray(newsItem.photos) && newsItem.photos.length) || (Array.isArray(newsItem.videos) && newsItem.videos.length) || Boolean(newsItem.fileId);
  const hadCanonicalOrder = Array.isArray(newsItem.mediaItems) && newsItem.mediaItems.length > 0;
  newsItem.photos = uniqueFileItems([...(Array.isArray(newsItem.photos) ? newsItem.photos : []), ...photos]);
  newsItem.videos = uniqueFileItems([...(Array.isArray(newsItem.videos) ? newsItem.videos : []), ...videos]);
  const mergedOrder = mergeOrderedMediaItems(newsItem.mediaItems || [], incomingItems);
  newsItem.mediaItems = mergedOrder.mediaItems;
  newsItem.mediaOrderKnown = hadCanonicalOrder ? (newsItem.mediaOrderKnown === true && mergedOrder.mediaOrderKnown) : (!hadMedia && mergedOrder.mediaOrderKnown);
  if (!newsItem.fileId) newsItem.fileId = (newsItem.photos[0] || newsItem.videos[0] || {}).file_id || null;
  await env.REVIEWS.put(newsKey, JSON.stringify(newsItem));
 }
}

async function stageChannelPost(post, env, adminIds) {
 const chat = post.chat || {};
 if (String(chat.username || "").toLowerCase() !== "avtoykorea" || !env.REVIEWS) return;
 const ownId = channelPostId(chat, post.message_id);
 const batchKey = post.media_group_id ? "import_batch:" + String(chat.id) + "_" + String(post.media_group_id) : null;
 const originKey = "import_origin:" + ownId;
 // Первая часть новой пересылки — батч; остальные части батча только дополняют запись.
 const batchRaw = batchKey ? await env.REVIEWS.get(batchKey) : null;
 const batch = batchRaw ? JSON.parse(batchRaw) : null;
 // Повтор того же update (после 502) узнаётся по id личного сообщения и заново доставляет карточку.
 const privateId = String(post.privateMessageId !== undefined ? post.privateMessageId : post.message_id);
 const id = (await env.REVIEWS.get(originKey)) || (batch && batch.id) || ownId;
 const batchStart = !batch || batch.start === privateId;
 if (batchKey && !batch) await env.REVIEWS.put(batchKey, JSON.stringify({ id, start: privateId }), { expirationTtl: 2592000 });
 await env.REVIEWS.put(originKey, id, { expirationTtl: 2592000 });
 if (!batchStart) {
  await mergeChannelPartMedia(post, id, env);
  return;
 }
 const number = messageNumberOf(id);
 const carId = "car_" + String(chat.id).replace(/-/g,"") + "_" + number;
 const newsId = "news_" + String(chat.id).replace(/-/g,"") + "_" + number;
 const approvedCar = await env.REVIEWS.get("car_approved:" + carId);
 const approvedNews = await env.REVIEWS.get("news_approved:" + newsId);
 if (await env.REVIEWS.get("approved:" + id) || approvedCar || approvedNews) {
  await Promise.all(adminIds.map(adminId => callTelegram(env,"sendMessage",{chat_id:adminId,text:"✅ Эта публикация уже опубликована на сайте. Повторная копия не создана: https://t.me/" + chat.username + "/" + number})));
  return;
 }
 const pendingReviewRaw = await env.REVIEWS.get("pending:" + id);
 if (pendingReviewRaw) {
  const deliveryKey = "review_delivery:" + id;
  const delivery = JSON.parse(await env.REVIEWS.get(deliveryKey) || "{}");
  delivery.admins = delivery.admins || {};
  for (const adminId of adminIds) {
   const status = delivery.admins[String(adminId)] || {mediaSent:true,cardSent:false};
   status.cardSent = false;
   delivery.admins[String(adminId)] = status;
  }
  await env.REVIEWS.put(deliveryKey,JSON.stringify(delivery),{expirationTtl:2592000});
  await handleImportedReview({...post,chat,message_id:Number(number)},env,adminIds);
  return;
 }
 const pendingCarRaw = await env.REVIEWS.get("car_pending:" + carId);
 if (pendingCarRaw) {
  const saved = JSON.parse(pendingCarRaw);
  const keyboard = {inline_keyboard:[[{text:"✅ Опубликовать",callback_data:"carpub:" + carId},{text:"❌ Отклонить",callback_data:"carrej:" + carId}],[{text:"✏️ Редактировать описание",callback_data:"caredit:" + carId}]]};
  await Promise.all(adminIds.map(async adminId => {
   await sendChannelMedia(env, adminId, postPhotos(saved), postVideos(saved), saved.caption || "", saved.mediaOrderKnown === true ? saved.mediaItems : null);
   await callTelegram(env,"sendMessage",{chat_id:adminId,text:"🔁 Повторная пересылка: автомобиль всё ещё ожидает решения модератора.\n\n" + (saved.caption || "Описание отсутствует") + "\n\nИсточник: " + saved.sourceUrl,reply_markup:keyboard});
  }));
  return;
 }
 const existingImport = await env.REVIEWS.get("import_pending:" + id);
 if (existingImport) {
  await resendChannelImportEntry(JSON.parse(existingImport),id,env,adminIds);
  return;
 }
 const photos = [...largestPhotoOf(post.photo), ...(imageDocumentItemFrom(post.document) ? [imageDocumentItemFrom(post.document)] : [])];
 const videos = postVideos(post);
 const mediaSeed = mergeOrderedMediaItems([], [...photos.map(item=>({...item,type:item.mime_type ? "document" : "photo",sourceMessageId:Number(post.message_id)||null})), ...videos.map(item=>({...item,type:"video",sourceMessageId:Number(post.message_id)||null}))]);
 const stored = {...post,chat,message_id:Number(number),albumId:post.media_group_id ? String(post.media_group_id) : "",photo:photos,videos,mediaItems:mediaSeed.mediaItems,mediaOrderKnown:mediaSeed.mediaOrderKnown};
 await env.REVIEWS.put("import_pending:" + id,JSON.stringify({...stored,post:stored}),{expirationTtl:2592000});
 const keyboard = {inline_keyboard:[[{text:"🚗 Автомобиль",callback_data:"imp:car:" + id},{text:"⭐ Отзыв",callback_data:"imp:review:" + id},{text:"📰 Новость",callback_data:"imp:news:" + id}]]};
 await Promise.all(adminIds.map(async adminId => {
  await sendChannelMedia(env, adminId, photos, videos, "", stored.mediaOrderKnown === true ? stored.mediaItems : null);
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"📥 Новая публикация из @avtoYkorea. Выберите раздел для импорта.\n\n" + String(post.caption || post.text || "Без текста").slice(0,2500) + "\n\nСнимки одного альбома объединяются в одну карточку.\nДата оригинала: " + (post.sourceDate ? new Date(post.sourceDate*1000).toLocaleString("ru-RU",{timeZone:"Europe/Moscow"}) : "не определена"),reply_markup:keyboard}); }));
}

// Администратор может отправить фото/видео в настроенную группу отзывов; публикация всё равно проходит личную модерацию.
async function stageGroupMedia(msg, env, adminIds) {
 const groupId = String(env.TELEGRAM_REVIEW_GROUP_ID || "").trim();
 if (!groupId || String(msg.chat && msg.chat.id) !== groupId || !env.REVIEWS) return false;
 const photos = largestPhotoOf(msg.photo);
 const documentPhoto = imageDocumentItemFrom(msg.document);
 if (documentPhoto) photos.push(documentPhoto);
 const videos = postVideos(msg);
 const incomingItems = [...photos.map(item=>({...item,type:item.mime_type ? "document" : "photo",sourceMessageId:Number(msg.message_id)||null})), ...videos.map(item=>({...item,type:"video",sourceMessageId:Number(msg.message_id)||null}))];
 if (!photos.length && !videos.length) return false;
 const id = reviewIdFor(msg.chat.id, msg);
 if (await env.REVIEWS.get("pending:" + id) || await env.REVIEWS.get("approved:" + id)) return true;
 const key = "import_pending:" + id;
 let state = JSON.parse(await env.REVIEWS.get(key) || "null");
 if (!state || !state.post) {
  const albumNumber = msg.media_group_id ? String(msg.media_group_id).replace(/[^0-9]/g, "").slice(0, 40) : String(msg.message_id);
  const ordered = mergeOrderedMediaItems([],incomingItems);
  state = {type:"group_media",post:{...msg,message_id:albumNumber,photo:photos,videos,mediaItems:ordered.mediaItems,mediaOrderKnown:ordered.mediaOrderKnown,sourceType:"group"},notified:{}};
 } else {
  const saved = state.post;
  saved.photo = uniqueFileItems([...(Array.isArray(saved.photo) ? saved.photo : []), ...photos]);
  saved.videos = uniqueFileItems([...(Array.isArray(saved.videos) ? saved.videos : []), ...videos]);
  const hadCanonicalOrder = Array.isArray(saved.mediaItems) && saved.mediaItems.length > 0;
  const merged = mergeOrderedMediaItems(saved.mediaItems || [],incomingItems);
  saved.mediaItems = merged.mediaItems;
  saved.mediaOrderKnown = hadCanonicalOrder ? (saved.mediaOrderKnown === true && merged.mediaOrderKnown) : false;
  if (!saved.caption && msg.caption) saved.caption = msg.caption;
  state.post = saved;
 }
 state.notified = state.notified || {};
 await env.REVIEWS.put(key,JSON.stringify(state),{expirationTtl:2592000});
 const keyboard = {inline_keyboard:[[{text:"⭐ Передать в модерацию отзывов",callback_data:"imp:review:" + id}]]};
 for (const adminId of adminIds) {
  const adminKey = String(adminId);
  const status = state.notified[adminKey] || {mediaSentIds:[],cardSent:false};
  status.mediaSentIds = Array.isArray(status.mediaSentIds) ? status.mediaSentIds : [];
  const mediaItems = state.post.mediaOrderKnown === true && Array.isArray(state.post.mediaItems)
   ? state.post.mediaItems
   : [...postPhotos(state.post), ...postVideos(state.post)];
  for (const item of mediaItems) {
   const identity = item.file_unique_id || item.file_id;
   if (status.mediaSentIds.includes(identity)) continue;
   const isVideo = state.post.videos && state.post.videos.some(video => video.file_id === item.file_id);
   const method = isVideo ? "sendVideo" : (item.mime_type ? "sendDocument" : "sendPhoto");
   const field = isVideo ? "video" : (item.mime_type ? "document" : "photo");
   await callTelegram(env,method,{chat_id:adminId,[field]:item.file_id});
   status.mediaSentIds.push(identity);
   state.notified[adminKey] = status;
   await env.REVIEWS.put(key,JSON.stringify(state),{expirationTtl:2592000});
  }
  if (!status.cardSent) {
   await callTelegram(env,"sendMessage",{chat_id:adminId,text:"📥 Медиа из группы отзывов. Выберите, передавать ли его на модерацию сайта.\n\n" + String(state.post.caption || "").slice(0,1000) + "\n\nФотографий: " + postPhotos(state.post).length + (postVideos(state.post).length ? "\nВидео: " + postVideos(state.post).length : ""),reply_markup:keyboard});
   status.cardSent = true;
  } else {
   await callTelegram(env,"sendMessage",{chat_id:adminId,text:"Добавлено медиа в альбом. Всего фотографий: " + postPhotos(state.post).length + (postVideos(state.post).length ? ", видео: " + postVideos(state.post).length : "") + ". Кнопка модерации осталась в предыдущем сообщении."});
  }
  state.notified[adminKey] = status;
  await env.REVIEWS.put(key,JSON.stringify(state),{expirationTtl:2592000});
 }
 return true;
}

async function stageGroupMediaSerialized(msg, env, adminIds) {
 if (!msg.media_group_id || !env.ALBUM_SERIALIZER) return stageGroupMedia(msg, env, adminIds);
 const albumKey = "review-group-media:" + String(msg.chat && msg.chat.id || "") + "_" + String(msg.media_group_id);
 const stub = env.ALBUM_SERIALIZER.get(env.ALBUM_SERIALIZER.idFromName(albumKey));
 const response = await stub.fetch("https://album.internal/process", {
  method: "POST", headers: {"content-type":"application/json"},
  body: JSON.stringify({type:"group_media",msg,adminIds})
 });
 if (!response.ok) throw new Error("Review group media serializer failed: " + response.status);
 return (await response.json()).handled === true;
}

async function handleCarCallback(callback, env, adminIds) {
 const answer = (text, alert=false) => callTelegram(env,"answerCallbackQuery",{callback_query_id:callback.id,text,show_alert:alert});
 const fromId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(fromId)) return answer("Нет доступа",true);
 const match = String(callback.data || "").match(/^car(pub|pubforce|rej|edit):(car_-?[0-9]+_[0-9]+)$/);
 if (!match || !env.REVIEWS) return answer("Объявление не найдено",true);
 const action = match[1], id = match[2];
 const raw = await env.REVIEWS.get("car_pending:" + id);
 if (!raw) return answer("Объявление уже обработано или не найдено",true);
 const car = JSON.parse(raw);
 if (action === "edit") return beginModerationEdit(callback, env, "car", id, answer);
 if (action === "rej") { await env.REVIEWS.delete("car_pending:" + id); await askRejectReason(env, fromId, id); return answer("Объявление отклонено"); }
 if (action === "pub") {
  const warnings = publishWarnings(car.caption, postPhotos(car).length + postVideos(car).length);
  if (warnings.length) { await askPublishCheck(env, fromId, "car", id, warnings); return answer("Проверьте перед публикацией"); }
 }
 await env.REVIEWS.put("car_approved:" + id,JSON.stringify({...car,publishedAt:new Date().toISOString()}));
 await env.REVIEWS.delete("car_pending:" + id);
 await writeLog(env, fromId, "опубликован", "машина", id, siteLabel(id, {caption: car.caption}));
 await offerUndo(env, fromId, id, { action: "unpublish" }, "🌐 Автомобиль опубликован на сайте.", [[{ text: "🗑 Убрать с сайта", callback_data: "sitedel:" + id }]]);
 return answer("Автомобиль опубликован на сайте");
}
// --- Заявки с сайта: карточка администраторам, кнопка «Принять в работу», ответ клиенту в Telegram ---
function formatOrderPrivate(order) {
 return ["🔐 Данные заявки №"+order.number,"Статус: "+order.status,"Имя: "+order.name,"Контакт: "+order.contact,"Telegram ID: "+(order.telegramId||"не привязан"),"Telegram: "+(order.username?"@"+order.username:"не указан"),"Марка / модель: "+(order.model||"не указано"),"Бюджет: "+(order.budget||"не указан"),"Страна: "+(order.country||"не указана"),"Год от: "+(order.year||"не указан"),"Тема: "+(order.purpose||"Подбор автомобиля"),"Пожелания: "+(order.details||"нет"),"Создана: "+order.createdAt].join("\n");
}
async function handleOrderCallback(callback, env, adminIds) {
 const answer=(text,alert=false)=>callTelegram(env,"answerCallbackQuery",{callback_query_id:callback.id,text,show_alert:alert});
 const fromId=String((callback.from&&callback.from.id)||"");
 if(!adminIds.includes(fromId))return answer("Нет доступа",true);
 const data=String(callback.data||""),match=data.match(/^ord:(\d+|[0-9a-f]{16}|[0-9a-f]{32})$/i),detail=data.match(/^ordinfo:(\d+|[0-9a-f]{16}|[0-9a-f]{32})$/i);
 if((!match&&!detail)||!env.REVIEWS)return answer("Заявка не найдена",true);
 const number=(match||detail)[1],raw=await env.REVIEWS.get((/^[0-9a-f]{16}$/i.test(number)?"order:":"order_no:")+number);
 if(!raw)return answer("Заявка не найдена",true);
 const order=JSON.parse(raw);
 const targetChat=callback.message&&callback.message.chat;
 if(!targetChat||targetChat.type!=="private"||String(targetChat.id)!==fromId)return answer("Откройте карточку в личном чате с ботом. Данные не отправлены.",true);
 if(detail){await callTelegram(env,"sendMessage",{chat_id:fromId,text:formatOrderPrivate(order)});return answer("Данные отправлены только вам");}
 if(order.status==="done")return answer("Заявка уже завершена");
 if(order.status!=="in_work"){
  order.status="in_work";order.acceptedBy=fromId;order.acceptedAt=new Date().toISOString();
  await env.REVIEWS.put("order_no:"+number,JSON.stringify(order));await env.REVIEWS.put("order:"+order.id,JSON.stringify(order));
  if(callback.message)await callTelegram(env,"editMessageReplyMarkup",{chat_id:callback.message.chat.id,message_id:callback.message.message_id,reply_markup:{inline_keyboard:[[{text:"🔐 Данные клиента",callback_data:"ordinfo:"+number},{text:"🏁 Завершить",callback_data:"orddone:"+number}]]}});
 }
 // If Telegram failed after the status was saved, a repeated callback retries this notification.
 if(order.chatId&&!order.acceptanceNotifiedAt){
  await callTelegram(env,"sendMessage",{chat_id:order.chatId,text:"Ваша заявка №"+(order.number||number)+" принята в работу. С вами свяжутся в этом чате."});
  order.acceptanceNotifiedAt=new Date().toISOString();
  await env.REVIEWS.put("order_no:"+number,JSON.stringify(order));await env.REVIEWS.put("order:"+order.id,JSON.stringify(order));
 }
 return answer(order.acceptanceNotifiedAt?"Заявка принята в работу":"Заявка принята; Telegram клиента ещё не подключён");
}
async function handleOrderDoneCallback(callback,env,adminIds){
 const answer=(text,alert=false)=>callTelegram(env,"answerCallbackQuery",{callback_query_id:callback.id,text,show_alert:alert});
 const fromId=String((callback.from&&callback.from.id)||"");if(!adminIds.includes(fromId))return answer("Нет доступа",true);
 const m=String(callback.data||"").match(/^orddone:(\d+)$/);if(!m||!env.REVIEWS)return answer("Заявка не найдена",true);
 const raw=await env.REVIEWS.get("order_no:"+m[1]);if(!raw)return answer("Заявка не найдена",true);
 const targetChat=callback.message&&callback.message.chat;if(!targetChat||targetChat.type!=="private"||String(targetChat.id)!==fromId)return answer("Откройте карточку в личном чате с ботом. Статус не изменён.",true);const order=JSON.parse(raw);if(order.status==="done")return answer("Заявка уже завершена");order.status="done";order.completedAt=new Date().toISOString();
 await env.REVIEWS.put("order_no:"+order.number,JSON.stringify(order));await env.REVIEWS.put("order:"+order.id,JSON.stringify(order));
 if(callback.message)await callTelegram(env,"editMessageReplyMarkup",{chat_id:callback.message.chat.id,message_id:callback.message.message_id,reply_markup:{inline_keyboard:[]}});
 return answer("Заявка завершена");
}

async function readBodyLimited(request, maxBytes) {
 const reader = request.body && request.body.getReader ? request.body.getReader() : null;
 if (!reader) return "";
 const chunks = []; let total = 0;
 try {
  while (true) {
   const part = await reader.read();
   if (part.done) break;
   total += part.value.byteLength;
   if (total > maxBytes) { await reader.cancel(); throw new Error("BODY_TOO_LARGE"); }
   chunks.push(part.value);
  }
 } finally { try { reader.releaseLock(); } catch {} }
 const merged = new Uint8Array(total); let offset = 0;
 for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
 return new TextDecoder("utf-8", {fatal:true}).decode(merged);
}

async function sha256Hex(value) {
 const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
 return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes = 32) {
 const data = new Uint8Array(bytes);
 crypto.getRandomValues(data);
 return Array.from(data, byte => byte.toString(16).padStart(2, "0")).join("");
}

function cookieValue(request, name) {
 const cookie = String(request.headers.get("Cookie") || "");
 const match = cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([a-f0-9]{64})(?:;|$)", "i"));
 return match ? match[1] : null;
}

function hasSameOrigin(request) {
 const origin = request.headers.get("Origin");
 return Boolean(origin && origin === new URL(request.url).origin);
}

async function resolveMaxBotUrl(env) {
 let candidate = "";
 if (env.REVIEWS) {
  try { candidate = String((await env.REVIEWS.get("site_config:max_bot_url")) || "").trim(); } catch {}
 }
 if (!candidate) candidate = String(env.MAX_BOT_URL || "").trim();
 return /^https:\/\/max\.ru\/[A-Za-z0-9_./?=-]+$/.test(candidate) ? candidate : "";
}

async function resolveYandexVerification(env) {
 let code = "";
 if (env.REVIEWS) {
  try { code = String((await env.REVIEWS.get("site_config:yandex_verification")) || "").trim(); } catch {}
 }
 if (!code) code = String(env.YANDEX_VERIFICATION || "").trim();
 return /^[A-Za-z0-9_-]{8,64}$/.test(code) ? code : "";
}

async function loadApprovedCarsForPublic(env) {
 if (!env.REVIEWS) return [];
 const cars = [];
 let cursor;
 do {
  const page = await env.REVIEWS.list({ prefix: "car_approved:", ...(cursor ? { cursor } : {}) });
  for (const key of page.keys) {
   const raw = await env.REVIEWS.get(key.name);
   if (!raw) continue;
   const car = JSON.parse(raw);
   if (String(car.caption || "").trim().toLowerCase() === "исправить") continue;
   const photoItems = catalogPhotoItems(car);
   const videoItems = uniqueFileItems(Array.isArray(car.videos) ? car.videos : (car.mediaType === "video" && car.fileId ? [{ file_id: car.fileId }] : []));
   const ordered = publicCarMediaOrder(car, photoItems, videoItems);
   const mediaItems = ordered.mediaItems;
   cars.push({
    id: car.id,
    caption: publicCarCaption(car.caption),
    media: mediaItems[0] ? mediaItems[0].url : null,
    mediaItems,
    mediaOrderKnown: ordered.mediaOrderKnown,
    mediaType: car.mediaType || "photo",
    publishedAt: car.publishedAt || ""
   });
  }
  cursor = page.list_complete ? null : page.cursor;
 } while (cursor);
 cars.sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));
 return cars;
}

async function loadApprovedNewsForPublic(env) {
 if (!env.REVIEWS) return [];
 const news = [];
 const seenBaseIds = new Set();
 let cursor;
 do {
  const page = await env.REVIEWS.list({ prefix: "news_approved:", ...(cursor ? { cursor } : {}) });
  for (const key of page.keys) {
   const raw = await env.REVIEWS.get(key.name);
   if (!raw) continue;
   const n = JSON.parse(raw);
   const photos = uniqueFileItems(Array.isArray(n.photos) && n.photos.length ? n.photos : (n.fileId && n.kind !== "video" ? [{ file_id: n.fileId }] : []));
   const videos = uniqueFileItems(Array.isArray(n.videos) && n.videos.length ? n.videos : (n.kind === "video" && n.fileId ? [{ file_id: n.fileId }] : []));
   const mediaItems = [
    ...photos.map((_, idx) => ({ url: `/api/news-media/${n.id}/photo/${idx}`, type: "photo" })),
    ...videos.map((_, idx) => ({ url: `/api/news-media/${n.id}/video/${idx}`, type: "video" }))
   ];
   seenBaseIds.add(String(n.id).replace(/^news_/, "").replace(/^-/, ""));
   if (n.originalReviewId) seenBaseIds.add(String(n.originalReviewId).replace(/^-/, ""));
   news.push({
    id: n.id,
    kind: videos.length && !photos.length ? "video" : "news",
    text: cleanCarDisplayCaption(cleanPublicationText(n.text || n.caption || "")),
    media: mediaItems[0] ? mediaItems[0].url : null,
    mediaItems,
    publishedAt: n.publishedAt || n.createdAt || ""
   });
  }
  cursor = page.list_complete ? null : page.cursor;
 } while (cursor);

 let revCursor;
 do {
  const revPage = await env.REVIEWS.list({ prefix: "approved:", ...(revCursor ? { cursor: revCursor } : {}) });
  for (const key of revPage.keys) {
   const raw = await env.REVIEWS.get(key.name);
   if (!raw) continue;
   const r = JSON.parse(raw);
   if (!isMarketNewsRecord(r)) continue;
   const cleanBase = String(r.id || "").replace(/^-/, "");
   if (seenBaseIds.has(cleanBase)) continue;
   const photos = uniqueFileItems(Array.isArray(r.photos) && r.photos.length ? r.photos : (r.fileId && r.kind !== "video" ? [{ file_id: r.fileId }] : []));
   const videos = uniqueFileItems(Array.isArray(r.videos) && r.videos.length ? r.videos : (r.kind === "video" && r.fileId ? [{ file_id: r.fileId }] : []));
   const ordered = publicReviewMediaOrder(r, photos, videos);
   const mediaItems = ordered.mediaItems.length
    ? ordered.mediaItems
    : [
       ...photos.map((_, idx) => ({ url: `/api/review-media/${r.id}/photo/${idx}`, type: "photo" })),
       ...videos.map((_, idx) => ({ url: `/api/review-media/${r.id}/video/${idx}`, type: "video" }))
      ];
   news.push({
    id: "news_" + cleanBase,
    kind: videos.length && !photos.length ? "video" : "news",
    text: cleanCarDisplayCaption(cleanPublicationText(r.text || "")),
    media: mediaItems[0] ? mediaItems[0].url : (r.fileId ? `/api/review-media/${r.id}` : null),
    mediaItems,
    publishedAt: r.publishedAt || r.createdAt || ""
   });
  }
  revCursor = revPage.list_complete ? null : revPage.cursor;
 } while (revCursor);
 news.sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));
 return news;
}

async function getWebAdminSession(request, env, adminIds) {
 if (!env.REVIEWS) return null;
 const token = cookieValue(request, "avtoy_admin");
 if (!token) return null;
 const tokenHash = await sha256Hex(token);
 const raw = await env.REVIEWS.get("admin_session:" + tokenHash);
 if (!raw) return null;
 let session;
 try { session = JSON.parse(raw); } catch { return null; }
 if (!session || !adminIds.includes(String(session.adminId))) return null;
 return { ...session, tokenHash };
}

async function issueAdminLoginCodeFor(env, adminId) {
 const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 100000000).padStart(8, "0");
 const codeHash = await sha256Hex(code);
 const currentKey = "admin_login_current:" + adminId;
 const oldHash = await env.REVIEWS.get(currentKey);
 if (oldHash) await env.REVIEWS.delete("admin_login:" + oldHash);
 await env.REVIEWS.put("admin_login:" + codeHash, JSON.stringify({ adminId: String(adminId) }), { expirationTtl: 300 });
 await env.REVIEWS.put(currentKey, codeHash, { expirationTtl: 300 });
 return {
  code,
  magicUrl: "https://avtoy-korea-auto.sokfrut.workers.dev/admin#code=" + code
 };
}

async function sendAdminLoginCode(env, adminId) {
 if (!env.REVIEWS) {
  return callTelegram(env, "sendMessage", { chat_id: adminId, text: "Хранилище REVIEWS не настроено. Вход в панель сайта недоступен." });
 }
 const { code, magicUrl } = await issueAdminLoginCodeFor(env, adminId);
 return callTelegram(env, "sendMessage", {
  chat_id: adminId,
  text: "🔐 ДОСТУП К ПАНЕЛИ AVTOY KOREA\n\nОткройте сайт: https://avtoy-korea-auto.sokfrut.workers.dev/admin\n\nКод входа: " + code + "\n\nКод одноразовый, действует 5 минут. Не пересылайте его другим людям.",
  reply_markup: {
   inline_keyboard: [[{ text: "🔐 Войти в Центр управления в 1 клик", url: magicUrl }]]
  }
 });
}

async function handleWebAdminApi(request, url, env, adminIds) {
 const path = url.pathname;
 if (!path.startsWith("/api/admin/")) return null;
 const baseHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer"
 };
 const json = (body, status = 200, extraHeaders = {}) => Response.json(body, {
  status,
  headers: { ...baseHeaders, ...extraHeaders }
 });
 if (!env.REVIEWS) return json({ error: "Admin storage unavailable" }, 503);

 if (path === "/api/admin/login" && request.method === "POST") {
  if (!hasSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const attemptKey = "admin_login_attempts:" + await sha256Hex(ip);
  const attempts = Number(await env.REVIEWS.get(attemptKey) || "0");
  if (attempts >= 10) return json({ error: "Too many attempts. Request a new code in Telegram later." }, 429);
  await env.REVIEWS.put(attemptKey, String(attempts + 1), { expirationTtl: 300 });
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const code = String(body && body.code || "").trim();
  if (!/^\d{8}$/.test(code)) return json({ error: "Invalid or expired code" }, 401);
  const codeHash = await sha256Hex(code);
  const raw = await env.REVIEWS.get("admin_login:" + codeHash);
  if (!raw) return json({ error: "Invalid or expired code" }, 401);
  let login;
  try { login = JSON.parse(raw); } catch { return json({ error: "Invalid or expired code" }, 401); }
  const adminId = String(login && login.adminId || "");
  const currentHash = await env.REVIEWS.get("admin_login_current:" + adminId);
  if (!adminIds.includes(adminId) || currentHash !== codeHash) return json({ error: "Invalid or expired code" }, 401);
  await env.REVIEWS.delete("admin_login:" + codeHash);
  await env.REVIEWS.delete("admin_login_current:" + adminId);
  await env.REVIEWS.delete(attemptKey);
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  await env.REVIEWS.put("admin_session:" + tokenHash, JSON.stringify({
   adminId,
   createdAt: new Date().toISOString()
  }), { expirationTtl: 28800 });
  return json({ authenticated: true }, 200, {
   "set-cookie": "avtoy_admin=" + token + "; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800"
  });
 }

 if (path === "/api/admin/session" && request.method === "GET") {
  const session = await getWebAdminSession(request, env, adminIds);
  return session ? json({ authenticated: true }) : json({ error: "Unauthorized" }, 401);
 }

 if (path === "/api/admin/logout" && request.method === "POST") {
  if (!hasSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const session = await getWebAdminSession(request, env, adminIds);
  if (session) await env.REVIEWS.delete("admin_session:" + session.tokenHash);
  return json({ ok: true }, 200, {
   "set-cookie": "avtoy_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0"
  });
 }

 const session = await getWebAdminSession(request, env, adminIds);
 if (!session) return json({ error: "Unauthorized" }, 401);

 if ((path === "/api/admin/items" || path === "/api/admin/dashboard") && request.method === "GET") {
  const items = [];
  for (const [prefix, kind] of [["car_approved:", "car"], ["news_approved:", "news"], ["approved:", "review"]]) {
   let cursor;
   do {
    const page = await env.REVIEWS.list({ prefix, ...(cursor ? { cursor } : {}) });
    for (const key of page.keys) {
     const raw = await env.REVIEWS.get(key.name);
     if (!raw) continue;
     let record;
     try { record = JSON.parse(raw); } catch { continue; }
     const id = key.name.slice(prefix.length);
     items.push(enrichAdminItem(id, record, kind, siteLabel));
     if (items.length >= 120) break;
    }
    cursor = items.length >= 120 || page.list_complete ? null : page.cursor;
   } while (cursor);
  }
  items.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  if (path === "/api/admin/items") return json({ items });

  const pending = [];
  for (const [prefix, kind] of [["car_pending:", "car"], ["news_pending:", "news"], ["pending:", "review"]]) {
   const page = await env.REVIEWS.list({ prefix });
   for (const key of page.keys.slice(0, 50)) {
    const raw = await env.REVIEWS.get(key.name);
    if (!raw) continue;
    try {
     const record = JSON.parse(raw);
     const id = key.name.slice(prefix.length);
     pending.push({
      id,
      kind,
      cleanTitle: siteLabel(id, record),
      label: siteLabel(id, record),
      text: String(kind === "car" ? record.caption || "" : record.text || record.caption || ""),
      mediaCount: (Array.isArray(record.photos) ? record.photos.length : 0) + (Array.isArray(record.videos) ? record.videos.length : 0),
      mediaItems: [],
      publishedAt: record.createdAt || ""
     });
    } catch {}
   }
  }

  const orders = [];
  const ordPage = await env.REVIEWS.list({ prefix: "order:" });
  for (const key of ordPage.keys.slice(0, 100)) {
   const raw = await env.REVIEWS.get(key.name);
   if (!raw) continue;
   try { orders.push(JSON.parse(raw)); } catch {}
  }
  orders.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const [maxBotUrl, yandexVerification] = await Promise.all([resolveMaxBotUrl(env), resolveYandexVerification(env)]);
  return json({ items, pending, orders, maxBotUrl, yandexVerification });
 }

 if (path === "/api/admin/settings" && request.method === "POST") {
  if (!hasSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  let body = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  if (Object.hasOwn(body || {}, "maxBotUrl")) {
   const rawUrl = String(body.maxBotUrl || "").trim();
   if (rawUrl && !/^https:\/\/max\.ru\/[A-Za-z0-9_./?=-]+$/.test(rawUrl)) {
    return json({ error: "Укажите ссылку вида https://max.ru/..." }, 400);
   }
   if (rawUrl) await env.REVIEWS.put("site_config:max_bot_url", rawUrl);
   else await env.REVIEWS.delete("site_config:max_bot_url");
   await writeLog(env, session.adminId, "обновлена ссылка MAX", "настройки", "max_bot_url", rawUrl || "очищено");
  }
  if (Object.hasOwn(body || {}, "yandexVerification")) {
   const rawYandex = String(body.yandexVerification || "").trim();
   if (rawYandex && !/^[A-Za-z0-9_-]{8,64}$/.test(rawYandex)) {
    return json({ error: "Код Яндекс.Вебмастер должен состоять из 8–64 латинских букв/цифр" }, 400);
   }
   if (rawYandex) await env.REVIEWS.put("site_config:yandex_verification", rawYandex);
   else await env.REVIEWS.delete("site_config:yandex_verification");
   await writeLog(env, session.adminId, "обновлён код Яндекс.Вебмастер", "настройки", "yandex_verification", rawYandex || "очищено");
  }
  return json({
   ok: true,
   maxBotUrl: await resolveMaxBotUrl(env),
   yandexVerification: await resolveYandexVerification(env)
  });
 }

 if (path === "/api/admin/news" && request.method === "POST") {
  if (!hasSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  let body = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const cleaned = cleanCarDisplayCaption(cleanPublicationText(String(body?.text || ""))).slice(0, 3000);
  if (!cleaned) return json({ error: "Введите текст новости" }, 400);
  const id = "news_admin_" + Date.now();
  const newsRec = {
   id,
   category: "news",
   kind: "text",
   text: cleaned,
   photos: [],
   videos: [],
   publishedAt: new Date().toISOString()
  };
  await env.REVIEWS.put("news_approved:" + id, JSON.stringify(newsRec));
  await writeLog(env, session.adminId, "опубликована через веб-панель", "новость", id, siteLabel(id, newsRec));
  return json({ ok: true, id });
 }

 if (path === "/api/admin/cleanup" && request.method === "POST") {
  if (!hasSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const res = await runAdminCatalogCleanup(env, session.adminId, writeLog);
  return json({ ok: true, ...res });
 }

 const moveMatch = path.match(/^\/api\/admin\/items\/(news_[A-Za-z0-9_-]+|-?\d+_\d+)\/move$/);
 if (moveMatch && request.method === "POST") {
  if (!hasSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const id = moveMatch[1];
  let body = {};
  try { body = await request.json(); } catch {}
  const targetKind = body?.targetKind === "news" ? "news" : (body?.targetKind === "review" ? "review" : "");
  if (!targetKind) return json({ error: "Invalid targetKind" }, 400);
  if (targetKind === "news" && !id.startsWith("news_")) {
   const raw = await env.REVIEWS.get("approved:" + id);
   if (!raw) return json({ error: "Review not found" }, 404);
   const rev = JSON.parse(raw);
   const newId = "news_" + id.replace(/^-/, "");
   const newsRec = { ...rev, id: newId, originalReviewId: id, category: "news", publishedAt: rev.publishedAt || new Date().toISOString() };
   await env.REVIEWS.put("news_approved:" + newId, JSON.stringify(newsRec));
   await env.REVIEWS.delete("approved:" + id);
   await writeLog(env, session.adminId, "перенесено из отзывов в новости", "новость", newId, siteLabel(newId, newsRec));
   return json({ ok: true, id: newId });
  }
  if (targetKind === "review" && id.startsWith("news_")) {
   const raw = await env.REVIEWS.get("news_approved:" + id);
   if (!raw) return json({ error: "News item not found" }, 404);
   const rec = JSON.parse(raw);
   const revId = rec.originalReviewId || (/^\d+_\d+$/.test(id.slice(5)) ? id.slice(5) : "0_" + Date.now());
   const revRec = { ...rec, id: revId, category: "review", publishedAt: rec.publishedAt || new Date().toISOString() };
   delete revRec.originalReviewId;
   await env.REVIEWS.put("approved:" + revId, JSON.stringify(revRec));
   await env.REVIEWS.delete("news_approved:" + id);
   await writeLog(env, session.adminId, "перенесено из новостей в отзывы", "отзыв", revId, siteLabel(revId, revRec));
   return json({ ok: true, id: revId });
  }
  return json({ ok: true, id });
 }

 const pendingPubMatch = path.match(/^\/api\/admin\/pending\/(car_-?\d+_\d+|news_[A-Za-z0-9_-]+|-?\d+_\d+)\/publish$/);
 if (pendingPubMatch && request.method === "POST") {
  if (!hasSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const id = pendingPubMatch[1];
  let body = {};
  try { body = await request.json(); } catch {}
  const isCar = id.startsWith("car_") || body.kind === "car";
  const isNews = !isCar && (id.startsWith("news_") || body.kind === "news");
  const pendKey = (id.startsWith("car_") ? "car_pending:" : (id.startsWith("news_") ? "news_pending:" : "pending:")) + id;
  const raw = await env.REVIEWS.get(pendKey);
  if (!raw) return json({ error: "Pending item not found" }, 404);
  const rec = JSON.parse(raw);
  const customText = typeof body.text === "string" ? cleanPublicationText(body.text) : null;
  if (isCar) {
   const carId = id.startsWith("car_") ? id : "car_" + id.replace(/-/g, "");
   if (customText !== null) rec.caption = cleanCarDisplayCaption(customText).slice(0, 3000);
   rec.id = carId;
   rec.publishedAt = new Date().toISOString();
   await env.REVIEWS.put("car_approved:" + carId, JSON.stringify(rec));
  } else if (isNews) {
   const newsId = id.startsWith("news_") ? id : "news_" + id.replace(/-/g, "");
   if (customText !== null) rec.text = cleanCarDisplayCaption(customText).slice(0, 3000);
   rec.id = newsId;
   rec.category = "news";
   rec.publishedAt = new Date().toISOString();
   await env.REVIEWS.put("news_approved:" + newsId, JSON.stringify(rec));
  } else {
   if (customText !== null) rec.text = customText.slice(0, 1000);
   rec.publishedAt = new Date().toISOString();
   await env.REVIEWS.put("approved:" + id, JSON.stringify(rec));
  }
  await env.REVIEWS.delete(pendKey);
  await writeLog(env, session.adminId, "опубликован через веб-панель", isCar ? "машина" : (isNews ? "новость" : "отзыв"), id, "");
  return json({ ok: true });
 }

 const pendingDelMatch = path.match(/^\/api\/admin\/pending\/(car_-?\d+_\d+|news_[A-Za-z0-9_-]+|-?\d+_\d+)$/);
 if (pendingDelMatch && request.method === "DELETE") {
  if (!hasSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const id = pendingDelMatch[1];
  await env.REVIEWS.delete((id.startsWith("car_") ? "car_pending:" : (id.startsWith("news_") ? "news_pending:" : "pending:")) + id);
  return json({ ok: true });
 }

 const orderPatchMatch = path.match(/^\/api\/admin\/orders\/([A-Za-z0-9_-]{6,64})$/);
 if (orderPatchMatch && request.method === "PATCH") {
  if (!hasSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  let body = {};
  try { body = await request.json(); } catch {}
  const status = String(body.status || "");
  if (!["new", "in_work", "done"].includes(status)) return json({ error: "Invalid status" }, 400);
  const id = orderPatchMatch[1];
  const raw = await env.REVIEWS.get("order:" + id);
  if (!raw) return json({ error: "Order not found" }, 404);
  const ord = JSON.parse(raw);
  ord.status = status;
  ord.updatedAt = new Date().toISOString();
  await env.REVIEWS.put("order:" + id, JSON.stringify(ord));
  if (ord.number) await env.REVIEWS.put("order_no:" + ord.number, JSON.stringify(ord));
  return json({ ok: true });
 }

 const itemMatch = path.match(/^\/api\/admin\/items\/(car_-?\d+_\d+|news_[A-Za-z0-9_-]+|-?\d+_\d+)$/);
 if (itemMatch && request.method === "PATCH") {
  if (!hasSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const id = itemMatch[1];
  const isCar = id.startsWith("car_");
  const isNews = id.startsWith("news_");
  const key = (isCar ? "car_approved:" : (isNews ? "news_approved:" : "approved:")) + id;
  const raw = await env.REVIEWS.get(key);
  if (!raw) return json({ error: "Publication not found" }, 404);
  const record = JSON.parse(raw);

  if (isCar && Number.isInteger(body?.setCoverPhotoIndex) && Array.isArray(record.photos)) {
   const idx = body.setCoverPhotoIndex;
   if (idx >= 0 && idx < record.photos.length) {
    const [picked] = record.photos.splice(idx, 1);
    record.photos.unshift(picked);
    record.mediaOrderKnown = false;
    record.editedAt = new Date().toISOString();
    await env.REVIEWS.put(key, JSON.stringify(record));
    return json({ ok: true });
   }
  }

  if (isCar && Number.isInteger(body?.deletePhotoIndex) && Array.isArray(record.photos)) {
   const idx = body.deletePhotoIndex;
   if (idx >= 0 && idx < record.photos.length && record.photos.length > 1) {
    removePhotosAt(record, [idx + 1]);
    record.editedAt = new Date().toISOString();
    await env.REVIEWS.put(key, JSON.stringify(record));
    return json({ ok: true });
   }
  }

  let edited;
  if (typeof body?.directText === "string") {
   edited = (isCar || isNews) ? cleanCarDisplayCaption(cleanPublicationText(body.directText)) : cleanPublicationText(body.directText);
  } else {
   const currentText = String(isCar ? record.caption || "" : record.text || record.caption || "");
   const instruction = String(body && body.instruction || "").trim();
   if (!instruction) return json({ error: "Text is required" }, 400);
   const edit = applyModerationTextEdit(currentText, instruction);
   if (edit.error) return json({ error: edit.error }, 422);
   edited = cleanPublicationText(edit.text);
   if (!edited) return json({ error: "Publication text cannot be empty" }, 422);
  }

  if (isCar) {
   record.originalCaption = record.originalCaption === undefined ? record.caption : record.originalCaption;
   record.caption = String(edited || "").slice(0, 3000);
  } else if (isNews) {
   record.originalText = record.originalText === undefined ? record.text : record.originalText;
   record.text = String(edited || "").slice(0, 3000);
  } else {
   record.originalText = record.originalText === undefined ? record.text : record.originalText;
   record.text = String(edited || "").slice(0, 1000);
   record.hasThanks = THANKS_PATTERN.test(record.text);
  }
  record.editedAt = new Date().toISOString();
  record.editedBy = session.adminId;
  await env.REVIEWS.put(key, JSON.stringify(record));
  await writeLog(env, session.adminId, "изменён текст через веб-панель", isCar ? "машина" : (isNews ? "новость" : "отзыв"), id, siteLabel(id, record));
  return json({ ok: true });
 }

 if (itemMatch && request.method === "DELETE") {
  if (!hasSameOrigin(request)) return json({ error: "Same-origin request required" }, 403);
  const id = itemMatch[1];
  const record = await unpublishItem(env, adminIds, id);
  if (!record) return json({ error: "Publication not found" }, 404);
  await writeLog(env, session.adminId, "снят с сайта через веб-панель", id.startsWith("car_") ? "машина" : (id.startsWith("news_") ? "новость" : "отзыв"), id, siteLabel(id, record));
  return json({ ok: true });
 }
 return json({ error: "Not found" }, 404);
}

const ADMIN_PAGE_HTML = ADMIN_PRO_HTML;

export default {
 async fetch(request, env) {
  const url = new URL(request.url);
  // Admins must be private Telegram user IDs (positive numbers), comma- or space-separated.
  // TELEGRAM_CHAT_ID remains as a legacy fallback for one private admin only.
  const adminIds = [...new Set(
   String(env.TELEGRAM_ADMIN_IDS || env.TELEGRAM_ADMIN_USER_ID || env.TELEGRAM_CHAT_ID || "")
    .split(/[\s,]+/)
    .map(id => id.trim())
    .filter(id => /^\d+$/.test(id) && Number(id) > 0)
  )];

  // MAX messenger bot webhook (parallel Russian channel alongside Telegram).
  if (request.method === "POST" && (url.pathname === "/max/webhook" || url.pathname === "/api/max/webhook")) {
   return handleMaxBotWebhook(request, env, {
    callTelegram,
    telegramAdminIds: adminIds,
    unpublishById: id => unpublishItem(env, adminIds, id),
    issueAdminMagicLink: () => issueAdminLoginCodeFor(env, adminIds[0] || "max_admin"),
    cleanupCatalog: () => runAdminCatalogCleanup(env, adminIds[0] || "max_admin", writeLog)
   });
  }
  if (request.method === "OPTIONS" && (url.pathname === "/api/request" || url.pathname === "/api/cars" || url.pathname === "/api/reviews" || url.pathname === "/api/news" || url.pathname === "/api/public-config")) {
   return new Response(null, { status: 204, headers: resolveMirrorCorsHeaders(request, env) });
  }

  // Telegram bot webhook. Configure TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_IDS and
  // TELEGRAM_WEBHOOK_SECRET as Cloudflare Worker secrets/variables.
  if (request.method === "POST" && url.pathname === "/telegram/webhook") {
   const expectedSecret = env.TELEGRAM_WEBHOOK_SECRET;
   const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
   if (!expectedSecret || suppliedSecret !== expectedSecret) {
    return new Response("Unauthorized", { status: 401 });
   }
   if (!env.TELEGRAM_BOT_TOKEN || adminIds.length === 0) {
    return new Response("Bot configuration missing", { status: 503 });
   }
   const webhookLength = Number(request.headers.get("content-length") || 0);
   if (webhookLength > 65536) return new Response("Payload Too Large", { status: 413 });
   let webhookRaw;
   try { webhookRaw = await readBodyLimited(request,65536); } catch (e) { return new Response(e && e.message === "BODY_TOO_LARGE" ? "Payload Too Large" : "Bad Request", { status: e && e.message === "BODY_TOO_LARGE" ? 413 : 400 }); }
   if (new TextEncoder().encode(webhookRaw).byteLength > 65536) return new Response("Payload Too Large", { status: 413 });
   let update;
   try { update = JSON.parse(webhookRaw); } catch {
    return new Response("Bad Request", { status: 400 });
   }
   if (!update || typeof update !== "object" || Array.isArray(update)) return new Response("Bad Request", { status: 400 });
   if (update.callback_query) {
    const cb = update.callback_query;
    const callbackChat = cb.message && cb.message.chat;
    const callbackUserId = String((cb.from && cb.from.id) || "");
    if (!adminIds.includes(callbackUserId)) {
     try { await callTelegram(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Нет доступа", show_alert: true }); } catch {}
     return Response.json({ ok: true });
    }
    if (!callbackChat || callbackChat.type !== "private" || String(callbackChat.id) !== callbackUserId) {
     try { await callTelegram(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Административные кнопки доступны только в личном чате с ботом.", show_alert: true }); } catch {}
     return Response.json({ ok: true });
    }
    try {
     if (String(cb.data || "").startsWith("ord:") || String(cb.data || "").startsWith("ordinfo:")) await handleOrderCallback(cb, env, adminIds);
      else if (String(cb.data || "").startsWith("orddone:")) await handleOrderDoneCallback(cb, env, adminIds);
     else if (String(cb.data || "").startsWith("imp:")) await handleImportChoice(cb, env, adminIds);
     else if (String(cb.data || "").startsWith("siteedit:")) await handleSiteEditCallback(cb, env, adminIds);
     else if (String(cb.data || "").startsWith("sitedel")) await handleSiteDeleteCallback(cb, env, adminIds);
     else if (String(cb.data || "").startsWith("mphoto:")) await handlePhotoDeleteCallback(cb, env, adminIds);
     else if (String(cb.data || "") === "adminhelp") { await callTelegram(env, "answerCallbackQuery", { callback_query_id: cb.id }); await sendAdminHelp(env, cb.message.chat.id); }
     else if (String(cb.data || "") === "admincmd:site") { await callTelegram(env, "answerCallbackQuery", { callback_query_id: cb.id }); await showSiteList(cb.message.chat.id, env); }
     else if (String(cb.data || "").startsWith("panel:")) {
      const sub = String(cb.data).slice("panel:".length);
      if (sub === "noop") { await callTelegram(env, "answerCallbackQuery", { callback_query_id: cb.id }); }
      else if (sub === "cleanall") {
       const res = await runAdminCatalogCleanup(env, callbackUserId, writeLog);
       await callTelegram(env, "answerCallbackQuery", { callback_query_id: cb.id, text: `Очищено авто: ${res.cleanedCars}, в новости: ${res.movedToNews || 0}, снято битых: ${res.removedBroken}`, show_alert: true });
       await sendOrEditTelegramPanel(env, cb.message.chat.id, cb.message.message_id, "home", { callTelegram, siteLabel, sha256Hex });
      } else {
       await callTelegram(env, "answerCallbackQuery", { callback_query_id: cb.id });
       await sendOrEditTelegramPanel(env, cb.message.chat.id, cb.message.message_id, sub, { callTelegram, siteLabel, sha256Hex });
      }
     }
     else if (String(cb.data || "").startsWith("pubascar:")) {
      const pendId = String(cb.data).slice("pubascar:".length);
      const pendRaw = env.REVIEWS ? await env.REVIEWS.get("pending:" + pendId) : null;
      if (!pendRaw) { await callTelegram(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Материал уже обработан", show_alert: true }); }
      else {
       const rev = JSON.parse(pendRaw);
       const carId = "car_" + pendId.replace(/-/g, "");
       const carRec = {
        id: carId,
        caption: cleanCarDisplayCaption(cleanPublicationText(rev.text || "")).slice(0, 3000),
        fileId: rev.fileId || null,
        photos: Array.isArray(rev.photos) ? rev.photos : [],
        videos: rev.kind === "video" && rev.fileId ? [{ file_id: rev.fileId }] : (Array.isArray(rev.videos) ? rev.videos : []),
        mediaType: rev.kind === "video" && !(rev.photos && rev.photos.length) ? "video" : "photo",
        publishedAt: new Date().toISOString(),
        sourceUrl: rev.sourceUrl || "Загрузка администратора"
       };
       await env.REVIEWS.put("car_approved:" + carId, JSON.stringify(carRec));
       await env.REVIEWS.delete("pending:" + pendId);
       const upRaw = await env.REVIEWS.get("admin_upload:" + pendId);
       if (upRaw) { const st = JSON.parse(upRaw); st.status = "approved"; await env.REVIEWS.put("admin_upload:" + pendId, JSON.stringify(st), { expirationTtl: 2592000 }); }
       await writeLog(env, callbackUserId, "опубликован как авто из лички", "машина", carId, siteLabel(carId, carRec));
       await callTelegram(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "🚘 Автомобиль опубликован в каталог!" });
       await callTelegram(env, "sendMessage", { chat_id: cb.message.chat.id, text: "🚘 Автомобиль успешно добавлен в каталог сайта!", reply_markup: { inline_keyboard: [[{ text: "🗑 Снять с сайта", callback_data: "sitedel:" + carId }, { text: "🎛 Панель", callback_data: "panel:home" }]] } });
      }
     }
     else if (String(cb.data || "").startsWith("pubasnews:")) {
      const pendId = String(cb.data).slice("pubasnews:".length);
      const pendRaw = env.REVIEWS ? await env.REVIEWS.get("pending:" + pendId) : null;
      if (!pendRaw) { await callTelegram(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "Материал уже обработан", show_alert: true }); }
      else {
       const rev = JSON.parse(pendRaw);
       const newsId = "news_" + pendId.replace(/-/g, "");
       const newsRec = {
        id: newsId,
        category: "news",
        kind: rev.kind === "video" ? "video" : "text",
        text: cleanCarDisplayCaption(cleanPublicationText(rev.text || "")).slice(0, 3000),
        fileId: rev.fileId || null,
        photos: Array.isArray(rev.photos) ? rev.photos : [],
        videos: rev.kind === "video" && rev.fileId ? [{ file_id: rev.fileId }] : (Array.isArray(rev.videos) ? rev.videos : []),
        publishedAt: new Date().toISOString(),
        sourceUrl: rev.sourceUrl || "Загрузка администратора"
       };
       await env.REVIEWS.put("news_approved:" + newsId, JSON.stringify(newsRec));
       await env.REVIEWS.delete("pending:" + pendId);
       const upRaw = await env.REVIEWS.get("admin_upload:" + pendId);
       if (upRaw) { const st = JSON.parse(upRaw); st.status = "approved"; await env.REVIEWS.put("admin_upload:" + pendId, JSON.stringify(st), { expirationTtl: 2592000 }); }
       await writeLog(env, callbackUserId, "опубликована как новость из лички", "новость", newsId, siteLabel(newsId, newsRec));
       await callTelegram(env, "answerCallbackQuery", { callback_query_id: cb.id, text: "📰 Новость опубликована на сайт!" });
       await callTelegram(env, "sendMessage", { chat_id: cb.message.chat.id, text: "📰 Новость успешно добавлена в раздел «Новости» на сайте!", reply_markup: { inline_keyboard: [[{ text: "🗑 Снять с сайта", callback_data: "sitedel:" + newsId }, { text: "🎛 Панель", callback_data: "panel:home" }]] } });
      }
     }
     else if (String(cb.data || "").startsWith("rejr:")) await handleRejectReasonCallback(cb, env, adminIds);
     else if (String(cb.data || "").startsWith("undo:")) await handleUndoCallback(cb, env, adminIds);
     else if (String(cb.data || "").startsWith("car")) await handleCarCallback(cb, env, adminIds);
     else if (String(cb.data || "").startsWith("news")) await handleNewsCallback(cb, env, adminIds);
     else await handleReviewCallback(cb, env, adminIds);
    } catch { return new Response("Telegram processing failed", { status: 502 }); }
    return Response.json({ ok: true });
   }
   const channelPost = update.channel_post;
   if (channelPost) { try { await stageChannelPostSerialized({...channelPost,sourceDate:channelPost.date}, env, adminIds); } catch { return new Response("Telegram import staging failed", {status:502}); } return Response.json({ok:true}); }
   const msg = update.message;
   if (!msg || !msg.chat || !msg.chat.id) return Response.json({ ok: true });
   // Groups/channels: only the one review group, only /review messages. Everything else is ignored.
   if (msg.chat.type !== "private") {
    try {
     if (adminIds.includes(String((msg.from && msg.from.id) || ""))) await stageGroupMediaSerialized(msg, env, adminIds);
     await handleReviewSubmission(msg, env, adminIds);
    } catch { return new Response("Telegram processing failed", { status: 502 }); }
    return Response.json({ ok: true });
   }
   const chatId = String(msg.chat.id);
   const text = String(msg.text || "").trim();
   const origin = msg.forward_origin || null;
   const api = async (method, payload) => {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
     method: "POST",
     headers: { "content-type": "application/json" },
     body: JSON.stringify(payload)
    });
    if (!response.ok) throw new Error("Telegram API request failed");
    const result = await response.json();
    if (!result || result.ok !== true) throw new Error("Telegram API rejected the request");
    return result;
   };
   const send = (target, body) => api("sendMessage", {
    chat_id: target, text: body, disable_web_page_preview: true
   });
   try {
    if (await handleForwardedGroupPostSerialized(msg, env, adminIds)) return Response.json({ok:true});
    if (await handleAdminMediaUpload(msg, env, adminIds)) return Response.json({ok:true});
    if (await handleAdminModerationEditReply(msg, env, adminIds)) return Response.json({ok:true});
    // /myid returns only the sender's own numeric Telegram ID for safe admin configuration.
    if (/^\/myid(?:@\w+)?$/i.test(text)) {
     await send(chatId, "Ваш Telegram ID: " + chatId + "\nПередайте этот номер владельцу настройки TELEGRAM_ADMIN_IDS. Не отправляйте токен бота.");
    } else if (adminIds.includes(chatId) && msg.reply_to_message) {
     const repliedText = String(msg.reply_to_message.text || msg.reply_to_message.caption || "");
     const orderMatch = repliedText.match(/Заявка:\s*([0-9a-f]{16})/i);
     const orderNumberMatch = repliedText.match(/Заявка\s*№\s*(\d+)/i);
     if ((orderMatch || orderNumberMatch) && env.REVIEWS) {
      const rawOrder = await env.REVIEWS.get(orderNumberMatch ? "order_no:" + orderNumberMatch[1] : "order:" + orderMatch[1]);
      if (rawOrder) {
       const order = JSON.parse(rawOrder);
       if (order.chatId) {
        if (!text.trim()) {
         await send(chatId, "Ответ пустой. Напишите текст сообщения клиенту и отправьте его ещё раз.");
        } else {
         await send(order.chatId, text.trim());
         await send(chatId, "Ответ отправлен клиенту по заявке " + order.id + ".");
        }
       } else {
        await send(chatId, "У клиента нет подключённого Telegram. Свяжитесь с ним по контакту из заявки: " + order.contact);
       }
      } else await send(chatId, "Заявка не найдена в хранилище.");
     } else {
      const chatMatch = repliedText.match(/Chat ID:\s*(-?\d+)/i);
      if (chatMatch && text) {
       await send(chatMatch[1], text);
       await send(chatId, "Ответ отправлен клиенту.");
      } else await send(chatId, "Не удалось определить клиента. Ответьте через Reply на карточку заявки или уведомление бота.");
     }
    } else if (adminIds.includes(chatId) && origin && origin.type === "channel") {
     const sourceChat = origin.chat || {};
     if (String(sourceChat.username || "").toLowerCase() !== "avtoykorea") {
      await send(chatId, "Переслано сообщение не из канала @avtoYkorea. Для импорта перешлите публикацию именно из этого канала, не копируйте её текст.");
     } else {
      await stageChannelPost({...msg, chat: sourceChat, message_id: origin.message_id, sourceDate: origin.date || 0, privateMessageId: msg.message_id}, env, adminIds);
     }
    } else if (text.startsWith("/reply") && adminIds.includes(chatId)) {
     const match = text.match(/^\/reply\s+(-?\d+)\s+([\s\S]+)$/);
     if (!match) {
      await send(chatId, "Формат ответа: /reply CHAT_ID текст сообщения");
     } else {
      await send(match[1], match[2]);
      await send(chatId, "Ответ отправлен.");
     }
    } else if (/^\/start order_[0-9a-f]{64}$/.test(text)) {
     // Одноразовый bearer-токен: 256 бит случайности, срок действия 7 дней.
     const bindToken = text.slice("/start order_".length);
     const tokenKey = `bind_token:${bindToken}`;
     const orderId = env.REVIEWS ? await env.REVIEWS.get(tokenKey) : null;
     const raw = orderId ? await env.REVIEWS.get(`order:${orderId}`) : null;
     if (!raw) {
      await send(chatId, "Ссылка недействительна или уже использована. Оставьте заявку на сайте ещё раз.");
     } else {
      const order = JSON.parse(raw);
      const senderId = String((msg.from && msg.from.id) || "");
      if (!senderId || senderId !== chatId) {
       await send(chatId, "Не удалось подтвердить личный Telegram-чат. Откройте ссылку из личного чата с ботом.");
      } else if (order.telegramId && String(order.telegramId) !== senderId) {
       await send(chatId, "К заявке уже привязан другой Telegram-аккаунт. Свяжитесь с менеджером.");
      } else {
       order.chatId = chatId;
       order.telegramId = senderId;
       order.username = msg.from && msg.from.username ? String(msg.from.username).slice(0, 64) : null;
       await env.REVIEWS.put(`order:${orderId}`, JSON.stringify(order));
       await env.REVIEWS.put(`order_no:${order.number}`, JSON.stringify(order));
       // Keep the one-time token until both order indexes are saved and the confirmation is sent.
       // If a KV write or Telegram send fails, Telegram can retry this update using the same token.
       await send(chatId, "Спасибо! Ваш Telegram подключён к заявке. С вами свяжутся в этом чате.");
       await env.REVIEWS.delete(tokenKey);
      }
     }
    } else if (text === "/start" || text.startsWith("/start ")) {
     if (adminIds.includes(chatId)) await setAdminCommands(env, chatId).catch(() => {});
     await send(chatId, "Здравствуйте! Это AVTOY KOREA 🚘\n\nПомогаем с подбором автомобилей из Кореи, Китая и ОАЭ.\n\nКоманды:\n/countries — страны покупки\n/catalog — как проходит подбор\n/contact — оставить заявку\n/help — помощь\n\nНапишите, какой автомобиль ищете, и мы передадим запрос менеджеру.");
     if (!adminIds.includes(chatId)) {
      const notice = "👋 Новый пользователь бота AVTOY KOREA\nИмя: " + String((msg.from && (msg.from.first_name || msg.from.username)) || "не указано") + "\nChat ID: " + chatId;
      await Promise.all(adminIds.map(id => send(id, notice)));
     }
    } else if (/^\/news(?:@\w+)?(?:\s+([\s\S]+))?$/i.test(text) && adminIds.includes(chatId)) {
     const m = text.match(/^\/news(?:@\w+)?(?:\s+([\s\S]+))?$/i);
     const rawBody = m && m[1] ? cleanCarDisplayCaption(cleanPublicationText(m[1])).slice(0, 3000) : "";
     if (!rawBody) {
      await send(chatId, "📰 Как разместить новость на сайте:\n\n1️⃣ С фото или видео — просто отправьте фото/видео с текстом сюда в бот и нажмите кнопку «📰 Как НОВОСТЬ».\n2️⃣ Из канала @avtoYkorea — перешлите пост в бот и нажмите «📰 Новость».\n3️⃣ Текстовая новость без фото — отправьте:\n/news Заголовок новости\nПодробный текст новости...");
     } else if (!env.REVIEWS) {
      await send(chatId, "Хранилище REVIEWS не настроено.");
     } else {
      const newsId = "news_" + chatId + "_" + String(msg.message_id || Date.now());
      const newsRec = {
       id: newsId,
       category: "news",
       kind: "text",
       text: rawBody,
       photos: [],
       videos: [],
       publishedAt: new Date().toISOString()
      };
      await env.REVIEWS.put("news_approved:" + newsId, JSON.stringify(newsRec));
      await writeLog(env, chatId, "опубликована командой /news", "новость", newsId, siteLabel(newsId, newsRec));
      await api("sendMessage", {
       chat_id: chatId,
       text: "📰 Новость опубликована на сайте!\n\n" + rawBody.slice(0, 1000),
       reply_markup: { inline_keyboard: [[{ text: "✏️ Изменить", callback_data: "siteedit:" + newsId }, { text: "🗑 Снять с сайта", callback_data: "sitedel:" + newsId }], [{ text: "🎛 Панель", callback_data: "panel:home" }]] }
      });
     }
    } else if (/^\/setyandex(?:@\w+)?(?:\s+([\s\S]+))?$/i.test(text) && adminIds.includes(chatId)) {
     const m = text.match(/^\/setyandex(?:@\w+)?(?:\s+([\s\S]+))?$/i);
     const rawCode = m && m[1] ? m[1].trim().replace(/^yandex_|\.html$/gi, "") : "";
     if (!rawCode) {
      const current = await resolveYandexVerification(env);
      await send(chatId, "🔍 Подтверждение прав в Яндекс Вебмастере:\nТекущий код: " + (current || "пока не задан") + "\n\nСкопируйте код из meta-тега Яндекс Вебмастера (или имя файла без yandex_ и .html) и отправьте:\n/setyandex ВАШ_КОД");
     } else if (!/^[A-Za-z0-9_-]{8,64}$/.test(rawCode)) {
      await send(chatId, "❌ Код должен содержать 8–64 латинских букв и цифр (пример: /setyandex a1b2c3d4e5f67890)");
     } else if (!env.REVIEWS) {
      await send(chatId, "Хранилище REVIEWS не настроено.");
     } else {
      await env.REVIEWS.put("site_config:yandex_verification", rawCode);
      await writeLog(env, chatId, "установлен код Яндекс.Вебмастер", "настройки", "yandex_verification", rawCode);
      await send(chatId, "✅ Код Яндекс Вебмастера сохранён!\nТеперь на сайте автоматически работают оба способа проверки: мета-тег на главной и файл /yandex_" + rawCode + ".html");
     }
    } else if (/^\/setmax(?:@\w+)?(?:\s+([\s\S]+))?$/i.test(text) && adminIds.includes(chatId)) {
     const m = text.match(/^\/setmax(?:@\w+)?(?:\s+([\s\S]+))?$/i);
     const rawUrl = m && m[1] ? m[1].trim() : "";
     if (!rawUrl) {
      const current = await resolveMaxBotUrl(env);
      await send(chatId, "💬 Ссылка на бота MAX на сайте:\nТекущая: " + (current || "пока не задана (кнопки MAX на сайте переводят к форме связи в MAX)") + "\n\nЧтобы привязать прямую ссылку на вашего бота в MAX, отправьте:\n/setmax https://max.ru/ваш_бот");
     } else if (!/^https:\/\/max\.ru\/[A-Za-z0-9_./?=-]+$/.test(rawUrl)) {
      await send(chatId, "❌ Ссылка должна начинаться с https://max.ru/ (например: /setmax https://max.ru/avtoykorea_bot)");
     } else if (!env.REVIEWS) {
      await send(chatId, "Хранилище REVIEWS не настроено.");
     } else {
      await env.REVIEWS.put("site_config:max_bot_url", rawUrl);
      await writeLog(env, chatId, "установлена ссылка MAX", "настройки", "max_bot_url", rawUrl);
      await send(chatId, "✅ Ссылка на бота MAX сохранена! Все кнопки MAX на сайте теперь ведут на:\n" + rawUrl);
     }
    } else if (text === "/panel" && adminIds.includes(chatId)) {
     await setAdminCommands(env, chatId).catch(() => {});
     await sendOrEditTelegramPanel(env, chatId, null, "home", { callTelegram, siteLabel, sha256Hex });
    } else if (text === "/admin" && adminIds.includes(chatId)) {
     await setAdminCommands(env, chatId);
     await sendAdminHelp(env, chatId);
    } else if (text === "/adminlink" && adminIds.includes(chatId)) {
     await sendAdminLoginCode(env, chatId);
    } else if (text === "/site" && adminIds.includes(chatId)) {
     await showSiteList(chatId, env);
    } else if (text === "/log" && adminIds.includes(chatId)) {
     await showLog(chatId, env);
    } else if (text === "/help" && adminIds.includes(chatId)) {
     await setAdminCommands(env, chatId);
     await sendAdminHelp(env, chatId);
    } else if (text === "/help") {
     await send(chatId, "Напишите марку и модель, бюджет и страну покупки. Чтобы обратиться к менеджеру, просто отправьте сообщение сюда.");
    } else if (text === "/countries") {
     await send(chatId, "🌍 Подбираем автомобили из:\n🇰🇷 Южной Кореи\n🇨🇳 Китая\n🇦🇪 ОАЭ\n\nНапишите, какая страна вас интересует.");
    } else if (text === "/catalog") {
     await send(chatId, "🚘 Актуальные автомобили AVTOY KOREA\n\nПосмотреть опубликованные предложения: https://avtoy-korea-auto.sokfrut.workers.dev/#cars\n\nВсе объявления появляются на сайте после проверки. Если подходящего автомобиля нет, напишите марку, модель и бюджет — менеджер поможет с подбором.");
    } else if (text === "/contact") {
     await send(chatId, "Оставьте сообщение прямо в этом чате или заполните форму на сайте: https://avtoy-korea-auto.sokfrut.workers.dev/\nКанал: https://t.me/avtoYkorea");
    } else if (text && !adminIds.includes(chatId)) {
     const who = String((msg.from && (msg.from.first_name || msg.from.username)) || "не указано");
     const notice = "📩 Сообщение боту AVTOY KOREA\nОт: " + who + "\nChat ID: " + chatId + "\n\n" + text.slice(0, 3500) + "\n\nОтветить: /reply " + chatId + " текст сообщения";
     // Persist each successful admin delivery so webhook retries skip completed recipients.
     // Without update_id and message_id there is no safe key: deliver without deduplication instead of dropping later messages.
     const hasUpdateId = update.update_id !== undefined && update.update_id !== null;
     const hasMessageId = msg.message_id !== undefined && msg.message_id !== null;
     const deliveryId = hasUpdateId ? String(update.update_id) : (hasMessageId ? chatId + "_" + String(msg.message_id) : null);
     const deliveryKey = deliveryId ? "webhook_delivery:" + deliveryId : null;
     const canPersist = Boolean(deliveryKey && env.REVIEWS);
     let deliveryState = canPersist ? await env.REVIEWS.get(deliveryKey) : null;
     deliveryState = deliveryState ? JSON.parse(deliveryState) : { deliveredAdminIds: [], clientThanked: false };
     const deliveredAdmins = new Set((deliveryState.deliveredAdminIds || []).map(String));
     for (const id of adminIds) {
      if (deliveredAdmins.has(String(id))) continue;
      await send(id, notice);
      deliveredAdmins.add(String(id));
      if (canPersist) {
       deliveryState.deliveredAdminIds = [...deliveredAdmins];
       await env.REVIEWS.put(deliveryKey, JSON.stringify(deliveryState), { expirationTtl: 604800 });
      }
     }
     // Thank-you is sent once per update: a retry after a failed admin delivery must not repeat it.
     if (!deliveryState.clientThanked) {
      await send(chatId, "Спасибо! Ваше сообщение передано менеджеру. Мы ответим, как только сможем.");
      deliveryState.clientThanked = true;
      if (canPersist) await env.REVIEWS.put(deliveryKey, JSON.stringify(deliveryState), { expirationTtl: 604800 });
     }
    } else if (text && adminIds.includes(chatId)) {
     await send(chatId, "Для ответа клиенту используйте: /reply CHAT_ID текст сообщения\nChat ID клиента указан в уведомлении.");
    }
   } catch {
    return new Response("Telegram processing failed", { status: 502 });
   }
   return Response.json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/admin") {
   return new Response(ADMIN_PAGE_HTML, { headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": ADMIN_PRO_CSP
   }});
  }
  const webAdminResponse = await handleWebAdminApi(request, url, env, adminIds);
  if (webAdminResponse) return webAdminResponse;
  if (request.method === "POST" && url.pathname === "/api/request") {
   const cors = resolveMirrorCorsHeaders(request, env);
   const headers = {"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer",...cors};
   const fail = (status,error) => Response.json({ok:false,error},{status,headers});
   const contentType = String(request.headers.get("content-type") || "").toLowerCase();
   if (!contentType.startsWith("application/json")) return fail(415,"Ожидается JSON");
   const declaredLength = Number(request.headers.get("content-length") || 0);
   if (declaredLength > 12000) return fail(413,"Слишком большой запрос");
   let raw;
   try { raw = await readBodyLimited(request,12000); } catch (e) { return e && e.message === "BODY_TOO_LARGE" ? fail(413,"Слишком большой запрос") : fail(400,"Некорректные данные"); }
   if (new TextEncoder().encode(raw).byteLength > 12000) return fail(413,"Слишком большой запрос");
   let d;
   try { d = JSON.parse(raw); } catch { return fail(400,"Некорректные данные"); }
   if (!d || typeof d !== "object" || Array.isArray(d)) return fail(400,"Некорректный формат данных");
   const limits = {name:100,contact:150,model:150,budget:100,country:80,year:30,purpose:100,details:1000};
   for (const [key,limit] of Object.entries(limits)) {
    if (d[key] !== undefined && d[key] !== null && typeof d[key] !== "string") return fail(400,"Некорректное поле: "+key);
    if (typeof d[key] === "string" && d[key].length > limit * 4) return fail(400,"Слишком длинное поле: "+key);
   }
   const clean = (v,n=500) => String(v||"").replace(/[<>]/g,"").trim().slice(0,n);
   const f = {name:clean(d.name,100),contact:clean(d.contact,150),model:clean(d.model,150),budget:clean(d.budget,100),country:clean(d.country,80),year:clean(d.year,30),purpose:clean(d.purpose,100),details:clean(d.details,1000)};
   if (!f.name || !f.contact) return Response.json({ok:false,error:"Укажите имя и контакт для связи."},{status:400,headers});
   const message = ["🚘 Новая заявка AVTOY KOREA","",`Имя: ${f.name}`,`Контакт: ${f.contact}`,`Марка / модель: ${f.model||"не указано"}`,`Бюджет: ${f.budget||"не указан"}`,`Страна: ${f.country||"не указана"}`,`Год от: ${f.year||"не указан"}`,`Тема обращения: ${f.purpose||"Подбор автомобиля"}`,`Пожелания: ${f.details||"нет"}`].join("\n");
   const maxConfigured = Boolean(String(env.MAX_BOT_TOKEN||"").trim() && (String(env.MAX_ADMIN_IDS||env.MAX_OPERATOR_USER_IDS||"").trim() || String(env.MAX_OPERATOR_CHAT_ID||"").trim()));
   const tgConfigured = Boolean(env.TELEGRAM_BOT_TOKEN && adminIds.length >= 1);
   if ((!tgConfigured && !maxConfigured) || !env.REVIEWS) {
    return Response.json({ok:false,error:"Система учёта заявок временно недоступна. Попробуйте позже."},{status:503,headers});
   }
   const requestKey=String(request.headers.get("idempotency-key")||"").trim();
   if(!/^[a-f0-9-]{36}$/i.test(requestKey))return fail(400,"Не удалось проверить повторную отправку. Обновите страницу и попробуйте ещё раз.");
   const idemKey="request_idem:"+requestKey;
   let idemRaw=await env.REVIEWS.get(idemKey);
   let idem=idemRaw?JSON.parse(idemRaw):null;
   let order,orderId,orderNumber,bindToken;
   if(idem){
    orderId=idem.orderId;orderNumber=idem.orderNumber;bindToken=idem.bindToken;
    const saved=await env.REVIEWS.get("order:"+orderId);
    if(!saved)return fail(409,"Состояние заявки не удалось восстановить. Свяжитесь с менеджером.");
    order=JSON.parse(saved);
    if(idem.payloadHash!==JSON.stringify(f))return fail(409,"Ключ отправки уже использован для другой заявки. Обновите страницу.");
   }else{
    orderId=crypto.randomUUID().replace(/-/g,"").slice(0,16);
    bindToken=crypto.randomUUID().replace(/-/g,"")+crypto.randomUUID().replace(/-/g,"");
    // Random suffix reduces collisions; KV is not an atomic lock.
    orderNumber=String(Date.now())+String(crypto.getRandomValues(new Uint32Array(1))[0]).padStart(10,"0");
    order={id:orderId,number:orderNumber,...f,status:"new",chatId:null,telegramId:null,username:null,createdAt:new Date().toISOString()};
    idem={orderId,orderNumber,bindToken,payloadHash:JSON.stringify(f),deliveredAdminIds:[]};
    await env.REVIEWS.put("order:"+orderId,JSON.stringify(order));
    await env.REVIEWS.put("order_no:"+orderNumber,JSON.stringify(order));
    await env.REVIEWS.put("bind_token:"+bindToken,orderId,{expirationTtl:604800});
    await env.REVIEWS.put(idemKey,JSON.stringify(idem),{expirationTtl:604800});
   }
   const cardText=["🚘 Новая заявка №"+orderNumber,"Модель: "+(f.model||"не указано"),"Бюджет: "+(f.budget||"не указан"),"Страна: "+(f.country||"не указана"),"Тема: "+(f.purpose||"Подбор автомобиля"),"Статус: "+order.status,"","Личные данные доступны администратору по кнопке.", "Заявка: " + orderId].join("\n");
   const keyboard={inline_keyboard:[[{text:"✅ Принять в работу",callback_data:"ord:"+orderNumber},{text:"🔐 Данные клиента",callback_data:"ordinfo:"+orderNumber}]]};
   const delivered=new Set((idem.deliveredAdminIds||[]).map(String));
   if(tgConfigured){
    for(const chat_id of adminIds){
     if(delivered.has(String(chat_id)))continue;
     try{
      const payload=await callTelegram(env,"sendMessage",{chat_id,text:cardText,reply_markup:keyboard});
      if(payload&&payload.ok===true){delivered.add(String(chat_id));idem.deliveredAdminIds=[...delivered];await env.REVIEWS.put(idemKey,JSON.stringify(idem),{expirationTtl:604800});}
     }catch{}
    }
   }
   const maxDelivery = await deliverOrderToMax(env, order, f, idem, updated => env.REVIEWS.put(idemKey, JSON.stringify(updated), {expirationTtl:604800}));
   const tgComplete = tgConfigured && adminIds.every(id=>delivered.has(String(id)));
   const maxComplete = maxDelivery.configured && maxDelivery.deliveredAll;
   if(tgConfigured && !tgComplete && !maxComplete)return fail(503,"Заявка №"+orderNumber+" сохранена. Уведомление доставлено не всем администраторам. Нажмите «Отправить заявку» ещё раз — повторно отправим только недоставленные уведомления.");
   if(!tgConfigured && maxDelivery.configured && !maxComplete)return fail(503,"Заявка №"+orderNumber+" сохранена. Уведомление в MAX временно не доставлено, попробуйте ещё раз.");
   const botUser=String(env.TELEGRAM_BOT_USERNAME||"").replace(/^@/,"");
   const maxBotUrl=(await resolveMaxBotUrl(env))||null;
   return Response.json({ok:true,orderId,orderNumber,botLink:botUser?"https://t.me/"+botUser+"?start=order_"+bindToken:null,maxBotUrl},{headers});
  }
  if (request.method === "GET" && url.pathname === "/api/public-config") {
   const maxBotUrl = (await resolveMaxBotUrl(env)) || null;
   return Response.json({ maxBotUrl }, { headers: { "cache-control": "no-store", ...resolveMirrorCorsHeaders(request, env) } });
  }
  if (request.method === "GET" && url.pathname === "/api/cars") {
   if (!env.REVIEWS) return Response.json({error:"Catalogue storage unavailable"},{status:503,headers:{"cache-control":"no-store","x-content-type-options":"nosniff"}});
   const cars = await loadApprovedCarsForPublic(env);
   return Response.json({cars},{headers:{"cache-control":"no-store",...resolveMirrorCorsHeaders(request,env)}});
  }
  const carMediaPath = url.pathname.startsWith("/api/car-media/") ? url.pathname.slice("/api/car-media/".length) : "";
  const carMediaMatch = carMediaPath.match(/^(car_-?[0-9]+_[0-9]+)(?:\/(photo|video)\/(\d+)|(\d+))?$/);
  if (request.method === "GET" && carMediaMatch) {
   if (!env.REVIEWS || !env.TELEGRAM_BOT_TOKEN) return new Response("Not found",{status:404});
   const raw = await env.REVIEWS.get("car_approved:" + carMediaMatch[1]); if (!raw) return new Response("Not found",{status:404});
   const car = JSON.parse(raw); const mediaType = carMediaMatch[2] || (car.mediaType === "video" ? "video" : "photo"); const index = Number(carMediaMatch[3] || carMediaMatch[4] || 0);
   const photos = catalogPhotoItems(car);
   const videos = uniqueFileItems(Array.isArray(car.videos) ? car.videos : (car.mediaType === "video" && car.fileId ? [{file_id:car.fileId}] : []));
   const selected = (mediaType === "video" ? videos : photos)[index]; const fileId = selected && selected.file_id ? selected.file_id : null;
   if (!fileId) return new Response("Not found",{status:404});
   const info = await callTelegram(env,"getFile",{file_id:fileId}).catch(()=>null); const path = info && info.result && info.result.file_path;
   if (!path) return new Response("Not found",{status:404});
   const range = request.headers.get("range"); const upstream = await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + path, range ? {headers:{range}} : {}); if (!upstream.ok && upstream.status !== 206) return new Response("Bad Gateway",{status:502});
   const contentType = mediaType === "video" ? (/\.webm$/i.test(path) ? "video/webm" : "video/mp4") : ((selected && selected.mime_type) || "image/jpeg");
   // Media URLs use positional indexes. A car can be replaced while its URL stays the same, so never cache by index.
   const mediaHeaders = {"content-type":contentType,"cache-control":"no-store","x-content-type-options":"nosniff"};
   for (const name of ["content-length","content-range","accept-ranges"]) { const value = upstream.headers.get(name); if (value) mediaHeaders[name] = value; }
   return new Response(upstream.body,{status:upstream.status,headers:mediaHeaders});
  }
  if (request.method === "GET" && url.pathname === "/api/news") {
   const news = await loadApprovedNewsForPublic(env);
   return Response.json({ news }, { headers: { "cache-control": "no-store", ...resolveMirrorCorsHeaders(request, env) } });
  }
  const newsMediaMatch = url.pathname.match(/^\/api\/news-media\/(news_[A-Za-z0-9_-]+)(?:\/(photo|video)\/(\d+)|\/(\d+))?$/);
  if (request.method === "GET" && newsMediaMatch) {
   if (!env.REVIEWS || !env.TELEGRAM_BOT_TOKEN) return new Response("Not found", { status: 404 });
   const raw = await env.REVIEWS.get("news_approved:" + newsMediaMatch[1]);
   if (!raw) return new Response("Not found", { status: 404 });
   const newsRec = JSON.parse(raw);
   const mediaType = newsMediaMatch[2] || (newsRec.kind === "video" ? "video" : "photo");
   const index = Number(newsMediaMatch[3] || newsMediaMatch[4] || 0);
   const photos = uniqueFileItems(Array.isArray(newsRec.photos) && newsRec.photos.length ? newsRec.photos : (newsRec.fileId && newsRec.kind !== "video" ? [{ file_id: newsRec.fileId }] : []));
   const videos = uniqueFileItems(Array.isArray(newsRec.videos) && newsRec.videos.length ? newsRec.videos : (newsRec.kind === "video" && newsRec.fileId ? [{ file_id: newsRec.fileId }] : []));
   const selected = (mediaType === "video" ? videos : photos)[index];
   const fileId = selected && selected.file_id ? selected.file_id : null;
   if (!fileId) return new Response("Not found", { status: 404 });
   const info = await callTelegram(env, "getFile", { file_id: fileId }).catch(() => null);
   const path = info && info.result && info.result.file_path;
   if (!path) return new Response("Not found", { status: 404 });
   const range = request.headers.get("range");
   const upstream = await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + path, range ? { headers: { range } } : {});
   if (!upstream.ok && upstream.status !== 206) return new Response("Bad Gateway", { status: 502 });
   const contentType = mediaType === "video" ? (/\.webm$/i.test(path) ? "video/webm" : "video/mp4") : ((selected && selected.mime_type) || "image/jpeg");
   const mediaHeaders = { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" };
   for (const name of ["content-length", "content-range", "accept-ranges"]) { const value = upstream.headers.get(name); if (value) mediaHeaders[name] = value; }
   return new Response(upstream.body, { status: upstream.status, headers: mediaHeaders });
  }
  if (request.method === "GET" && url.pathname === "/api/reviews") {
   const reviews = [];
   if (env.REVIEWS) {
    let cursor;
    do {
     const page = await env.REVIEWS.list({prefix:"approved:", ...(cursor ? {cursor} : {})});
     for (const key of page.keys) {
      const raw = await env.REVIEWS.get(key.name);
      if (!raw) continue;
      const r = JSON.parse(raw);
      if (isMarketNewsRecord(r)) continue;
      const photos = uniqueFileItems(Array.isArray(r.photos) && r.photos.length ? r.photos : (r.fileId && r.kind !== "video" ? [{file_id:r.fileId}] : []));
      const videos = uniqueFileItems(Array.isArray(r.videos) && r.videos.length ? r.videos : (r.kind === "video" && r.fileId ? [{file_id:r.fileId}] : []));
      const ordered = publicReviewMediaOrder(r,photos,videos);
      const mediaItems = ordered.mediaItems;
      const media = r.fileId ? `/api/review-media/${r.id}` : null;
      reviews.push({id:r.id,kind:r.kind,text:cleanPublicationText(r.text),media,mediaItems,mediaOrderKnown:ordered.mediaOrderKnown});
     }
     cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
   }
   return Response.json({ reviews }, { headers: { "cache-control": "no-store", ...resolveMirrorCorsHeaders(request, env) } });
  }
  const mediaMatch = url.pathname.match(/^\/api\/review-media\/(-?\d+_\d+)(?:\/(photo|video)\/(\d+)|\/(\d+))?$/);
  if (request.method === "GET" && mediaMatch) {
   // Файлы отдаются через Worker: токен бота в браузер не попадает.
   if (!env.REVIEWS || !env.TELEGRAM_BOT_TOKEN) return new Response("Not found", { status: 404 });
   const raw = await env.REVIEWS.get(`approved:${mediaMatch[1]}`);
   if (!raw) return new Response("Not found", { status: 404 });
   const review = JSON.parse(raw);
   const mediaType = mediaMatch[2] || (review.kind === "video" ? "video" : "photo");
   const index = Number(mediaMatch[3] || mediaMatch[4] || 0);
   const photos = uniqueFileItems(Array.isArray(review.photos) && review.photos.length ? review.photos : (review.fileId && review.kind !== "video" ? [{file_id:review.fileId}] : []));
   const videos = uniqueFileItems(Array.isArray(review.videos) && review.videos.length ? review.videos : (review.kind === "video" && review.fileId ? [{file_id:review.fileId}] : []));
   const photoItem = mediaType === "photo" ? photos[index] : null;
   const videoItem = mediaType === "video" ? videos[index] : null;
   const selectedItem = photoItem || videoItem;
   const fileId = selectedItem && selectedItem.file_id;
   if (!fileId) return new Response("Not found", { status: 404 });
   const info = await callTelegram(env, "getFile", { file_id: fileId }).catch(() => null);
   const path = info && info.result && info.result.file_path;
   if (!path) return new Response("Not found", { status: 404 });
   const upstream = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
   if (!upstream.ok) return new Response("Bad Gateway", { status: 502 });
   const imageType = photoItem && photoItem.mime_type;
   const contentType = mediaType === "video" ? "video/mp4" : (imageType || "image/jpeg");
   return new Response(upstream.body, { headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  const yandexFileMatch = url.pathname.match(/^\/yandex_([A-Za-z0-9_-]{8,64})\.html$/);
  if (request.method === "GET" && yandexFileMatch) {
   const expectedCode = await resolveYandexVerification(env);
   if (expectedCode && yandexFileMatch[1] === expectedCode) {
    return new Response(`<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"></head><body>Verification: ${expectedCode}</body></html>`, {
     headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
    });
   }
   return new Response("Not found", { status: 404 });
  }
  if (request.method === "GET" && url.pathname === "/robots.txt") {
   return new Response(buildRobotsTxt({ baseUrl: url.origin }), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" }
   });
  }
  if (request.method === "GET" && url.pathname === "/sitemap.xml") {
   const [cars, news] = await Promise.all([loadApprovedCarsForPublic(env), loadApprovedNewsForPublic(env)]);
   return new Response(buildSitemapXml({ baseUrl: url.origin, cars, news, useHtmlExt: false }), {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" }
   });
  }
  if (request.method === "GET" && url.pathname === "/yandex-feed.xml") {
   const cars = await loadApprovedCarsForPublic(env);
   return new Response(buildYandexMarketYml({ baseUrl: url.origin, cars, useHtmlExt: false }), {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" }
   });
  }
  if (request.method === "GET" && url.pathname.startsWith("/cars/")) {
   const carId = decodeURIComponent(url.pathname.slice(6)).replace(/\.html$/i, "");
   if (!env.REVIEWS || !carId) return new Response("Not found", { status: 404 });
   const raw = await env.REVIEWS.get("car_approved:" + carId);
   if (!raw) return new Response("Not found", { status: 404 });
   const car = JSON.parse(raw);
   if (String(car.caption || "").trim().toLowerCase() === "исправить") return new Response("Not found", { status: 404 });
   const photoItems = catalogPhotoItems(car);
   const videoItems = uniqueFileItems(Array.isArray(car.videos) ? car.videos : (car.mediaType === "video" && car.fileId ? [{ file_id: car.fileId }] : []));
   const ordered = publicCarMediaOrder(car, photoItems, videoItems);
   const maxUrl = await resolveMaxBotUrl(env);
   return new Response(renderCarLandingHtml({
    id: car.id,
    caption: publicCarCaption(car.caption),
    media: ordered.mediaItems[0] ? ordered.mediaItems[0].url : null,
    mediaItems: ordered.mediaItems,
    mediaType: car.mediaType || "photo",
    publishedAt: car.publishedAt
   }, { baseUrl: url.origin, isStaticMirror: false, maxBotUrl: maxUrl }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
   });
  }
  if (request.method === "GET" && url.pathname.startsWith("/news/")) {
   const newsId = decodeURIComponent(url.pathname.slice(6)).replace(/\.html$/i, "");
   if (!env.REVIEWS || !newsId) return new Response("Not found", { status: 404 });
   const [allNews, maxUrl] = await Promise.all([loadApprovedNewsForPublic(env), resolveMaxBotUrl(env)]);
   const item = allNews.find(n => n.id === newsId);
   if (!item) return new Response("Not found", { status: 404 });
   return new Response(renderNewsLandingHtml(item, { baseUrl: url.origin, isStaticMirror: false, maxBotUrl: maxUrl }), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }
   });
  }
  if(url.pathname==="/favicon.ico") return new Response(null,{status:204});
  const [resolvedMaxUrl, resolvedYandexCode, ssrCars, ssrNews] = await Promise.all([
   resolveMaxBotUrl(env),
   resolveYandexVerification(env),
   loadApprovedCarsForPublic(env).catch(() => []),
   loadApprovedNewsForPublic(env).catch(() => [])
  ]);
  const maxHrefAttr = resolvedMaxUrl ? `href="${resolvedMaxUrl}" target="_blank" rel="noopener"` : `href="#max-bot"`;
  const yandexVerifyMeta = resolvedYandexCode ? `\n<meta name="yandex-verification" content="${resolvedYandexCode}">` : "";
  const canonicalUrl = `${url.origin}/`;
  const seoJsonLd = buildHomepageJsonLd({ baseUrl: url.origin, cars: ssrCars, news: ssrNews });
  const ssrCarsHtml = renderServerCatalogPreviewHtml(ssrCars, { useHtmlExt: false });
  const ssrFaqAndLinksHtml = renderFaqAndDirectoryHtml(ssrCars, ssrNews, { useHtmlExt: false });
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#08090b">
<meta name="description" content="Купить автомобиль из Южной Кореи, Китая и ОАЭ под заказ под ключ в Россию. Проверка пробега и истории, честный расчёт цены, доставка до Москвы и регионов | AVTOY KOREA">
<meta name="keywords" content="купить авто из Кореи, автомобили из Кореи под заказ, пригон авто из Китая, авто из ОАЭ под ключ, утильсбор авто, AVTOY KOREA">
<title>AVTOY KOREA — Купить автомобиль из Кореи, Китая и ОАЭ под заказ под ключ</title>
<link rel="canonical" href="${canonicalUrl}">
<meta property="og:type" content="website">
<meta property="og:title" content="AVTOY KOREA — Автомобили из Кореи, Китая и ОАЭ под заказ">
<meta property="og:description" content="Подбор, техническая проверка и доставка проверенных автомобилей под ключ в Россию.">
<meta property="og:url" content="${canonicalUrl}">
<meta property="og:image" content="${canonicalUrl}assets/logo.jpg">${yandexVerifyMeta}
<script type="application/ld+json">${seoJsonLd}</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Manrope:wght@500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{color-scheme:dark;--bg:#08090b;--panel:#121419;--line:#292c33;--text:#f7f7f8;--muted:#a3a5ad;--red:#ff4b35;--max:1160px}
*{box-sizing:border-box;min-width:0}img,video,iframe{max-width:100%}body{overflow-x:hidden}
html{scroll-behavior:smooth;scroll-padding-top:90px}
body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,"Segoe UI",Arial,sans-serif;line-height:1.55}
a{color:inherit;text-decoration:none}
button,input,textarea,select{font:inherit}
.wrap{width:min(var(--max),calc(100% - 40px));margin:auto}
.topbar{position:sticky;top:0;z-index:10;background:#08090bf0;backdrop-filter:blur(18px);border-bottom:1px solid #ffffff12}
.nav{min-height:82px;display:flex;align-items:center;justify-content:space-between;gap:18px}
.brand{font-weight:900;letter-spacing:.16em;font-size:19px;line-height:1.1}
.brand em{color:var(--red);font-style:normal}
.brand small{display:block;margin-top:7px;color:#a6a8af;font-size:10px;letter-spacing:.27em;font-weight:500}
.nav-links{display:flex;gap:26px;align-items:center;font-size:15px;color:#c7c9d0}
.nav-links a:hover{color:#fff}
.pill{border-radius:999px;padding:12px 20px;background:var(--red);color:#fff;font-weight:700;font-size:15px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;border-radius:16px;padding:17px 26px;font-weight:800;font-size:16px;border:1px solid var(--line);cursor:pointer;transition:transform .18s}
.btn:hover{transform:translateY(-2px)}
.btn-red{background:var(--red);border-color:var(--red);color:#fff;box-shadow:0 10px 35px #ff4b3520}
.btn-dark{background:#0d0e11;color:#fff}
.btn:disabled{opacity:.6;cursor:default;transform:none}
.eyebrow{font-size:12px;font-weight:800;letter-spacing:.28em;color:var(--red);text-transform:uppercase}
.section{padding:88px 0}
h2{font-size:clamp(28px,4vw,48px);line-height:1.08;letter-spacing:-.04em;margin:14px 0 14px;font-weight:900}
.sub{color:var(--muted);font-size:16px;margin:0 0 32px;max-width:720px}
.hero{display:grid;grid-template-columns:1fr 1fr;gap:56px;align-items:center;padding:80px 0 72px}
.hero h1{font-size:clamp(44px,6.4vw,80px);line-height:.98;letter-spacing:-.05em;margin:22px 0 24px;font-weight:900}
.hero h1 span{color:#85868c}
.intro{max-width:520px;font-size:clamp(17px,2vw,20px);color:#b2b4bc;line-height:1.6;margin:0}
.actions{display:flex;gap:14px;flex-wrap:wrap;margin-top:34px}
.photo{position:relative;aspect-ratio:1.35/1;min-height:360px;border:1px solid #33363d;border-radius:28px;overflow:hidden;background:#0b111b;box-shadow:0 24px 70px #0008}
.hero-slide{position:absolute;inset:0;background-size:cover;background-position:center;opacity:0;transition:opacity 1s ease}
.hero-slide.active{opacity:1}
.hero-slide:after{content:"";position:absolute;inset:45% 0 0;background:linear-gradient(transparent,#050a12d9)}
.hero-caption{position:absolute;z-index:2;left:24px;right:24px;bottom:22px;color:#fff;font-weight:800;font-size:18px;text-shadow:0 2px 12px #000}
.hero-dots{position:absolute;z-index:3;right:24px;bottom:28px;display:flex;gap:8px}
.hero-dot{width:8px;height:8px;border-radius:50%;background:#ffffff70}
.hero-dot.active{background:var(--red);transform:scale(1.25)}
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:26px;box-sizing:border-box}
.card .num{color:var(--red);font-weight:900;font-size:28px}
.card h3{font-size:20px;margin:16px 0 10px}
.card p{margin:0;color:var(--muted);font-size:15px;line-height:1.6}
.get{margin-top:16px;display:grid;grid-template-columns:.7fr 1.3fr;gap:32px;align-items:center;background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:26px 30px;box-sizing:border-box}
.get-title{font-size:20px;font-weight:800}
.get ul{margin:0;padding-left:20px;color:#c7c9d0;font-size:15px;line-height:1.9;display:grid;grid-template-columns:1fr 1fr;column-gap:32px}
.reviews{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.cars{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
.car-card{padding:0;overflow:hidden}
.car-photo{height:200px;background:#0b0c0f center/cover no-repeat;position:relative}
.car-photo:after{content:"";position:absolute;inset:45% 0 0;background:linear-gradient(transparent,#050a12b8)}
.car-body{padding:22px}
.car-body h3{margin:0 0 12px;font-size:20px}
.car-specs{color:#c7c9d0;font-size:14px;line-height:1.9}
.car-foot{margin-top:16px;padding-top:16px;border-top:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px}
.car-label{font-size:12px;color:var(--muted)}
.car-price{font-size:20px;font-weight:900}
.car-link{color:var(--red);font-weight:800;font-size:14px}
.review-media{width:100%;height:200px;border-radius:14px;background:#0b0c0f;display:block;object-fit:cover}
.review-name{margin-top:16px;color:var(--red);font-weight:800;font-size:13px}
.review-text{margin:6px 0 0;color:#c7c9d0;font-size:15px;line-height:1.6}
.dashed{border-style:dashed}
.form-card{display:grid;grid-template-columns:.8fr 1.2fr;gap:48px;background:var(--panel);border:1px solid #30333a;border-radius:28px;padding:48px;box-sizing:border-box}
.form-card h2{font-size:clamp(28px,4vw,42px)}
.form-intro{color:var(--muted);font-size:16px;line-height:1.6;margin:0 0 14px}
.hint{color:var(--muted);font-size:13px;margin:0}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.field{display:flex;flex-direction:column;gap:8px;font-size:13px;color:#c7c9d0}
.field.full{grid-column:1/-1}
.field input,.field textarea,.field select{width:100%;background:#0b0c0f;border:1px solid #30333a;border-radius:12px;color:#fff;padding:15px;outline:none;min-width:0;font-size:15px}
.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--red);box-shadow:0 0 0 3px #ff4b351a}
.field textarea{min-height:90px;resize:vertical}
.form-foot{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-top:6px}
.form-foot .hint{font-size:12px}
.status{font-size:14px;margin-top:12px;min-height:24px}
.status a{color:var(--red);font-weight:700}
footer{border-top:1px solid var(--line);padding:26px 0;color:var(--muted);font-size:13px}
.footer-row{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;align-items:center}
.telegram:hover{color:var(--red)}
.telegram-promo{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,.8fr);gap:28px;align-items:center;background:linear-gradient(135deg,#071421,#0b1b2b);border:1px solid #17344d;border-radius:26px;padding:30px;margin-top:24px;overflow:hidden}.telegram-promo h2{margin:8px 0 12px}.telegram-promo p{color:var(--muted);line-height:1.65;margin:0 0 18px}.telegram-promo-qr{display:block;width:min(100%,220px);justify-self:center;background:#fff;padding:12px;border-radius:18px}.telegram-promo-qr img{display:block;width:100%;height:auto}.telegram-promo-link{display:inline-flex;align-items:center;background:#229ed9;color:#fff;padding:13px 18px;border-radius:999px;font-weight:800}@media(max-width:780px){.telegram-promo{grid-template-columns:minmax(0,1fr);text-align:center;padding:22px 18px;gap:18px}.telegram-promo-qr{width:190px;grid-row:1}}
@media(max-width:780px){
  .wrap{width:calc(100% - 32px);max-width:100%}
  .nav{min-height:70px}
  .brand{font-size:16px}
  .brand small{font-size:8px}
  .nav-links a:not(.pill){display:none}
  .pill{padding:10px 14px;font-size:13px}
  .section{padding:44px 0}
  .hero{grid-template-columns:1fr;gap:24px;padding:28px 0 24px}
  .hero h1{font-size:44px;margin:14px 0 14px}
  .photo{aspect-ratio:16/9;padding:16px;border-radius:20px;font-size:11px}
  .actions{display:grid;grid-template-columns:1fr;gap:10px;margin-top:22px}
  .btn{padding:16px;font-size:15px}
  .steps{grid-template-columns:1fr 1fr;gap:10px}
  .card{padding:16px;border-radius:18px;min-height:150px}
  .card .num{font-size:22px}
  .card h3{font-size:15px;margin:10px 0 6px}
  .card p{font-size:12px;line-height:1.5}
  .get{grid-template-columns:1fr;padding:18px;border-radius:18px;gap:14px;margin-top:10px}
  .get-title{font-size:16px}
  .get ul{grid-template-columns:1fr 1fr;gap:8px;padding:0;list-style:none;font-size:13px;line-height:1.4}
  .get li{background:#0b0c0f;border:1px solid var(--line);border-radius:12px;padding:12px}
  .cars{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .car-photo{height:100px;padding:10px;font-size:9px;letter-spacing:.1em}
  .car-body{padding:12px}
  .car-body h3{font-size:13px;margin:0 0 6px;line-height:1.3}
  .car-specs{display:none}
  .car-foot{margin-top:10px;padding-top:10px;flex-direction:column;align-items:flex-start;gap:6px}
  .car-label{font-size:10px}
  .car-price{font-size:15px}
  .car-link{font-size:12px}
  .reviews{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .reviews>article{padding:10px;border-radius:16px}
  .review-media{height:110px;border-radius:10px}
  .review-name{font-size:11px;margin-top:8px}
  .review-text{font-size:12px;line-height:1.45;margin-top:4px}
  h2{font-size:26px;margin:12px 0 10px}
  .sub{font-size:14px;margin-bottom:20px}
  .form-card{grid-template-columns:1fr;padding:20px;border-radius:22px;gap:20px}
  .form-grid{grid-template-columns:1fr}
  .field.full{grid-column:auto}
  .form-foot .btn{width:100%}
}

/* AVTOY KOREA responsive tile refresh — phone, tablet and desktop */
:root{--max:1240px;--surface:#11151c;--surface-2:#171c25;--line:#2a303b;--muted:#aeb6c3}
body{background:radial-gradient(ellipse at 82% 5%,#1c2734 0,transparent 34%),var(--bg)}
.wrap{width:min(var(--max),calc(100% - 48px))}
.topbar{background:rgba(8,10,14,.92);border-bottom-color:#ffffff18}
.nav{min-height:76px}
.brand{font-size:20px;letter-spacing:.14em}
.nav-links{gap:22px}
.hero{grid-template-columns:minmax(0,.92fr) minmax(0,1.08fr);gap:clamp(28px,5vw,72px);padding:clamp(48px,7vw,92px) 0 70px}
.hero h1{font-size:clamp(48px,6vw,82px);line-height:.99}
.photo{aspect-ratio:16/11;min-height:0;border-radius:30px;border-color:#ffffff20;box-shadow:0 28px 90px #0009}
.section{padding:76px 0}
.steps,.cars,.reviews{gap:18px}
.card{background:linear-gradient(145deg,#171c25,#101319);border-color:#ffffff16;border-radius:22px;box-shadow:0 12px 34px #0002;transition:transform .2s,border-color .2s,box-shadow .2s}
.card:hover{transform:translateY(-3px);border-color:#ff654d70;box-shadow:0 18px 42px #0005}
.steps .card{min-height:194px;padding:25px}
.steps .card h3{font-size:19px;line-height:1.25}
.steps .card p{font-size:14px}
.get{background:linear-gradient(120deg,#151b24,#101319);border-color:#ffffff18;border-radius:22px}
.form-card{background:linear-gradient(145deg,#171c25,#101319);border-color:#ffffff1c;box-shadow:0 22px 70px #0005}
.field input,.field textarea,.field select{background:#0b0e13;border-color:#343c49;min-height:50px}
.field textarea{min-height:110px}
.telegram-promo{background:linear-gradient(125deg,#0c1d2c,#111b29 65%,#191d27);border-color:#ffffff20}
footer{border-top-color:#ffffff18}
:focus-visible{outline:3px solid #ff735e;outline-offset:3px}
@media(min-width:781px) and (max-width:1100px){
 .wrap{width:calc(100% - 40px)}
 .nav-links{gap:14px;font-size:14px}
 .pill{padding:11px 15px;font-size:14px}
 .hero{gap:28px;padding:58px 0}
 .hero h1{font-size:clamp(44px,5.5vw,64px)}
 .steps{grid-template-columns:repeat(2,minmax(0,1fr))}
 .cars,.reviews{grid-template-columns:repeat(2,minmax(0,1fr))}
 .form-card{gap:28px;padding:34px}
}
@media(max-width:780px){
 .wrap{width:calc(100% - 32px)}
 .nav{min-height:66px;gap:10px}
 .brand{font-size:16px;letter-spacing:.11em}
 .brand small{letter-spacing:.18em}
 .nav-links{gap:0}
 .pill{padding:10px 13px;font-size:12px;white-space:nowrap}
 .hero{grid-template-columns:minmax(0,1fr);gap:22px;padding:30px 0 28px}
 .hero h1{font-size:clamp(42px,10vw,58px);margin:14px 0 16px}
 .intro{font-size:16px;line-height:1.55}
 .photo{width:100%;aspect-ratio:16/10;min-height:0;border-radius:22px}
 .hero-caption{left:16px;right:16px;bottom:16px;font-size:14px}
 .hero-dots{right:17px;bottom:21px}
 .actions{display:grid;grid-template-columns:1fr;gap:10px;margin-top:22px}
 .btn{width:100%;min-height:50px;padding:14px 18px;border-radius:14px;font-size:15px}
 .section{padding:48px 0}
 h2{font-size:clamp(25px,6.5vw,34px);line-height:1.12}
 .sub{font-size:14px;line-height:1.55;margin-bottom:22px}
 .steps{grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}
 .steps .card{min-height:0;padding:16px 14px;border-radius:17px}
 .steps .card .num{font-size:22px}
 .steps .card h3{font-size:15px;line-height:1.25;margin:9px 0 6px}
 .steps .card p{font-size:12px;line-height:1.48}
 .get{grid-template-columns:1fr;padding:18px;border-radius:18px;gap:12px;margin-top:12px}
 .get-title{font-size:16px}
 .get ul{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:0;list-style:none;font-size:12px;line-height:1.4}
 .get li{background:#0b0e13;border:1px solid var(--line);border-radius:12px;padding:11px}
 .cars,.reviews{grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}
 .car-card{padding:0;min-height:0}
 .car-body{padding:13px}
 .car-body h3{font-size:14px;line-height:1.3;margin:0 0 7px}
 .car-specs{display:block!important;font-size:12px;line-height:1.5;overflow-wrap:anywhere}
 .car-link{display:inline-block;margin-top:10px;font-size:12px}
 .review-media{height:auto;aspect-ratio:4/3;object-fit:cover;border-radius:12px}
 .reviews>article{padding:13px;border-radius:17px}
 .review-name{font-size:12px;margin-top:9px}
 .review-text{font-size:12px;line-height:1.5}
 .form-card{grid-template-columns:minmax(0,1fr);gap:18px;padding:20px;border-radius:21px}
 .form-card h2{font-size:28px}
 .form-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
 .field.full{grid-column:1/-1}
 .field{font-size:12px}
 .field input,.field textarea,.field select{padding:13px;font-size:16px;min-height:48px}
 .form-foot{display:grid;grid-template-columns:1fr;gap:10px}
 .form-foot .btn{width:100%}
 .telegram-promo{grid-template-columns:minmax(0,1fr);text-align:center;padding:22px 18px;gap:17px;border-radius:21px}
 .telegram-promo-qr{width:164px;grid-row:1}
 .footer-row{justify-content:center;text-align:center}
}
@media(max-width:420px){
 .wrap{width:calc(100% - 26px)}
 .brand{font-size:14px}
 .brand small{font-size:7px}
 .pill{font-size:11px;padding:9px 10px}
 .steps,.cars,.reviews{gap:8px}
 .steps .card{padding:14px 11px}
 .steps .card h3{font-size:14px}
 .steps .card p{font-size:11px}
 .get ul{font-size:11px}
 .form-grid{grid-template-columns:minmax(0,1fr)}
 .field.full{grid-column:auto}
 .telegram-promo-qr{width:148px}
}
@media(max-width:340px){
 .steps,.cars,.reviews{grid-template-columns:minmax(0,1fr)}
 .nav .pill{white-space:normal;text-align:center}
}

/* AVTOY KOREA review photo slider — one full-size image per card */
.review-carousel .reviews>article{display:flex;flex-direction:column;align-items:stretch;gap:0}
.review-gallery{position:relative;width:100%;max-width:100%;height:clamp(170px,22vw,250px);margin:0 0 4px;overflow:hidden;border-radius:14px;background:#080d14}.review-gallery-stage{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
.review-gallery-photo{display:flex;width:100%;height:100%;align-items:center;justify-content:center}
.review-gallery-image{display:block;width:100%;height:100%;object-fit:contain;object-position:center}
.review-gallery-arrow{position:absolute;top:50%;transform:translateY(-50%);width:34px;height:34px;border:1px solid #ffffff55;border-radius:50%;background:#090d14c9;color:#fff;font-size:25px;line-height:1;display:grid;place-items:center;cursor:pointer;z-index:2}
.review-gallery-arrow.is-prev{left:9px}.review-gallery-arrow.is-next{right:9px}
.review-gallery-arrow:disabled{opacity:.35;cursor:default}
.review-gallery-count{position:absolute;right:10px;bottom:9px;padding:4px 9px;border-radius:20px;background:#090d14d9;color:#fff;font-size:11px;font-weight:700;letter-spacing:.04em}
.review-gallery-arrow[hidden],.review-gallery-count[hidden]{display:none}
.review-carousel .review-name{margin-top:12px}
.review-carousel .review-text{white-space:pre-line;overflow-wrap:anywhere}
@media(max-width:780px){.review-gallery{height:clamp(160px,48vw,230px);border-radius:12px}.review-gallery-arrow{width:32px;height:32px}}
@media(prefers-reduced-motion:reduce){.review-gallery-image{transition:none}}

/* Homepage customer reviews carousel */
.review-carousel{position:relative}
.review-carousel .reviews{display:flex;gap:18px;overflow-x:auto;overflow-y:hidden;padding:4px 3px 22px;scroll-snap-type:x mandatory;scroll-behavior:smooth;overscroll-behavior-x:contain;scrollbar-width:none}
.review-carousel .reviews::-webkit-scrollbar{display:none}
.review-carousel .reviews>article{flex:0 0 calc((100% - 36px)/3);min-width:0;scroll-snap-align:start;overflow:hidden;padding:18px;border:1px solid #ffffff18;background:linear-gradient(155deg,#1a202b,#10141b);border-radius:22px;box-shadow:0 16px 42px #0004}
.review-carousel .reviews>article:hover{transform:translateY(-3px);border-color:#ff735e70}
.review-carousel .review-media{width:100%;height:220px;object-fit:cover;border-radius:15px;background:#080b10;display:block}
.review-carousel video.review-media{height:auto;aspect-ratio:16/9;object-fit:contain}
.review-video-label{display:inline-flex;align-items:center;gap:6px;margin:0 0 10px;padding:6px 10px;border-radius:99px;background:#ff735e18;color:#ff9b89;font-size:10px;font-weight:800;letter-spacing:.09em;text-transform:uppercase}
.review-video-label:before{content:'▶';font-size:9px}
.review-carousel .reviews>article:has(video){border-color:#ff735e45}
.review-carousel .review-name{font-size:14px;margin-top:16px}
.review-carousel .review-text{font-size:15px;line-height:1.65}
.review-controls{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:4px}
.review-dots{display:flex;align-items:center;gap:7px;min-height:36px}
.review-dot{width:7px;height:7px;padding:0;border:0;border-radius:99px;background:#687080;cursor:pointer;transition:width .2s,background .2s}
.review-dot[aria-current=true]{width:24px;background:var(--red)}
.review-arrows{display:flex;gap:9px}
.review-arrow{width:42px;height:42px;display:grid;place-items:center;border:1px solid #ffffff25;border-radius:50%;background:#171d27;color:#fff;font-size:21px;cursor:pointer}
.review-arrow:hover{background:var(--red);border-color:var(--red)}
.review-arrow:disabled{opacity:.35;cursor:default}
@media(max-width:780px){.review-carousel .reviews{gap:12px;padding-bottom:16px}.review-carousel .reviews>article{flex:0 0 min(82%,340px);padding:14px;border-radius:19px}.review-carousel .review-media{height:auto;aspect-ratio:4/3}.review-carousel video.review-media{aspect-ratio:16/9;object-fit:contain}.review-carousel .review-name{font-size:13px}.review-carousel .review-text{font-size:13px;line-height:1.55}.review-arrow{width:38px;height:38px}}
@media(max-width:420px){.review-carousel .reviews>article{flex-basis:88%}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}.review-carousel .reviews{scroll-behavior:auto}}

/* Машины: прокрутка вбок по одной машине; фото внутри машины — ряды миниатюр */
.cars{display:flex!important;grid-template-columns:none!important;overflow-x:auto;scroll-snap-type:x mandatory;gap:14px!important;padding:4px 2px 18px;scrollbar-width:none;overscroll-behavior-x:contain}
.cars::-webkit-scrollbar{display:none}
.cars>article{flex:0 0 min(86%,340px);min-width:0;scroll-snap-align:start;height:auto}
.cars-hint{display:none;margin:10px 0 0;font-size:13px;color:var(--muted)}
.cars-hint.is-on{display:block}
@media (min-width:900px){
 .cars{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;overflow:visible;padding:0;scroll-snap-type:none}
 .cars>article{flex:none;width:auto}
 .cars-hint{display:none!important}
}
.car-gallery{position:relative;width:100%;margin:16px 0 0;overflow:hidden;border-radius:16px;background:#080d14;aspect-ratio:16/10;max-height:none;min-height:240px}
.car-gallery-stage{all:unset;box-sizing:border-box;display:flex;width:100%;height:100%;align-items:center;justify-content:center;cursor:zoom-in}
.car-gallery-main{display:block;width:100%;height:100%;object-fit:contain;object-position:center}
.car-gallery-arrow{position:absolute;top:50%;transform:translateY(-50%);width:38px;height:38px;border:1px solid #ffffff55;border-radius:50%;background:#090d14c9;color:#fff;font-size:26px;line-height:1;display:grid;place-items:center;cursor:pointer;z-index:2}
.car-gallery-arrow.is-prev{left:10px}.car-gallery-arrow.is-next{right:10px}
.car-gallery-count{position:absolute;right:11px;bottom:10px;padding:5px 10px;border-radius:20px;background:#090d14d9;color:#fff;font-size:12px;font-weight:700}
.car-gallery-arrow[hidden],.car-gallery-count[hidden]{display:none}
@media(max-width:780px){.car-gallery{aspect-ratio:16/10;max-height:none;min-height:220px;border-radius:13px}.car-gallery-stage{min-height:220px}.car-gallery-arrow{width:34px;height:34px}}
.car-text{white-space:pre-line;max-width:60ch;font-size:14px;line-height:1.6;color:#c7c9d0;margin:10px 0 0}
.car-lightbox{position:fixed;inset:0;z-index:999;background:rgba(5,6,8,.96);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:16px;box-sizing:border-box}
.car-lightbox-bar{position:absolute;top:12px;left:0;right:0;display:flex;justify-content:space-between;align-items:center;padding:0 16px;color:#c9ccd4;font-size:14px}
.car-lightbox-stage{width:min(92vw,1000px);max-height:78vh;aspect-ratio:4/3;display:flex;align-items:center;justify-content:center;border-radius:14px;background:#0b0c0f;overflow:hidden}
.car-lightbox-stage img,.car-lightbox-stage video{max-width:100%;max-height:100%;object-fit:contain}
.car-lightbox-nav{display:flex;gap:12px}
.car-lightbox button{all:unset;cursor:pointer;box-sizing:border-box;min-width:48px;height:48px;border-radius:999px;background:#1d2029;color:#f4f4f5;display:flex;align-items:center;justify-content:center;font-size:22px;padding:0 14px}


/* Reference standard: AVTOY KOREA premium automotive landing */
:root{--red:#f12f38;--navy:#071321;--bg:#071321;--panel:#111a27;--max:1400px}
body{background:#f5f7fa;color:#111827;font-family:Inter,Arial,sans-serif}
.wrap{width:min(1400px,calc(100% - 64px))}
.topbar{background:#071321;border-bottom:1px solid #ffffff16;position:relative}
.nav{min-height:96px;gap:22px}
.brand{font-size:25px;letter-spacing:.04em;color:#fff;white-space:nowrap}
.brand small{font-size:9px;letter-spacing:.16em;color:#aeb9c8}
.nav-links{gap:clamp(12px,2.2vw,34px);font-size:14px;color:#e5eaf0;white-space:nowrap}
.nav-links a{position:relative;padding:8px 0}
.nav-links .nav-home:after{content:"";position:absolute;left:0;right:0;bottom:-9px;height:3px;background:var(--red);border-radius:3px}
.nav-telegram{display:flex;align-items:center;gap:10px;white-space:nowrap;font-size:13px}
.nav-telegram>span{display:grid;place-items:center;width:38px;height:38px;border-radius:50%;background:#229ed9;color:white;font-size:19px}
.nav-telegram small{display:block;color:#aeb9c8;font-size:11px;margin-top:2px}
.nav .pill{border-radius:30px;padding:14px 24px;white-space:nowrap;background:var(--red);box-shadow:0 8px 22px #f12f3830}
.hero-standard{height:clamp(430px,39vw,570px);position:relative;overflow:hidden;background:#091625;color:#fff;display:flex;align-items:center}
.hero-standard-bg,.hero-standard-bg:after{position:absolute;inset:0}
.hero-standard-bg:after{content:"";background:linear-gradient(90deg,#06111fe8 0%,#06111fa8 34%,#06111f20 72%),linear-gradient(0deg,#06111f55,transparent 40%)}
.hero-standard .hero-slide{background-size:cover;background-position:center 55%}
.hero-standard-content{position:relative;z-index:2;padding-top:18px}
.hero-standard .eyebrow{color:#d5dce5;letter-spacing:.18em}
.hero-standard h1{font-size:clamp(48px,5vw,76px);line-height:1.02;margin:20px 0 18px;letter-spacing:-.04em;color:#fff}
.hero-standard h1 span{color:var(--red)}
.hero-standard .intro{font-size:17px;line-height:1.55;color:#e0e5ec;max-width:430px}
.hero-standard .btn{margin-top:26px;border-radius:28px;padding:16px 30px;min-width:210px}
.hero-standard .hero-dots{position:static;margin:36px 0 0 44%;display:flex;gap:12px}
.hero-standard .hero-dot{border:0;padding:0;width:10px;height:10px;cursor:pointer}
.hero-model-name{position:absolute;z-index:3;right:78px;bottom:27px;padding:9px 15px;border:1px solid #ffffff35;border-radius:30px;background:#071321b8;color:#fff;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;backdrop-filter:blur(8px)}
.hero-standard .hero-slide{background-color:#101923;background-size:cover;background-position:center 55%}
@media(max-width:780px){.hero-model-name{right:54px;bottom:25px;padding:7px 11px;font-size:10px;letter-spacing:.08em}}
.hero-standard .hero-dot.active{background:var(--red)}
.hero-arrow{position:absolute;z-index:3;top:48%;width:42px;height:42px;border:0;border-radius:50%;background:#07132199;color:#fff;font-size:30px;cursor:pointer}
.hero-prev{left:20px}.hero-next{right:20px}
.benefit-strip{background:#071321;color:#fff;padding:22px 0 26px}
.benefit-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px}
.benefit-grid article{display:flex;align-items:center;gap:16px;padding:8px 18px;border-right:1px solid #ffffff12}
.benefit-grid article:last-child{border:0}
.benefit-icon{flex:0 0 56px;height:56px;border:2px solid #58687b;border-radius:50%;display:grid;place-items:center;font-size:27px;color:#e8edf5}
.benefit-grid b{font-size:14px;line-height:1.3;display:block}
.benefit-grid small{display:block;color:#aeb9c8;font-size:12px;line-height:1.45;margin-top:8px}
#about{display:none}
#cars{background:#f5f7fa;color:#111827;width:100%;max-width:none;padding:38px max(32px,calc((100% - 1400px)/2)) 64px;margin:0}
#cars .eyebrow{display:none}
#cars h2{font-size:clamp(28px,3vw,38px);margin:0 0 8px;color:#111827}
#cars h2:after{content:"";display:inline-block}
#cars .sub{color:#667085;font-size:15px;margin-bottom:26px}
.cars{grid-template-columns:repeat(4,minmax(0,1fr));gap:22px}
.cars>.card{background:#fff;color:#111827;border:1px solid #e3e7ed;border-radius:12px;overflow:hidden;padding:0;box-shadow:0 6px 22px #15223810}
.car-photo{height:auto;aspect-ratio:16/10;background-size:cover}
.car-body{padding:16px}
.car-body h3{font-size:17px;color:#172033}
.car-specs{color:#667085;font-size:13px}
.car-foot{border-color:#edf0f4}
.car-price{font-size:17px;color:#111827}
.car-link{color:var(--red)}
#order,#reviews,#telegram,#request{color:#172033}
#order .card,#reviews .card{background:#fff;color:#172033;border-color:#e4e8ef}
#order .card p,#reviews .review-text{color:#667085}
#order .get{background:#fff;color:#172033;border-color:#e4e8ef}
#order .get ul{color:#475467}
#reviews .sub{color:#667085}
#request .form-card{background:#fff;color:#172033;border-color:#e4e8ef}
#request .form-intro,#request .hint{color:#667085}
footer{background:#071321;color:#aeb9c8}
@media(max-width:1100px){
 .nav{gap:12px}.nav-links{gap:12px;font-size:12px}.nav-telegram{display:none}
 .cars{grid-template-columns:repeat(2,minmax(0,1fr))}
 .benefit-grid{gap:6px}.benefit-grid article{padding:8px}
}
@media(max-width:780px){
 .wrap{width:calc(100% - 32px)}
 .topbar{position:sticky;top:0;z-index:20}
 .nav{min-height:72px;gap:10px}
 .brand{font-size:17px}.brand small{font-size:7px}
 .nav-links{display:none}
 .nav .pill{padding:11px 14px;font-size:12px}
 .hero-standard{height:500px;align-items:flex-start}
 .hero-standard-bg .hero-slide{background-position:62% center}
 .hero-standard-bg:after{background:linear-gradient(90deg,#06111fe8 0%,#06111fa8 54%,#06111f35 100%),linear-gradient(0deg,#06111f66,transparent 45%)}
 .hero-standard-content{padding-top:52px}
 .hero-standard h1{font-size:clamp(44px,11vw,58px);margin:16px 0}
 .hero-standard .intro{font-size:15px;max-width:300px}
 .hero-standard .btn{width:auto;min-width:0;padding:14px 22px}
 .hero-standard .hero-dots{margin:42px 0 0 36%}
 .hero-arrow{top:auto;bottom:24px;width:34px;height:34px;font-size:24px}
 .hero-prev{left:12px}.hero-next{right:12px}
 .benefit-strip{padding:15px 0}
 .benefit-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
 .benefit-grid article{gap:9px;padding:9px 3px;border-right:0}
 .benefit-icon{flex-basis:42px;height:42px;font-size:20px}
 .benefit-grid b{font-size:11px}.benefit-grid small{font-size:10px;margin-top:4px}
 #cars{padding:30px 16px 42px}
 #cars h2{font-size:26px}
 #cars .sub{font-size:13px}
 .cars{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
 .car-photo{aspect-ratio:4/3;height:auto}
 .car-body{padding:11px}
 .car-body h3{font-size:13px}
 .car-specs{font-size:11px}
 .car-price{font-size:14px}
 #order,#reviews,#telegram,#request{padding-top:42px!important}
}
@media(max-width:380px){
 .nav .pill{font-size:11px;padding:10px}
 .hero-standard{height:470px}
 .benefit-grid b{font-size:10px}
 .cars{gap:8px}
}
#cars{background:var(--bg);color:var(--text)}
#cars .sub{color:var(--muted)}
#cars .cars>.card{background:var(--panel);border:1px solid var(--line);color:var(--text);box-shadow:0 12px 34px #0005}
#cars .cars>.card .car-body{color:var(--text)}
#cars .cars>.card .car-body p{color:var(--muted)}
#cars .cars>.card .car-body .car-specs{color:#c7c9d0}
#cars .cars>.card .car-text{color:#c7c9d0}
.brand-logo{display:block;width:250px;max-width:100%;height:auto}
@media(max-width:900px){.brand-logo{width:205px}}
#cars .car-card .car-gallery{margin:0 0 16px;aspect-ratio:16/10;min-height:220px;border:1px solid #ffffff16}
#cars .car-card .car-body{padding:18px 20px 20px}
#cars .car-card .car-body h3{font-size:clamp(17px,1.8vw,21px);line-height:1.25;margin:0 0 10px}
#cars .car-card .car-text{max-width:none;font-size:14px;line-height:1.6;margin:0 0 14px;overflow-wrap:anywhere}
#cars .car-card .car-link{display:inline-flex;align-items:center;justify-content:center;min-height:42px;padding:9px 14px;border:1px solid #ff4b3566;border-radius:12px;background:#ff4b3514;font-size:13px;font-weight:800}
#cars .car-card .car-link:hover{background:#ff4b35;color:#fff}
@media(max-width:780px){#cars .car-card .car-gallery{min-height:180px;margin-bottom:13px}#cars .car-card .car-body{padding:13px}#cars .car-card .car-text{font-size:13px}}

/* Unified vehicle description typography and responsive text rhythm */
body{font-family:"Inter",system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
h1,h2,h3,h4,.brand,.car-link{font-family:"Manrope","Inter",system-ui,sans-serif}
#cars .car-card .car-body{display:flex;flex-direction:column;align-items:stretch}
#cars .car-card .car-trim{order:0;align-self:flex-start;margin:0 0 5px;color:#ff806e;font:800 11px/1.3 "Manrope",sans-serif;letter-spacing:.14em;text-transform:uppercase}\n#cars .car-card .car-body h3{font-family:"Manrope",sans-serif;font-size:clamp(17px,1.45vw,21px);font-weight:800;line-height:1.28;letter-spacing:-.025em;margin:0 0 12px;overflow-wrap:anywhere;text-transform:uppercase}
#cars .car-description{display:grid;gap:11px;margin:0 0 16px;color:#c7c9d0;font-size:14px;line-height:1.72;overflow-wrap:anywhere}
#cars .car-description-paragraph{margin:0;color:#c7c9d0}
#cars .car-description-heading{margin:5px 0 -3px;color:#fff;font:800 12px/1.4 "Manrope",sans-serif;letter-spacing:.09em;text-transform:uppercase}
#cars .car-description-row{display:grid;grid-template-columns:minmax(82px,.72fr) minmax(0,1.28fr);gap:12px;padding:8px 10px;border:1px solid #ffffff12;border-radius:9px;background:#ffffff06}
#cars .car-description-row strong{color:#aeb9c8;font-size:12px;font-weight:700}
#cars .car-description-row span{color:#f4f6f9;font-weight:600}
#cars .car-description-list{display:grid;gap:6px;margin:0;padding:0;list-style:none}
#cars .car-description-list li{position:relative;padding-left:18px;color:#d8dde5}
#cars .car-description-list li:before{content:"";position:absolute;left:2px;top:.72em;width:6px;height:6px;border-radius:50%;background:var(--red)}
#cars .car-card .car-link{align-self:flex-start;margin-top:auto}
@media(max-width:780px){
 #cars .car-card .car-body h3{font-size:15px;line-height:1.3;margin-bottom:9px}
 #cars .car-description{font-size:12px;line-height:1.62;gap:8px;margin-bottom:12px}
 #cars .car-description-row{grid-template-columns:1fr;gap:2px;padding:7px 9px}
 #cars .car-description-row strong{font-size:10px}
 #cars .car-description-row span{font-size:12px}
 #cars .car-description-heading{font-size:10px}
 #cars .car-description-list{gap:4px}
 #cars .car-card .car-link{width:100%;justify-content:center}
}
@media(max-width:380px){
 #cars .car-description{font-size:11px}
 #cars .car-description-row{padding:6px 8px}
}

/* Mobile catalog: remove redundant vertical whitespace around the listing */
@media(max-width:780px){
  #cars{padding:16px 14px 24px!important}
  #cars h2{margin:0 0 12px}
  #cars .sub{display:none!important}
}
/* 2026-11-11 owner visual refinement: compact header, hero and section rhythm */
.topbar{border-bottom:1px solid #ffffff16;box-shadow:none}
.nav{min-height:68px;gap:14px}
.brand-logo{width:205px}
.nav-telegram{gap:7px;font-size:12px}
.nav-telegram>span{width:32px;height:32px;font-size:16px}
.nav-telegram small{font-size:10px}
.nav .pill{padding:10px 17px;font-size:13px}
.section{padding:58px 0}
.hero-standard{height:clamp(360px,31vw,445px)}
.get{margin-top:12px;padding:20px 24px;gap:22px}
.get-title{font-size:19px;line-height:1.3}
.get ul{gap:10px 18px;line-height:1.5;color:#f4f7fb}
.get li{padding:12px 14px;border:1px solid #3a485a;border-radius:12px;background:#202a36;color:#f4f7fb;font-weight:600}
.get li::marker{color:var(--red)}
#order.section{padding-top:30px!important;padding-bottom:28px!important}
#reviews.section{padding-top:12px!important}
@media(max-width:900px){.brand-logo{width:185px}.nav{gap:10px}.nav-links{gap:14px}}
@media(max-width:780px){
 .nav{min-height:60px}
 .brand-logo{width:158px}
 .nav-telegram>span{width:29px;height:29px}
 .nav .pill{padding:9px 12px;font-size:12px}
 .section{padding:30px 0}
 .hero-standard{height:380px}
 #order.section{padding-top:24px!important;padding-bottom:20px!important}
 #reviews.section{padding-top:10px!important}
 .get{padding:16px;gap:10px}
 .get ul{gap:8px}
 .get li{padding:12px;background:#263342;border-color:#526176;color:#fff;font-size:14px;line-height:1.45}
}
@media(max-width:480px){
 .hero-standard{height:345px}
 .hero-standard h1{font-size:42px}
 .hero-standard .intro{font-size:15px}
 .hero-standard .btn{min-width:0;padding:12px 20px;margin-top:18px}
 .nav-telegram b{font-size:11px}
 .nav-telegram small{font-size:9px}
 .get ul{grid-template-columns:1fr}
}

/* Mobile catalogue hardening: readable title, compact cards and no stretched grid rows */
#cars h2{color:#f4f6f9!important}
#cars .cars{align-items:start;grid-auto-rows:max-content}
#cars .car-card{align-self:start;min-height:0;height:auto}
#cars .car-card .car-gallery{width:100%;min-height:0;aspect-ratio:16/10;overflow:hidden;border-radius:15px;background:#090e16}
#cars .car-gallery-stage{position:relative;width:100%;height:100%;min-height:0;aspect-ratio:16/10;overflow:hidden}
#cars .car-gallery-main{display:block;width:100%;height:100%;min-height:0;aspect-ratio:16/10;object-fit:cover;background:#090e16}
#cars .car-card .car-description{margin-bottom:12px}
@media(max-width:780px){
 #cars .cars{grid-template-columns:minmax(0,1fr);gap:14px;align-items:start}
 #cars .car-card{width:100%;height:auto;min-height:0}
 #cars .car-card .car-gallery{aspect-ratio:16/10;min-height:0;margin:0 0 12px}
 #cars .car-gallery-stage{aspect-ratio:16/10;min-height:0}
 #cars .car-gallery-main{aspect-ratio:16/10;min-height:0}
 #cars h2{color:#f4f6f9!important;font-size:clamp(24px,6vw,30px);line-height:1.2}
}

/* AVTOY KOREA 2026 Pro Showroom Theme & Interactive Catalogue Controls */
:root{--bg:#070c14;--panel:#101723;--panel-2:#162032;--line:#253247;--text:#f4f7fc;--muted:#9aa9be;--red:#f12f38}
body{background:radial-gradient(ellipse at 78% 0%,#16253b 0,transparent 40%),#070c14!important;color:#f4f7fc!important}
#cars,#order,#reviews,#request{background:transparent!important;color:#f4f7fc!important}
#order .card,#reviews .card,#request .form-card,#order .get{background:linear-gradient(155deg,#151f30,#0e1521)!important;color:#f4f7fc!important;border:1px solid #263349!important;box-shadow:0 18px 46px #0006!important}
#order .card p,#reviews .review-text,#request .form-intro,#request .hint,#cars .sub,#reviews .sub,#order .sub{color:#9fb0c7!important}
#order .get ul{color:#e5ecf6!important}
.cars>.card{background:linear-gradient(160deg,#151f30,#0d1420)!important;color:#f4f7fc!important;border:1px solid #26344b!important;border-radius:18px!important;box-shadow:0 16px 40px #0006!important;display:flex!important;flex-direction:column!important}
.cars>.card:hover{border-color:#f12f3888!important;transform:translateY(-4px)}
#cars .car-card .car-body{flex:1;display:flex;flex-direction:column;padding:18px!important}
#cars .car-card .car-body h3{color:#f8fafc!important;font-size:18px!important;margin:0 0 10px!important}
.catalog-toolbar{display:flex;flex-direction:column;gap:14px;margin:18px 0 24px;padding:16px 18px;border-radius:18px;background:linear-gradient(150deg,#131c2b,#0d1420);border:1px solid #253247}
.catalog-search-row{display:grid;grid-template-columns:1fr 230px;gap:12px}
.catalog-input,.catalog-select{width:100%;background:#080d16;border:1px solid #2b3a52;border-radius:12px;color:#f4f7fc;padding:12px 14px;font-size:14px;outline:none}
.catalog-input:focus,.catalog-select:focus{border-color:var(--red);box-shadow:0 0 0 3px #f12f3825}
.catalog-brands{display:flex;gap:8px;flex-wrap:wrap}
.brand-chip{border:1px solid #2a3950;background:#0b121e;color:#cbd5e1;padding:8px 14px;border-radius:999px;font-size:13px;font-weight:700;cursor:pointer;transition:all .16s}
.brand-chip:hover{border-color:#f12f3880;color:#fff}
.brand-chip.is-active{background:var(--red);border-color:var(--red);color:#fff;box-shadow:0 6px 18px #f12f3835}
.car-badges{position:absolute;top:10px;left:10px;z-index:3;display:flex;gap:6px;flex-wrap:wrap;pointer-events:none}
.car-badge{padding:4px 10px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;backdrop-filter:blur(8px)}
.car-badge.is-new{background:#15803de6;color:#dcfce7;border:1px solid #22c55e80}
.car-badge.is-video{background:#f12f38e6;color:#fff}
.car-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.car-chip{padding:5px 9px;border-radius:8px;background:#0a101b;border:1px solid #243146;color:#d4deec;font-size:12px;font-weight:600}
.car-Card-pricebox{margin-top:auto;padding-top:14px;border-top:1px solid #222f43;display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px}
.car-price-val{font:900 21px/1.1 "Manrope",sans-serif;color:#fff}
.car-price-note{font-size:11px;color:#93a4bc;text-align:right}
.car-actions-row{display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:stretch}
.car-spec-btn{padding:10px 12px;min-height:42px;border-radius:11px;border:1px solid #2c3b54;background:#0b121e;color:#dbe4f0;font-weight:700;font-size:12.5px;cursor:pointer;white-space:nowrap}
.car-spec-btn:hover{border-color:#f12f38;color:#fff}
#cars .car-card .car-link{display:inline-flex;align-items:center;justify-content:center;padding:10px 12px;min-height:42px;border-radius:11px;background:var(--red);color:#fff!important;font-weight:800;font-size:12.5px;line-height:1.2;width:100%;text-align:center;box-shadow:0 8px 20px #f12f3828}
@media(min-width:781px) and (max-width:1180px){#cars .cars{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;overflow:visible}}
@media(min-width:1181px){#cars .cars{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;overflow:visible}}
#cars .car-card.is-upgraded .car-description{display:none}
.selected-car-banner{display:none;align-items:center;justify-content:space-between;gap:10px;padding:11px 14px;margin-bottom:14px;border-radius:12px;background:#f12f381c;border:1px solid #f12f3866;color:#ffd7d9;font-size:13px;font-weight:700}
.selected-car-banner.is-visible{display:flex}
.selected-car-banner button{background:none;border:0;color:#fff;font-size:18px;cursor:pointer;padding:0 4px}
.car-modal{position:fixed;inset:0;z-index:1000;background:rgba(4,7,13,.88);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:18px}
.car-modal-dialog{width:min(960px,100%);max-height:90vh;overflow-y:auto;background:#0f1724;border:1px solid #2b3a52;border-radius:22px;padding:24px;color:#f4f7fc;box-shadow:0 28px 80px #000b}
.car-modal-grid{display:grid;grid-template-columns:1.15fr .85fr;gap:22px;margin-top:14px}
.car-modal-stage{aspect-ratio:16/10;background:#060a11;border-radius:14px;overflow:hidden;display:flex;align-items:center;justify-content:center;border:1px solid #233146}
.car-modal-stage img,.car-modal-stage video{width:100%;height:100%;object-fit:contain}
.car-modal-thumbs{display:flex;gap:7px;overflow-x:auto;padding:10px 0 4px}
.car-modal-thumbs button{flex:0 0 74px;height:52px;padding:0;border-radius:8px;overflow:hidden;border:2px solid transparent;background:#060a11;cursor:pointer}
.car-modal-thumbs button.is-active{border-color:var(--red)}
.car-modal-thumbs img{width:100%;height:100%;object-fit:cover}
.car-modal-specs{display:grid;gap:7px;margin:12px 0 16px}
.review-story{margin:12px 0 0;color:#d0dae8;font-size:14px;line-height:1.58;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.review-story.is-open{display:block;-webkit-line-clamp:unset}
.review-more{margin-top:6px;padding:0;border:0;background:none;color:#ff806e;font-size:12px;font-weight:700;cursor:pointer;align-self:flex-start}
#news{background:transparent!important;color:#f4f7fc!important}
#news .sub{color:#9fb0c7!important}
.news-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
.news-grid.is-single{grid-template-columns:minmax(0,1fr)}
.news-card{background:linear-gradient(155deg,#162133,#0e1522)!important;border:1px solid #2b3b55!important;border-radius:22px!important;padding:22px!important;box-shadow:0 18px 48px #0006!important;display:flex;flex-direction:column;gap:16px}
.news-grid.is-single .news-card.has-media{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:26px;align-items:center}
.news-media-wrap{position:relative;border-radius:16px;overflow:hidden;background:#070b12;border:1px solid #243248;padding:10px;display:flex;align-items:center;justify-content:center;cursor:zoom-in}
.news-media-wrap img,.news-media-wrap video{width:100%;height:auto;max-height:460px;object-fit:contain;display:block;border-radius:10px}
.news-zoom-hint{position:absolute;right:10px;bottom:10px;padding:5px 10px;border-radius:999px;background:#070c14d9;border:1px solid #ffffff26;color:#dbe6f5;font-size:11px;font-weight:700;pointer-events:none}
.news-content{display:flex;flex-direction:column;gap:12px;align-items:flex-start}
.news-badge{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;background:#1e3a8a66;border:1px solid #3b82f666;color:#bfdbfe}
.news-badge.is-urgent{background:#7c2d1266;border-color:#f9731680;color:#fed7aa}
.news-title{margin:0;font:800 clamp(19px,2vw,25px)/1.25 "Manrope",sans-serif;color:#fff}
.news-body{display:grid;gap:9px;color:#cbd5e1;font-size:15px;line-height:1.65}
.news-body p{margin:0}
.news-cta{margin-top:6px;display:inline-flex;align-items:center;gap:8px;padding:12px 18px;border-radius:12px;background:#f12f381f;border:1px solid #f12f3870;color:#fff;font-weight:800;font-size:13.5px;transition:background .16s}
.news-cta:hover{background:var(--red);color:#fff}
.nav-messengers{display:flex;align-items:center;gap:10px}
.nav-max{display:flex;align-items:center;gap:8px;white-space:nowrap;font-size:12px;padding:6px 12px 6px 7px;border-radius:999px;background:linear-gradient(135deg,#5b21b638,#2563eb30);border:1px solid #8b5cf670;color:#f5f3ff;transition:transform .16s,border-color .16s}
.nav-max:hover{transform:translateY(-1px);border-color:#a78bfa;background:linear-gradient(135deg,#6d28d966,#2563eb55)}
.nav-max>span{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#7c3aed,#2563eb);color:#fff;font-weight:900;font-size:13px;box-shadow:0 4px 12px #7c3aed55}
.nav-max small{display:block;color:#c4b5fd;font-size:10px;margin-top:1px;font-weight:600}
.hero-actions-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:24px}
.hero-actions-row .btn{margin-top:0!important}
.btn-max{display:inline-flex;align-items:center;justify-content:center;gap:10px;border-radius:28px;padding:14px 24px;font-weight:800;font-size:15px;background:linear-gradient(135deg,#6d28d9e6,#2563ebe6);border:1px solid #a78bfa88;color:#fff!important;box-shadow:0 10px 28px #6d28d945;backdrop-filter:blur(8px);transition:transform .18s,box-shadow .18s}
.btn-max:hover{transform:translateY(-2px);box-shadow:0 14px 34px #6d28d970}
.btn-max-badge{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;background:#ffffff24;font-size:12px;font-weight:900}
.direct-channels{display:grid;gap:10px;margin-top:18px}
.channel-btn{display:flex;align-items:center;gap:12px;padding:12px 15px;border-radius:14px;background:#0a101b;border:1px solid #28364f;color:#f4f7fc;transition:border-color .16s,transform .16s}
.channel-btn:hover{transform:translateY(-2px);border-color:#60a5fa}
.channel-btn.is-max{background:linear-gradient(135deg,#2e106555,#1e3a8a40);border-color:#7c3aed80}
.channel-btn.is-max:hover{border-color:#a78bfa}
.channel-icon{flex:0 0 38px;height:38px;border-radius:11px;display:grid;place-items:center;font-weight:900;font-size:16px;color:#fff;background:#229ed9}
.channel-btn.is-max .channel-icon{background:linear-gradient(135deg,#7c3aed,#2563eb)}
.channel-btn b{display:block;font-size:14px;line-height:1.25}
.channel-btn small{display:block;color:#9fb0c7;font-size:12px;margin-top:2px}
.footer-links{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.footer-max{display:inline-flex;align-items:center;gap:7px;padding:6px 12px;border-radius:999px;background:#7c3aed28;border:1px solid #8b5cf666;color:#ddd6fe;font-weight:700}
.footer-max:hover{background:#7c3aed;color:#fff}
.faq-list{display:grid;gap:10px;margin-bottom:24px}
.faq-item{background:linear-gradient(155deg,#151f30,#0e1521);border:1px solid #26344b;border-radius:16px;padding:15px 18px}
.faq-item summary{font-weight:800;font-size:15.5px;color:#fff;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:12px}
.faq-item summary::after{content:"+";font-size:20px;color:var(--red);font-weight:700}
.faq-item[open] summary::after{content:"−"}
.faq-item p{margin:10px 0 0;color:#b8c4d6;font-size:14px;line-height:1.6}
.seo-links-box{background:#0b111c;border:1px solid #223047;border-radius:16px;padding:16px 18px}
.seo-links-box h3{margin:0 0 10px;font-size:14px;color:#9fb0c7;text-transform:uppercase;letter-spacing:.08em}
.seo-links-nav{display:flex;flex-wrap:wrap;gap:8px}
.seo-links-nav a{font-size:12.5px;color:#d6e0ef;background:#131d2d;border:1px solid #26364f;border-radius:999px;padding:6px 12px}
.seo-links-nav a:hover{border-color:var(--red);color:#fff}
@media(max-width:1180px){
 .nav-telegram small,.nav-max small{display:none}
 .nav-telegram{display:flex!important}
}
@media(max-width:1060px){
 .brand-logo{width:152px}
 .nav-links .nav-home{display:none}
 .nav-telegram b{display:none}
 .nav-max{padding:5px 10px 5px 6px;font-size:11.5px}
 .nav .pill{padding:9px 13px;font-size:12px}
}
@media(max-width:900px){
 .news-grid,.news-grid.is-single .news-card.has-media{grid-template-columns:1fr}
 .nav-links a[href="#order"]{display:none}
}
@media(max-width:780px){
 .catalog-search-row{grid-template-columns:1fr}
 .car-modal-grid{grid-template-columns:1fr}
 .car-actions-row{grid-template-columns:1fr}
 .news-card{padding:16px!important}
 .nav-telegram{display:none!important}
 .nav-max{padding:6px 10px;font-size:11px}
 .hero-standard{height:430px}
 .hero-actions-row{gap:8px;margin-top:16px}
 .btn-max{padding:12px 18px;font-size:13.5px}
}
</style>
</head>
<body>
<header class="topbar"><div class="wrap nav">
  <a class="brand" href="#" aria-label="AVTOY KOREA — главная">
    <img class="brand-logo" src="/assets/logo.jpg" alt="AVTOY KOREA — автомобили из Кореи" width="380" height="148">
  </a>
  <nav class="nav-links" aria-label="Основная навигация">
    <a class="nav-home" href="#">Главная</a><a href="#cars">Каталог</a><a href="#news">Новости</a><a href="#order">Услуги</a><a href="#reviews">Отзывы</a><a href="#request">Контакты</a>
  </nav>
  <div class="nav-messengers">
    <a class="nav-telegram" href="https://t.me/avtoYkorea" target="_blank" rel="noopener"><span>➤</span><b>Telegram<small>@avtoYkorea</small></b></a>
    <a class="nav-max" ${maxHrefAttr} data-max-bot-link="1"><span>M</span><b>Бот в MAX<small>Подбор в РФ</small></b></a>
  </div>
  <a class="pill" href="#request">Оставить заявку</a>
</div></header>

<main>
<section class="hero-standard">
  <div class="hero-standard-bg">
    <div class="hero-slide active" role="img" aria-label="Kia Sportage 2026, обновлённый дизайн" data-model="Kia Sportage" style="background-image:url('https://images.carexpert.com.au/resize/1920/-/cms/v1/media/2025-11-2026-250924kia-sportage-sxstill-7.jpg')"></div>
    <div class="hero-slide" role="img" aria-label="Kia K5 2026 GT-Line" data-model="Kia K5" style="background-image:url('https://vehicle-images.carscommerce.inc/c296-18004034/KNAG64J7XT5407697/f77dca20312f1d8e2fc1db6f7841acfb.jpg')"></div>
    <div class="hero-slide" role="img" aria-label="Toyota RAV4 2026, новое поколение" data-model="Toyota RAV4" style="background-image:url('https://media.whichcar.com.au/uploads/2025/11/2026-Toyota-RAV4-1-1920x1280.jpeg')"></div>
  </div>
  <button class="hero-arrow hero-prev" type="button" aria-label="Предыдущий слайд">‹</button><button class="hero-arrow hero-next" type="button" aria-label="Следующий слайд">›</button>
  <div class="wrap hero-standard-content">
    <div class="eyebrow">ПРЯМЫЕ ПОСТАВКИ ИЗ КОРЕИ</div>
    <h1>Автомобили<br><span>из Кореи</span></h1>
    <p class="intro">Подбор автомобиля и доставка из Кореи<br>с учётом ваших требований.</p>
    <div class="hero-actions-row">
      <a class="btn btn-red" href="#cars">Перейти в каталог <b>→</b></a>
      <a class="btn-max" ${maxHrefAttr} data-max-bot-link="1"><span class="btn-max-badge">M</span>Бот подбора в MAX</a>
    </div>
    <div class="hero-dots"><button class="hero-dot active" type="button" aria-label="Kia Sportage" aria-current="true"></button><button class="hero-dot" type="button" aria-label="Kia K5" aria-current="false"></button><button class="hero-dot" type="button" aria-label="Toyota RAV4" aria-current="false"></button></div>
  </div>
  <div class="hero-model-name" aria-live="polite">Kia Sportage</div>
</section>
<section class="benefit-strip"><div class="wrap benefit-grid">
 <article><span class="benefit-icon">♧</span><div><b>Проверенные автомобили</b><small>Только честные предложения<br>и прозрачная история</small></div></article>
 <article><span class="benefit-icon">◇</span><div><b>Подбор под ваш запрос</b><small>Учитываем ваши пожелания<br>и бюджет</small></div></article>
 <article><span class="benefit-icon">▣</span><div><b>Быстрая доставка</b><small>Оптимальные сроки<br>и полное сопровождение</small></div></article>
 <article><span class="benefit-icon">♧</span><div><b>Поддержка 24/7</b><small>Всегда на связи<br>на всех этапах</small></div></article>
</div></section>

<section class="wrap section" id="about" style="padding-bottom:20px"><div class="eyebrow">AVTOY KOREA</div><h2>Автомобили из Кореи под ваш запрос</h2><p class="sub">Помогаем выбрать автомобиль, проверить его перед покупкой и организовать доставку. Сопровождаем на каждом этапе.</p></section>
<section class="wrap section" id="cars" style="padding-top:20px">
  <div class="eyebrow">Наши автомобили</div>
  <h2>Автомобили в продаже и под заказ</h2>
  <p class="sub">Проверенные автомобили из Южной Кореи, Китая и ОАЭ с расчётом стоимости под ключ.</p>
  <div class="catalog-toolbar" id="cars-toolbar" hidden>
    <div class="catalog-search-row">
      <input class="catalog-input" id="cars-search" type="search" placeholder="Поиск по марке, модели, комплектации, городу или году…">
      <select class="catalog-select" id="cars-sort" aria-label="Сортировка автомобилей">
        <option value="newest">Сначала новые поступления</option>
        <option value="price_asc">Сначала дешевле</option>
        <option value="price_desc">Сначала дороже</option>
      </select>
    </div>
    <div class="catalog-brands" id="cars-brands" role="tablist" aria-label="Фильтр по маркам"></div>
  </div>
  <div class="cars" id="cars-list">${ssrCarsHtml}</div>
  <p class="cars-hint" id="cars-empty-filter" hidden>По выбранному фильтру ничего не найдено — попробуйте сбросить фильтр.</p>
</section>
<section class="wrap section" id="order" style="padding-top:40px">
  <div class="eyebrow">Как заказать</div>
  <h2>Четыре шага до вашего автомобиля</h2>
  <p class="sub">Заполните короткую форму. Заявка приходит обоим администраторам лично. Они свяжутся с вами по указанному контакту.</p>
  <div class="steps">
    <article class="card"><div class="num">01</div><h3>Заполните форму</h3><p>Марка и модель, бюджет, страна покупки, год выпуска и пожелания.</p></article>
    <article class="card"><div class="num">02</div><h3>Получите предложения</h3><p>Подбираем варианты под ваш бюджет и связываемся с вами по указанному контакту.</p></article>
    <article class="card"><div class="num">03</div><h3>Проверьте перед покупкой</h3><p>Оцениваем состояние автомобиля и документы до решения о покупке.</p></article>
    <article class="card"><div class="num">04</div><h3>Доставка и итог</h3><p>Стоимость доставки и итоговая цена обсуждаются с вами отдельно.</p></article>
  </div>
  <div class="get">
    <div class="get-title">Что вы получите после заявки</div>
    <ul>
      <li>Предложения под ваш бюджет</li>
      <li>Ориентировочную стоимость доставки</li>
      <li>Расчёт по курсу юаня для автомобилей из Китая</li>
      <li>Условия покупки и сроки доставки</li>
    </ul>
  </div>
</section>

<section class="wrap section" id="news" style="padding-top:24px" hidden>
  <div class="eyebrow">Важная информация</div>
  <h2>Новости и изменения рынка</h2>
  <p class="sub">Актуальные разборы утильсбора, таможенных правил, курсов валют и условий привоза автомобилей.</p>
  <div class="news-grid" id="news-list" aria-label="Новости компании и авторынка"></div>
</section>

<section class="wrap section" id="reviews" style="padding-top:20px">
  <h2>Отзывы наших клиентов</h2>
  <p class="sub">Публикуем отзывы только с согласия клиентов.</p>
  <div class="review-carousel">
    <div class="reviews" id="reviews-list" aria-label="Отзывы клиентов">
      <article class="card dashed"><div class="review-name" style="margin-top:0">Скоро здесь появятся отзывы</div><p class="review-text">Клиенты, которые уже купили автомобиль через нас, смогут поделиться опытом.</p></article>
    </div>
    <div class="review-controls">
      <div class="review-dots" id="review-dots" aria-label="Выбрать отзыв"></div>
      <div class="review-arrows">
        <button class="review-arrow" id="reviews-prev" type="button" aria-label="Предыдущие отзывы">‹</button>
        <button class="review-arrow" id="reviews-next" type="button" aria-label="Следующие отзывы">›</button>
      </div>
    </div>
  </div>
</section>


${ssrFaqAndLinksHtml}

<section class="wrap section" id="request" style="padding-top:20px">
  <div class="form-card">
    <div>
      <div class="eyebrow">Бесплатный подбор</div>
      <h2>Какой автомобиль вы ищете?</h2>
      <p class="form-intro">Оставьте параметры автомобиля и удобный контакт. Заявка мгновенно поступает менеджерам одновременно в <b>MAX</b> и <b>Telegram</b>.</p>
      <div class="direct-channels">
        <a class="channel-btn is-max" ${maxHrefAttr} data-max-bot-link="1">
          <span class="channel-icon">M</span>
          <span><b>Написать в бот MAX</b><small>Быстрая связь в России без ограничений</small></span>
        </a>
        <a class="channel-btn" href="https://t.me/avtoYkorea" target="_blank" rel="noopener">
          <span class="channel-icon">➤</span>
          <span><b>Канал в Telegram (@avtoYkorea)</b><small>Свежие поступления, обзоры и цены</small></span>
        </a>
      </div>
      <p class="hint" style="margin-top:14px">Можно обратиться и по вопросам рекламы, партнёрства или размещения предложений.</p>
    </div>
    <div>
      <div class="selected-car-banner" id="selected-car-banner"><span id="selected-car-label"></span><button type="button" id="selected-car-clear" aria-label="Сбросить выбранный автомобиль">×</button></div>
      <form id="request-form" novalidate>
        <div class="form-grid">
          <div class="field"><label for="name">Ваше имя *</label><input id="name" name="name" required maxlength="100" autocomplete="name" placeholder="Как к вам обращаться"></div>
          <div class="field"><label for="contact">Телефон, MAX или Telegram *</label><input id="contact" name="contact" required maxlength="150" autocomplete="tel" placeholder="Номер телефона, MAX или @username"></div>
          <div class="field"><label for="model">Марка / модель</label><input id="model" name="model" maxlength="150" placeholder="Например, Kia Sorento"></div>
          <div class="field"><label for="budget">Бюджет</label><input id="budget" name="budget" maxlength="100" placeholder="Например, 3 000 000 ₽"></div>
          <div class="field"><label for="country">Страна покупки</label><select id="country" name="country"><option value="">Пока не решил(а)</option><option>Южная Корея</option><option>Китай</option><option>ОАЭ</option></select></div>
          <div class="field"><label for="year">Год выпуска от</label><input id="year" name="year" maxlength="30" placeholder="Например, 2021"></div>
          <div class="field full"><label for="purpose">Тема обращения</label><select id="purpose" name="purpose"><option value="Подбор автомобиля">Подбор автомобиля</option><option value="Реклама и продвижение">Реклама и продвижение</option><option value="Партнёрство">Партнёрство</option><option value="Другое">Другое</option></select></div>
          <div class="field full"><label for="details">Пожелания</label><textarea id="details" name="details" maxlength="1000" placeholder="Комплектация, пробег, тип двигателя и другое"></textarea></div>
        </div>
        <div class="form-foot">
          <button class="btn btn-red" type="submit" id="submit-btn">Отправить заявку →</button>
          <span class="hint">Оставляя заявку, вы соглашаетесь на обратную связь по вашему обращению.</span>
        </div>
        <div class="status" id="status" role="status" aria-live="polite"></div>
      </form>
    </div>
  </div>
</section>
</main>

<footer><div class="wrap footer-row">
  <a class="brand" href="#">AVTO<em>Y</em> KOREA</a>
  <span>Автомобили под заказ · Корея · Китай · ОАЭ</span>
  <div class="footer-links">
    <a class="footer-max" ${maxHrefAttr} data-max-bot-link="1"><span>M</span> Бот в MAX ↗</a>
    <a class="telegram" href="https://t.me/avtoYkorea" target="_blank" rel="noopener">Telegram ↗</a>
  </div>
</div></footer>

<script>
// Все кнопки заявки ведут к одной форме и переводят фокус на первое обязательное поле.
document.querySelectorAll('a[href="#request"]').forEach(function(link){
  link.addEventListener('click',function(event){
    var section=document.getElementById('request');
    var firstField=document.getElementById('name');
    if(!section||!firstField)return;
    event.preventDefault();
    section.scrollIntoView({behavior:'smooth',block:'start'});
    window.setTimeout(function(){firstField.focus({preventScroll:true});},350);
    if(history.replaceState)history.replaceState(null,'','#request');
  });
});
const form=document.getElementById('request-form'),statusEl=document.getElementById('status');
function showFormStatus(message,isError){
 statusEl.textContent=message;
 statusEl.style.display='block';
 statusEl.style.padding='12px 14px';
 statusEl.style.marginTop='14px';
 statusEl.style.borderRadius='10px';
 statusEl.style.background=isError?'#3a1717':'#123326';
 statusEl.style.color='#fff';
 statusEl.setAttribute('role','status');
}
form.addEventListener('submit',async function(e){
 e.preventDefault();
 const b=document.getElementById('submit-btn');
 const entered=Object.fromEntries(new FormData(form).entries());
 let pending=null;
 try{pending=JSON.parse(sessionStorage.getItem('avtoy_pending_request')||'null')}catch{}
 if(pending&&pending.key&&pending.payload&&JSON.stringify(pending.payload)===JSON.stringify(entered)){
  window.requestIdempotencyKey=pending.key;
 }else{
  window.requestIdempotencyKey=crypto.randomUUID();
  pending={key:window.requestIdempotencyKey,payload:entered};
  try{sessionStorage.setItem('avtoy_pending_request',JSON.stringify(pending))}catch{}
 }
 const data=pending.payload||entered;
 if(!String(data.name||'').trim()||!String(data.contact||'').trim()){
  showFormStatus('Заполните имя и телефон или Telegram для связи.',true);
  return;
 }
 b.disabled=true;
 b.textContent='Отправляем…';
 showFormStatus('Отправляем заявку администраторам…',false);
 try{
  const r=await fetch('/api/request',{method:'POST',headers:{'content-type':'application/json','accept':'application/json','idempotency-key':window.requestIdempotencyKey},body:JSON.stringify(data)});
  const raw=await r.text();
  let x;
  try{x=JSON.parse(raw)}catch{x={ok:false,error:'Сервер вернул некорректный ответ. Попробуйте позже.'}}
  if(!r.ok||!x.ok)throw new Error(x.error||('Ошибка отправки: HTTP '+r.status));
  if(x.setupNeeded){
   showFormStatus('Заявка подготовлена. Откроется Telegram — выберите чат менеджера и отправьте сообщение.',false);
   location.href='https://t.me/share/url?url='+encodeURIComponent(location.origin)+'&text='+encodeURIComponent(x.telegramText);
  }else{
   showFormStatus('Заявка доставлена администраторам. Спасибо! Свяжемся с вами по указанному контакту.',false);
   form.reset();
   window.requestIdempotencyKey=null;
   try{sessionStorage.removeItem('avtoy_pending_request')}catch{}
   if(x.botLink){
    const a=document.createElement('a');a.href=x.botLink;a.target='_blank';a.rel='noopener';a.textContent='Открыть Telegram, чтобы получать ответ здесь';
    statusEl.appendChild(document.createElement('br'));statusEl.appendChild(a);
   }
  }
 }catch(err){
  showFormStatus(err.message||'Не удалось отправить заявку. Проверьте соединение и попробуйте ещё раз.',true);
 }finally{
  b.disabled=false;
  b.textContent='Отправить заявку →';
 }
});
fetch('/api/reviews',{cache:'no-store'}).then(function(r){return r.json()}).then(function(data){
  var list=document.getElementById('reviews-list'),dots=document.getElementById('review-dots');
  var prev=document.getElementById('reviews-prev'),next=document.getElementById('reviews-next');
  if(!list||!data.reviews||!data.reviews.length)return;
  list.textContent='';dots.textContent='';
  data.reviews.forEach(function(rv,index){
    var card=document.createElement('article');card.className='card';
    var mediaItems=(Array.isArray(rv.mediaItems)&&rv.mediaItems.length?rv.mediaItems:(rv.media?[rv.media]:[])).map(function(item){
      if(typeof item==='string')return {url:item,type:rv.kind==='video'?'video':'photo'};
      return {url:item.url||item.src||'',type:item.type||'photo'};
    }).filter(function(item){return !!item.url;});
    if(mediaItems.length){
      var hasVideo=mediaItems.some(function(item){return item.type==='video';});
      var hasPhoto=mediaItems.some(function(item){return item.type!=='video';});
      if(hasVideo){var label=document.createElement('div');label.className='review-video-label';label.textContent=hasPhoto?'Фото и видео клиента':'Видео клиента';card.appendChild(label);}
      var gallery=document.createElement('div');gallery.className='review-gallery';
      var stage=document.createElement('div');stage.className='review-gallery-stage';gallery.appendChild(stage);
      var mediaIndex=0;
      var back=document.createElement('button');back.type='button';back.className='review-gallery-arrow is-prev';back.textContent='‹';back.setAttribute('aria-label','Предыдущее фото или видео');
      var forward=document.createElement('button');forward.type='button';forward.className='review-gallery-arrow is-next';forward.textContent='›';forward.setAttribute('aria-label','Следующее фото или видео');
      var counter=document.createElement('span');counter.className='review-gallery-count';
      function showReviewMedia(nextIndex){
        mediaIndex=(nextIndex+mediaItems.length)%mediaItems.length;
        var item=mediaItems[mediaIndex];stage.textContent='';
        if(item.type==='video'){
          var video=document.createElement('video');video.className='review-media';video.src=item.url;video.controls=true;video.playsInline=true;video.preload='none';video.style.width='100%';video.style.height='100%';video.style.objectFit='contain';video.setAttribute('aria-label','Видео клиента');stage.appendChild(video);
        }else{
          var link=document.createElement('a');link.className='review-gallery-photo';link.href=item.url;link.target='_blank';link.rel='noopener';
          var image=document.createElement('img');image.className='review-gallery-image';image.src=item.url;image.loading='eager';image.decoding='async';image.alt='Фотография автомобиля клиента '+(mediaIndex+1);
          link.appendChild(image);stage.appendChild(link);
        }
        counter.textContent=(mediaIndex+1)+' / '+mediaItems.length;
        back.disabled=mediaItems.length<2;forward.disabled=mediaItems.length<2;
        back.hidden=forward.hidden=mediaItems.length<2;counter.hidden=mediaItems.length<2;
      }
      back.addEventListener('click',function(){showReviewMedia(mediaIndex-1)});
      forward.addEventListener('click',function(){showReviewMedia(mediaIndex+1)});
      gallery.appendChild(back);gallery.appendChild(forward);gallery.appendChild(counter);
      var touchStart=0;
      gallery.addEventListener('touchstart',function(e){touchStart=e.changedTouches[0].clientX},{passive:true});
      gallery.addEventListener('touchend',function(e){var delta=e.changedTouches[0].clientX-touchStart;if(Math.abs(delta)>35)showReviewMedia(mediaIndex+(delta<0?1:-1))},{passive:true});
      showReviewMedia(0);card.appendChild(gallery);
    }
    if(rv.text&&String(rv.text).trim()&&String(rv.text).trim().toLowerCase()!=='отзыв'){
      var story=document.createElement('p');story.className='review-story';story.textContent=String(rv.text).trim();card.appendChild(story);
      if(String(rv.text).trim().length>160){
        var moreBtn=document.createElement('button');moreBtn.type='button';moreBtn.className='review-more';moreBtn.textContent='Читать полностью';
        moreBtn.addEventListener('click',function(){var open=story.classList.toggle('is-open');moreBtn.textContent=open?'Свернуть':'Читать полностью';});
        card.appendChild(moreBtn);
      }
    }
    list.appendChild(card);
    var dot=document.createElement('button');dot.type='button';dot.className='review-dot';dot.setAttribute('aria-label','Показать отзыв '+(index+1));
    dot.addEventListener('click',function(){list.scrollTo({left:card.offsetLeft-list.offsetLeft,behavior:'smooth'})});dots.appendChild(dot);
  });
  var dotItems=Array.from(dots.children);
  function updateReviewControls(){
    var maxScroll=list.scrollWidth-list.clientWidth,position=maxScroll>0?list.scrollLeft/maxScroll:0;
    var active=Math.round(position*Math.max(0,dotItems.length-1));
    dotItems.forEach(function(dot,i){dot.setAttribute('aria-current',i===active?'true':'false')});
    prev.disabled=list.scrollLeft<=2;next.disabled=list.scrollLeft>=maxScroll-2;
    dots.style.display=dotItems.length>1?'flex':'none';prev.parentElement.style.display=dotItems.length>1?'flex':'none';
  }
  prev.addEventListener('click',function(){list.scrollBy({left:-list.clientWidth*.85,behavior:'smooth'})});
  next.addEventListener('click',function(){list.scrollBy({left:list.clientWidth*.85,behavior:'smooth'})});
  list.addEventListener('scroll',updateReviewControls,{passive:true});window.addEventListener('resize',updateReviewControls);updateReviewControls();
}).catch(function(){});
// Каталог показывает только одобренные публикации из Telegram
function loadCars(){
fetch('/api/cars',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}).then(function(data){
 var list=document.getElementById('cars-list'); if(!list)return;
 if(!Array.isArray(data.cars))throw new Error('Invalid catalogue response');
 if(!data.cars.length){list.textContent='';var empty=document.createElement('article');empty.className='card dashed';var emptyBody=document.createElement('div');emptyBody.className='car-body';emptyBody.textContent='Сейчас нет активных объявлений. Новые предложения появятся после проверки администратора.';empty.appendChild(emptyBody);list.appendChild(empty);return;}
 list.textContent='';
 var NL=String.fromCharCode(10);
 var lightbox=null, items=[], current=0;
 function onKey(e){ if(e.key==='Escape')closeBox(); else if(e.key==='ArrowRight')show(current+1); else if(e.key==='ArrowLeft')show(current-1); }
 function closeBox(){ if(lightbox){ lightbox.remove(); lightbox=null; } document.removeEventListener('keydown', onKey); }
 function show(index){
  if(!lightbox||!items.length)return;
  current=(index+items.length)%items.length;
  var item=items[current], stage=lightbox.querySelector('.car-lightbox-stage');
  stage.textContent='';
  var el=document.createElement(item.video?'video':'img'); el.src=item.url;
  if(item.video){el.controls=true;el.playsInline=true;} else {el.alt='Фото автомобиля '+(current+1);}
  stage.appendChild(el);
  lightbox.querySelector('.car-lightbox-count').textContent=(current+1)+' / '+items.length;
 }
 function openBox(index){
  closeBox();
  lightbox=document.createElement('div'); lightbox.className='car-lightbox';
  lightbox.setAttribute('role','dialog'); lightbox.setAttribute('aria-modal','true'); lightbox.setAttribute('aria-label','Просмотр фото');
  var bar=document.createElement('div'); bar.className='car-lightbox-bar';
  var count=document.createElement('span'); count.className='car-lightbox-count';
  var close=document.createElement('button'); close.type='button'; close.setAttribute('aria-label','Закрыть просмотр'); close.textContent='×'; close.onclick=closeBox;
  bar.appendChild(count); bar.appendChild(close);
  var stage=document.createElement('div'); stage.className='car-lightbox-stage';
  var nav=document.createElement('div'); nav.className='car-lightbox-nav';
  var prev=document.createElement('button'); prev.type='button'; prev.setAttribute('aria-label','Предыдущее фото'); prev.textContent='‹'; prev.onclick=function(){show(current-1)};
  var next=document.createElement('button'); next.type='button'; next.setAttribute('aria-label','Следующее фото'); next.textContent='›'; next.onclick=function(){show(current+1)};
  nav.appendChild(prev); nav.appendChild(next);
  lightbox.appendChild(bar); lightbox.appendChild(stage); lightbox.appendChild(nav);
  lightbox.addEventListener('click', function(e){ if(e.target===lightbox) closeBox(); });
  document.body.appendChild(lightbox);
  document.addEventListener('keydown', onKey);
  show(index);
 }
 data.cars.forEach(function(car){
  var media=Array.isArray(car.mediaItems)&&car.mediaItems.length?car.mediaItems:(car.media?[{url:car.media,type:car.mediaType}]:[]);
  var isVideo=car.mediaType==='video';
  var article=document.createElement('article'); article.className='card car-card'; article.dataset.carRaw=JSON.stringify(car);
  var body=document.createElement('div'); body.className='car-body';
  var heading=splitVehicleHeading((car.caption||'Автомобиль из объявления').split(NL)[0]);
  if(heading.trim){var trim=document.createElement('div');trim.className='car-trim';trim.textContent=heading.trim;body.appendChild(trim);}
  var title=document.createElement('h3'); title.textContent=heading.model.slice(0,120);
  body.appendChild(title);
  function splitVehicleHeading(raw){
   var original=String(raw||'Автомобиль из объявления').trim();
   var trims=['SX Prestige','GT-Line','GT Line','X-Line','X Line','Calligraphy','Noblesse','Prestige','Signature','Platinum','Limited','Ultimate','Premium','Luxury','Elegance','Adventure','High-Tech','Techno','Intense','Comfort','Classic','Active','Prime','Style','N Line','SX','EX','LX','SE','SEL'];
   var lower=original.toLowerCase();
   for(var i=0;i<trims.length;i++){
    var trim=trims[i], suffix=trim.toLowerCase(), offset=original.length-suffix.length;
    if(offset>0&&lower.slice(offset)===suffix&&/[\s|·—–-]/.test(original.charAt(offset-1))){
     var model=original.slice(0,offset).trim().replace(/[|·—–-]+$/,'').trim();
     if(model)return {model:model,trim:trim.toUpperCase(),raw:original};
    }
   }
   return {model:original,trim:'',raw:original};
  }
  function renderCarDescription(root, rawCaption, titleText){
   var lines=String(rawCaption||'').replaceAll(String.fromCharCode(13),'').replaceAll(String.fromCharCode(160),' ').split(String.fromCharCode(10)).map(function(line){return line.trim()});
   while(lines.length&&!lines[0])lines.shift();
   while(lines.length&&!lines[lines.length-1])lines.pop();
   if(lines.length&&lines[0].slice(0,120)===String(titleText||''))lines.shift();
   var paragraph=[],list=null;
   function flushParagraph(){
    if(!paragraph.length)return;
    var p=document.createElement('p');p.className='car-description-paragraph';p.textContent=paragraph.join(' ');
    root.appendChild(p);paragraph=[];
   }
   function flushList(){if(list&&list.children.length)root.appendChild(list);list=null;}
   lines.forEach(function(line){
    if(!line){flushParagraph();flushList();return;}
    var sectionName=line.toLowerCase().replace(/:$/,'').trim();
    if(['характеристики','комплектация','описание','состояние','двигатель','трансмиссия','привод','безопасность','опции','дополнительно'].indexOf(sectionName)>=0){
     flushParagraph();flushList();
     var h=document.createElement('h4');h.className='car-description-heading';h.textContent=sectionName;root.appendChild(h);return;
    }
    var bulletText=null;
    if('•●▪◦✓✔-–—'.indexOf(line.charAt(0))>=0&&line.length>1&&line.charAt(1)===' ')bulletText=line.slice(2).trim();
    else{
     var space=line.indexOf(' ');
     if(space>1&&(line.charAt(space-1)==='.'||line.charAt(space-1)===')')&&!isNaN(Number(line.slice(0,space-1))))bulletText=line.slice(space+1).trim();
    }
    if(bulletText){
     flushParagraph();
     if(!list){list=document.createElement('ul');list.className='car-description-list';}
     var li=document.createElement('li');li.textContent=bulletText;list.appendChild(li);return;
    }
    flushList();
    var colon=line.indexOf(':');
    if(colon<0)colon=line.indexOf('：');
    if(colon>=2&&colon<=36&&line.slice(colon+1).trim()){
     flushParagraph();
     var row=document.createElement('div');row.className='car-description-row';
     var label=document.createElement('strong');label.textContent=line.slice(0,colon).trim();
     var value=document.createElement('span');value.textContent=line.slice(colon+1).trim();
     row.appendChild(label);row.appendChild(value);root.appendChild(row);return;
    }
    paragraph.push(line);
   });
   flushParagraph();flushList();
  }
  var description=document.createElement('div');description.className='car-description';
  renderCarDescription(description,car.caption||'',heading.raw);
  if(description.childNodes.length)body.appendChild(description);
  var discuss=document.createElement('a');discuss.className='car-link';discuss.href='#request';discuss.textContent='Обсудить этот автомобиль →';body.appendChild(discuss);
  if(media.length){
   var gallery=document.createElement('div'); gallery.className='car-gallery';
   function isVideoMedia(item){
    if(item&&typeof item==='object'){
     var kind=String(item.type||item.mimeType||item.mime_type||'').toLowerCase();
     if(kind.indexOf('video')>=0)return true;
     if(kind.indexOf('image')>=0)return false;
     item=item.url||item.src||'';
    }
    var url=String(item||'').split(/[?#]/)[0].toLowerCase();
    return /\\.(mp4|m4v|mov|webm|ogv|m3u8|mpd)$/.test(url);
   }
   var carItems=media.map(function(item){return {url:typeof item==='string'?item:(item.url||item.src||''),video:isVideoMedia(item)};}).filter(function(item){return !!item.url;});

   var stage=document.createElement('div'); stage.className='car-gallery-stage';
   var failedMedia={}; function createCarMedia(item,index){var el=document.createElement(item.video?'video':'img');el.className='car-gallery-main';el.src=item.url;if(item.video){el.controls=true;el.playsInline=true;el.preload='none';el.setAttribute('aria-label','Видео автомобиля '+(index+1));}else{el.alt='Фотография автомобиля '+(index+1);el.loading='lazy';}el.addEventListener('error',function(){failedMedia[index]=true;var next=(index+1)%carItems.length,attempts=0;while(failedMedia[next]&&attempts<carItems.length){next=(next+1)%carItems.length;attempts++;}if(attempts>=carItems.length)gallery.hidden=true;else showCarPhoto(next);},{once:true});return el;}
   var current=createCarMedia(carItems[0],0);
   stage.appendChild(current); gallery.appendChild(stage);
   var photoIndex=0;
   var count=document.createElement('span');count.className='car-gallery-count';count.textContent='1 / '+carItems.length;
   var back=document.createElement('button');back.type='button';back.className='car-gallery-arrow is-prev';back.textContent='‹';back.setAttribute('aria-label','Предыдущее фото');
   var forward=document.createElement('button');forward.type='button';forward.className='car-gallery-arrow is-next';forward.textContent='›';forward.setAttribute('aria-label','Следующее фото');
   function showCarPhoto(nextIndex){
    var candidate=(nextIndex+carItems.length)%carItems.length,attempts=0;
    while(failedMedia[candidate]&&attempts<carItems.length){candidate=(candidate+1)%carItems.length;attempts++;}
    if(attempts>=carItems.length){gallery.hidden=true;return;}
    photoIndex=candidate;
    var previous=current;
    current=createCarMedia(carItems[photoIndex],photoIndex);
    if(previous&&previous.parentNode===stage)stage.replaceChild(current,previous);else stage.appendChild(current);
    count.textContent=(photoIndex+1)+' / '+carItems.length;
   }
   back.hidden=forward.hidden=count.hidden=carItems.length<2;
   back.onclick=function(){showCarPhoto(photoIndex-1)};
   forward.onclick=function(){showCarPhoto(photoIndex+1)};
   var touchStart=0;
   gallery.addEventListener('touchstart',function(e){touchStart=e.changedTouches[0].clientX},{passive:true});
   gallery.addEventListener('touchend',function(e){var delta=e.changedTouches[0].clientX-touchStart;if(Math.abs(delta)>35)showCarPhoto(photoIndex+(delta<0?1:-1))},{passive:true});
   stage.addEventListener('click',function(e){if(e.target&&e.target.tagName==='VIDEO')return;items=carItems;openBox(photoIndex)});
   gallery.appendChild(back);gallery.appendChild(forward);gallery.appendChild(count);body.insertBefore(gallery,title);
  }
  article.appendChild(body); list.appendChild(article);
 });
 if(window.upgradeAvtoyCatalogue)window.upgradeAvtoyCatalogue();
}).catch(function(){
 var list=document.getElementById('cars-list'); if(!list)return;
 list.textContent='';
 var card=document.createElement('article'); card.className='card dashed';
 var body=document.createElement('div'); body.className='car-body';
 var message=document.createElement('p'); message.className='car-text'; message.textContent='Не удалось загрузить автомобили. Проверьте соединение и попробуйте ещё раз.';
 var retry=document.createElement('button'); retry.type='button'; retry.className='btn btn-dark'; retry.textContent='Повторить загрузку'; retry.addEventListener('click',loadCars);
 body.appendChild(message); body.appendChild(retry); card.appendChild(body); list.appendChild(card);
});
}
loadCars();
// Главный слайдер: три реальные модели, автосмена каждые 5 секунд и ручное управление.
(function(){
  if(typeof document.querySelector!=='function')return;
  var root=document.querySelector('.hero-standard');
  if(!root || typeof root.querySelector!=='function')return;
  var slides=root.querySelectorAll('.hero-slide');
  var dots=root.querySelectorAll('.hero-dot');
  var modelLabel=root.querySelector('.hero-model-name');
  if(!slides.length)return;
  var index=0, timer=null, paused=false;
  var reducedMotion=!!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function stopTimer(){if(timer!==null){window.clearInterval(timer);timer=null;}}
  function startTimer(){
    stopTimer();
    if(!reducedMotion && !paused && document.visibilityState!=='hidden'){
      timer=window.setInterval(function(){show(index+1)},5000);
    }
  }
  function show(next){
    slides[index].classList.remove('active');
    if(dots[index]){dots[index].classList.remove('active');dots[index].setAttribute('aria-current','false');}
    index=(next+slides.length)%slides.length;
    slides[index].classList.add('active');
    if(dots[index]){dots[index].classList.add('active');dots[index].setAttribute('aria-current','true');}
    if(modelLabel)modelLabel.textContent=slides[index].getAttribute('data-model')||'';
    startTimer();
  }
  if(dots[0])dots[0].setAttribute('aria-current','true');
  if(modelLabel)modelLabel.textContent=slides[0].getAttribute('data-model')||'';
  slides.forEach(function(slide){var match=String(slide.style.backgroundImage||'').match(/url\(["']?(.+?)["']?\)/);if(match){var preload=new Image();preload.src=match[1];}});
  root.querySelector('.hero-prev')?.addEventListener('click',function(){show(index-1)});
  root.querySelector('.hero-next')?.addEventListener('click',function(){show(index+1)});
  dots.forEach(function(dot,i){dot.addEventListener('click',function(){show(i)})});
  root.addEventListener('focusin',function(){paused=true;stopTimer();});
  root.addEventListener('focusout',function(event){if(!root.contains(event.relatedTarget)){paused=false;startTimer();}});
  document.addEventListener('visibilitychange',startTimer);
  startTimer();
})();
</script>
<script>
(function(){
  var BRAND_RULES=[
    ['Kia',/\\b(kia|киа)\\b/i],['Hyundai',/\\b(hyundai|хендай|хёндай|solaris|sonata|avante|kona|creta)\\b/i],
    ['Volkswagen',/\\b(volkswagen|vw|tharu|t-roc|t-cross|tacqua|bora)\\b/i],['Mercedes-Benz',/\\b(mercedes|glb|glc|gle)\\b/i],
    ['Chevrolet',/\\b(chevrolet|shevrolet|monza|trailblazer)\\b/i],['Geely',/\\b(geely|coolray|monjaro)\\b/i],
    ['Mitsubishi',/\\b(mitsubishi|asx|outlander)\\b/i],['Honda',/\\b(honda|crider|cr-v)\\b/i],
    ['Haval',/\\b(haval|h6|jolion)\\b/i],['Skoda',/\\b(skoda|kamiq|kodiaq)\\b/i],
    ['KG Mobility',/\\b(kg[_\\s-]*mobility|ssangyong|tiboli|tivoli)\\b/i],['Zeekr',/\\b(zeekr)\\b/i]
  ];
  var NL=String.fromCharCode(10);
  function cleanCaption(raw){
    return String(raw||'').replace(/\\r/g,'').replace(/\\*+/g,'')
      .replace(/(?:^|\\n)\\s*Для заказа(?:\\s+автомобиля|\\s+аналогичного автомобиля)?\\s+обращайтесь\\s*:?[\\s\\S]*$/i,'')
      .replace(/(?:^|\\n)\\s*По актуальному курсу на сегодняшний день\\s*/gi,NL)
      .replace(/(?:^|\\n)\\s*Организуем доставку до Вас!?\\s*/gi,NL)
      .replace(/(?:^|\\n)\\s*(?:Владимир|Менеджер|Контакт|Продавец)\\s*:\\s*\\+?\\s*$/gim,'')
      .replace(/(?:^|\\n)\\s*\\+\\s*$/gm,'').trim();
  }
  function parseCar(car){
    var cleaned=cleanCaption(car.caption||'');
    var lines=cleaned.split(NL).map(function(l){return l.replace(/\\u00a0/g,' ').trim();}).filter(Boolean);
    var ti=0,promo='';
    if(lines.length>1&&/^(?:встречайте(?:\\s+новый)?|новинка|в\\s+наличии)$/i.test(lines[0])){
      if(/наличии/i.test(lines[0]))promo='В наличии';
      ti=1;
    }
    var title=(lines[ti]||'').replace(/^в\\s+наличии\\s+(?:новый\\s+)?/i,function(){promo='В наличии';return '';});
    title=title.replace(/KG_MOBILITY_SSANGYONG/gi,'KG Mobility').replace(/\\bTIBOLI\\b/gi,'Tivoli').replace(/\\bShevrolet\\b/gi,'Chevrolet').replace(/_/g,' ').trim();
    var extraTrim='';
    if(lines[ti+1]&&lines[ti+1].indexOf(':')<0&&/^[A-Z0-9\\s-]{4,32}$/.test(lines[ti+1])&&!/цена|год|пробег/i.test(lines[ti+1]))extraTrim=lines[ti+1];
    var specs=[],features=[],priceNum=null,priceFmt='По запросу',priceNote='расчёт под ключ';
    for(var i=0;i<lines.length;i++){
      if(i===ti||(extraTrim&&i===ti+1))continue;
      var ln=lines[i];
      if(/^цена(?:\\s+под\\s+ключ)?/i.test(ln)){
        var cm=ln.match(/до\\s+([А-Яа-яЁёA-Za-z\\s/-]+?)\\s*:?$/i);
        if(cm)priceNote='под ключ до '+cm[1].trim();
        var inl=ln.replace(/^.*?:/,'').trim();
        var cand=/\\d/.test(inl)?inl:(lines[i+1]||'');
        var dg=cand.replace(/[^\\d]/g,'');
        if(dg.length>=6&&dg.length<=9){priceNum=Number(dg);priceFmt=priceNum.toLocaleString('ru-RU')+' ₽';if(!/\\d/.test(inl))i++;}
        continue;
      }
      if(/^[\\d\\s.,]{6,15}\\s*₽$/.test(ln)){var d2=ln.replace(/[^\\d]/g,'');if(d2.length>=6){priceNum=Number(d2);priceFmt=priceNum.toLocaleString('ru-RU')+' ₽';continue;}}
      if(/^(?:характеристики|комплектация|описание|опции)\\s*:?$/i.test(ln))continue;
      var cIdx=ln.indexOf(':')>=0?ln.indexOf(':'):ln.indexOf('：');
      if(cIdx>=2&&cIdx<=32&&ln.slice(cIdx+1).trim()){
        specs.push({k:ln.slice(0,cIdx).trim(),v:ln.slice(cIdx+1).trim().replace(/\\bShevrolet\\b/gi,'Chevrolet')});
        continue;
      }
      var m;
      if((m=ln.match(/^Год(?:\\s+выпуска)?\\s+(.+)$/i)))specs.push({k:'Год выпуска',v:m[1]});
      else if((m=ln.match(/^Пробег\\s+(.+)$/i)))specs.push({k:'Пробег',v:m[1]});
      else if((m=ln.match(/^Мощность\\s+(.+)$/i)))specs.push({k:'Мощность',v:m[1]});
      else if((m=ln.match(/^(Бензин|Дизель|Гибрид|Электро|Газ)\\s+(.+)$/i))){specs.push({k:'Топливо',v:m[1]});specs.push({k:'Двигатель',v:m[2]});}
      else if(ln.length>=3&&!/^цена\\s+по\\s+запросу$/i.test(ln))features.push(ln.replace(/^[•●▪✓✔-]\\s*/,''));
    }
    function getSpec(rx){for(var j=0;j<specs.length;j++)if(rx.test(specs[j].k))return specs[j].v;return '';}
    var yr=(getSpec(/^год/i).match(/\\b(20\\d{2})\\b/)||title.match(/\\b(20\\d{2})\\b/)||[])[1]||'';
    var milRaw=getSpec(/^пробег/i),mil='',isNew=false;
    if(/новый|^0(?:\\s*км)?$/i.test(milRaw.trim())){mil='Без пробега';isNew=true;}
    else if(milRaw){var md=milRaw.replace(/[^\\d]/g,'');mil=md?Number(md).toLocaleString('ru-RU')+' км':milRaw;}
    var eng=getSpec(/^двигатель/i),fuel=getSpec(/^топливо/i),pwr=getSpec(/^мощность/i),drv=getSpec(/^привод/i);
    var brand='Другие',hay=title+' '+getSpec(/^марка/i)+' '+getSpec(/^модель/i);
    for(var b=0;b<BRAND_RULES.length;b++){if(BRAND_RULES[b][1].test(hay)){brand=BRAND_RULES[b][0];break;}}
    var media=Array.isArray(car.mediaItems)?car.mediaItems:[];
    var hasVideo=media.some(function(x){return x&&x.type==='video';});
    if(!title)title=hasVideo?'Видеообзор автомобиля под заказ':'Автомобиль из Южной Кореи';
    var chips=[];
    if(yr)chips.push(yr+' г.');
    if(mil)chips.push(mil);
    if(eng||fuel)chips.push([eng?(eng.indexOf('л')>=0?eng:eng+' л'):'',fuel].filter(Boolean).join(' · '));
    if(pwr||drv)chips.push([pwr?(pwr.indexOf('л.с')>=0||pwr.indexOf('лс')>=0?pwr:pwr+' л.с.'):'',drv?drv.replace(/\\s*\\(.*?\\)/,'').trim():''].filter(Boolean).join(' · '));
    return {brand:brand,title:title,trim:extraTrim||getSpec(/^комплектация/i),promo:promo||(isNew?'Новый':''),hasVideo:hasVideo,chips:chips,priceNum:priceNum,priceFmt:priceFmt,priceNote:priceNote,specs:specs.filter(function(s){return !/^(?:марка|модель)$/i.test(s.k);}),features:features,searchText:(title+' '+brand+' '+cleaned).toLowerCase()};
  }

  function selectCarIntoForm(meta){
    var modelInput=document.getElementById('model');
    var banner=document.getElementById('selected-car-banner');
    var label=document.getElementById('selected-car-label');
    if(modelInput)modelInput.value=meta.title+(meta.priceFmt&&meta.priceFmt!=='По запросу'?' ('+meta.priceFmt+')':'');
    if(banner&&label){
      label.textContent='🚘 Выбран автомобиль: '+meta.title+' — '+meta.priceFmt;
      banner.classList.add('is-visible');
    }
    var sec=document.getElementById('request'),nameInput=document.getElementById('name');
    if(sec)sec.scrollIntoView({behavior:'smooth',block:'start'});
    if(nameInput)window.setTimeout(function(){nameInput.focus({preventScroll:true});},350);
  }
  document.getElementById('selected-car-clear')?.addEventListener('click',function(){
    document.getElementById('selected-car-banner')?.classList.remove('is-visible');
    var m=document.getElementById('model');if(m)m.value='';
  });

  function openCarDetailModal(car,meta){
    var overlay=document.createElement('div');overlay.className='car-modal';
    var dlg=document.createElement('div');dlg.className='car-modal-dialog';
    var top=document.createElement('div');top.style.display='flex';top.style.justifyContent='space-between';top.style.alignItems='flex-start';top.style.gap='12px';
    var hWrap=document.createElement('div');
    if(meta.trim){var tr=document.createElement('div');tr.style.color='#ff806e';tr.style.fontWeight='800';tr.style.fontSize='11px';tr.style.letterSpacing='.12em';tr.style.textTransform='uppercase';tr.textContent=meta.trim;hWrap.appendChild(tr);}
    var h3=document.createElement('h3');h3.style.margin='4px 0 0';h3.style.fontSize='24px';h3.textContent=meta.title;hWrap.appendChild(h3);
    var closeBtn=document.createElement('button');closeBtn.type='button';closeBtn.className='car-spec-btn';closeBtn.textContent='✕ Закрыть';
    function close(){overlay.remove();}
    closeBtn.onclick=close;overlay.onclick=function(e){if(e.target===overlay)close();};
    top.appendChild(hWrap);top.appendChild(closeBtn);dlg.appendChild(top);

    var grid=document.createElement('div');grid.className='car-modal-grid';
    var left=document.createElement('div');
    var stage=document.createElement('div');stage.className='car-modal-stage';
    var thumbs=document.createElement('div');thumbs.className='car-modal-thumbs';
    var rawMedia=Array.isArray(car.mediaItems)&&car.mediaItems.length?car.mediaItems:(car.media?[{url:car.media,type:car.mediaType}]:[]);
    var seen={},media=[];
    rawMedia.forEach(function(m){var u=typeof m==='string'?m:m.url;if(!u||seen[u])return;seen[u]=true;media.push({url:u,video:(m&&m.type==='video')||/\\.(mp4|webm|mov)$/i.test(u)});});
    function renderStage(idx){
      stage.textContent='';
      var it=media[idx];if(!it)return;
      var node=document.createElement(it.video?'video':'img');node.src=it.url;
      if(it.video){node.controls=true;node.playsInline=true;}
      stage.appendChild(node);
      Array.from(thumbs.children).forEach(function(b,bi){b.classList.toggle('is-active',bi===idx);});
    }
    if(media.length>1){
      media.forEach(function(m,idx){
        var b=document.createElement('button');b.type='button';
        if(m.video){b.textContent='▶';b.style.color='#fff';b.style.fontWeight='800';}
        else{var im=document.createElement('img');im.src=m.url;im.loading='lazy';b.appendChild(im);}
        b.onclick=function(){renderStage(idx);};thumbs.appendChild(b);
      });
    }
    renderStage(0);
    left.appendChild(stage);if(media.length>1)left.appendChild(thumbs);

    var right=document.createElement('div');
    var pBox=document.createElement('div');pBox.style.padding='14px 16px';pBox.style.borderRadius='14px';pBox.style.background='#09101b';pBox.style.border='1px solid #243248';
    var pVal=document.createElement('div');pVal.className='car-price-val';pVal.style.fontSize='26px';pVal.textContent=meta.priceFmt;
    var pSub=document.createElement('div');pSub.style.color='#93a4bc';pSub.style.fontSize='12px';pSub.style.marginTop='4px';pSub.textContent=meta.priceNote+' · актуальный расчёт';
    pBox.appendChild(pVal);pBox.appendChild(pSub);right.appendChild(pBox);

    var spWrap=document.createElement('div');spWrap.className='car-modal-specs';
    meta.specs.forEach(function(s){
      var r=document.createElement('div');r.className='car-description-row';
      var k=document.createElement('strong');k.textContent=s.k;
      var v=document.createElement('span');v.textContent=s.v;
      r.appendChild(k);r.appendChild(v);spWrap.appendChild(r);
    });
    right.appendChild(spWrap);
    if(meta.features.length){
      var ul=document.createElement('ul');ul.className='car-description-list';ul.style.marginBottom='16px';
      meta.features.forEach(function(f){var li=document.createElement('li');li.textContent=f;ul.appendChild(li);});
      right.appendChild(ul);
    }
    var orderBtn=document.createElement('button');orderBtn.type='button';orderBtn.className='btn btn-red';orderBtn.style.width='100%';orderBtn.textContent='Заказать расчёт по этому авто →';
    orderBtn.onclick=function(){close();selectCarIntoForm(meta);};
    right.appendChild(orderBtn);
    if(car&&car.id){
      var pageLink=document.createElement('a');pageLink.className='car-spec-btn';pageLink.style.marginTop='10px';pageLink.style.display='inline-flex';pageLink.style.width='100%';pageLink.style.justifyContent='center';
      pageLink.href=/[.](?:gitverse[.]site|gitverse[.]ru|github[.]io)$/i.test(location.hostname)?('./cars/'+encodeURIComponent(car.id)+'.html'):('/cars/'+encodeURIComponent(car.id));
      pageLink.textContent='Открыть отдельную страницу авто ↗';
      right.appendChild(pageLink);
    }

    grid.appendChild(left);grid.appendChild(right);dlg.appendChild(grid);overlay.appendChild(dlg);document.body.appendChild(overlay);
  }

  window.upgradeAvtoyCatalogue=function(){
    var list=document.getElementById('cars-list');if(!list)return;
    var cards=Array.from(list.querySelectorAll('article.car-card'));
    if(!cards.length)return;
    var toolbar=document.getElementById('cars-toolbar'),brandsEl=document.getElementById('cars-brands');
    var searchEl=document.getElementById('cars-search'),sortEl=document.getElementById('cars-sort');
    var emptyHint=document.getElementById('cars-empty-filter');
    var brandCounts={},videoCount=0;
    var entries=[];

    cards.forEach(function(card,origIdx){
      var car={};try{car=JSON.parse(card.dataset.carRaw||'{}');}catch{}
      var meta=parseCar(car);
      card.classList.add('is-upgraded');
      brandCounts[meta.brand]=(brandCounts[meta.brand]||0)+1;
      if(meta.hasVideo)videoCount++;

      var h3=card.querySelector('h3');
      if(h3)h3.textContent=meta.title;
      var existingTrim=card.querySelector('.car-trim');
      if(meta.trim&&!existingTrim&&h3){
        var tr=document.createElement('div');tr.className='car-trim';tr.textContent=meta.trim;
        h3.parentNode.insertBefore(tr,h3);
      }

      var gallery=card.querySelector('.car-gallery');
      if(gallery){
        var badges=document.createElement('div');badges.className='car-badges';
        if(meta.promo){var b1=document.createElement('span');b1.className='car-badge is-new';b1.textContent=meta.promo;badges.appendChild(b1);}
        if(meta.hasVideo){var b2=document.createElement('span');b2.className='car-badge is-video';b2.textContent='▶ Видеообзор';badges.appendChild(b2);}
        if(badges.childNodes.length)gallery.appendChild(badges);
      }

      var body=card.querySelector('.car-body');
      var link=card.querySelector('.car-link');
      if(body&&link){
        if(meta.chips.length){
          var chipsWrap=document.createElement('div');chipsWrap.className='car-chips';
          meta.chips.forEach(function(c){var sp=document.createElement('span');sp.className='car-chip';sp.textContent=c;chipsWrap.appendChild(sp);});
          body.insertBefore(chipsWrap,link);
        }
        var pBox=document.createElement('div');pBox.className='car-Card-pricebox';
        var pVal=document.createElement('div');pVal.className='car-price-val';pVal.textContent=meta.priceFmt;
        var pNote=document.createElement('div');pNote.className='car-price-note';pNote.textContent=meta.priceNote;
        pBox.appendChild(pVal);pBox.appendChild(pNote);body.insertBefore(pBox,link);

        var row=document.createElement('div');row.className='car-actions-row';
        var specBtn=document.createElement('button');specBtn.type='button';specBtn.className='car-spec-btn';specBtn.textContent='Характеристики';
        specBtn.onclick=function(){openCarDetailModal(car,meta);};
        link.onclick=function(e){e.preventDefault();selectCarIntoForm(meta);};
        row.appendChild(specBtn);row.appendChild(link);body.appendChild(row);
      }
      entries.push({card:card,meta:meta,origIdx:origIdx});
    });

    var activeBrand='all';
    if(toolbar&&brandsEl){
      toolbar.hidden=false;brandsEl.textContent='';
      function addChip(key,label){
        var btn=document.createElement('button');btn.type='button';btn.className='brand-chip'+(key==='all'?' is-active':'');
        btn.textContent=label;
        btn.onclick=function(){
          activeBrand=key;
          Array.from(brandsEl.children).forEach(function(c){c.classList.remove('is-active');});
          btn.classList.add('is-active');
          applyFilters();
        };
        brandsEl.appendChild(btn);
      }
      addChip('all','Все ('+entries.length+')');
      Object.keys(brandCounts).sort(function(a,b){return brandCounts[b]-brandCounts[a];}).forEach(function(br){
        if(br!=='Другие')addChip(br,br+' ('+brandCounts[br]+')');
      });
      if(videoCount>0)addChip('__video','▶ С видео ('+videoCount+')');
    }

    function applyFilters(){
      var q=(searchEl?searchEl.value:'').trim().toLowerCase();
      var sortMode=sortEl?sortEl.value:'newest';
      var sorted=entries.slice();
      if(sortMode==='price_asc'){
        sorted.sort(function(a,b){return (a.meta.priceNum||999999999)-(b.meta.priceNum||999999999);});
      }else if(sortMode==='price_desc'){
        sorted.sort(function(a,b){return (b.meta.priceNum||0)-(a.meta.priceNum||0);});
      }else{
        sorted.sort(function(a,b){return a.origIdx-b.origIdx;});
      }
      var visible=0;
      sorted.forEach(function(e){
        var matchBrand=activeBrand==='all'||(activeBrand==='__video'?e.meta.hasVideo:e.meta.brand===activeBrand);
        var matchQ=!q||e.meta.searchText.indexOf(q)>=0;
        var ok=matchBrand&&matchQ;
        e.card.style.display=ok?'':'none';
        if(ok)visible++;
        list.appendChild(e.card);
      });
      if(emptyHint){emptyHint.hidden=visible>0;emptyHint.classList.toggle('is-on',visible===0);}
    }
    searchEl?.addEventListener('input',applyFilters);
    sortEl?.addEventListener('change',applyFilters);
  };

  function openNewsZoom(url){
    var overlay=document.createElement('div');overlay.className='car-lightbox';
    var bar=document.createElement('div');bar.className='car-lightbox-bar';
    var lbl=document.createElement('span');lbl.textContent='Просмотр инфографики / документа';
    var close=document.createElement('button');close.type='button';close.textContent='×';
    function remove(){overlay.remove();}
    close.onclick=remove;overlay.onclick=function(e){if(e.target===overlay)remove();};
    bar.appendChild(lbl);bar.appendChild(close);
    var stage=document.createElement('div');stage.className='car-lightbox-stage';
    var img=document.createElement('img');img.src=url;img.alt='Инфографика к новости';
    stage.appendChild(img);overlay.appendChild(bar);overlay.appendChild(stage);
    document.body.appendChild(overlay);
  }

  fetch('/api/news',{cache:'no-store'}).then(function(r){return r.ok?r.json():{news:[]};}).then(function(data){
    var sec=document.getElementById('news'),list=document.getElementById('news-list');
    if(!sec||!list||!Array.isArray(data.news)||!data.news.length)return;
    sec.hidden=false;
    list.textContent='';
    list.classList.toggle('is-single',data.news.length===1);
    data.news.forEach(function(item){
      var raw=cleanCaption(item.text||item.caption||'');
      var prevN=0;
      var lines=raw.split(NL).map(function(l){
        var t=l.replace(/\\u00a0/g,' ').replace(/^[\\u2060\\s]+/,'').replace(/\\s+,/g,',').trim();
        var nm=t.match(/^(\\d+)\\.\\s+/);
        if(nm){prevN=Number(nm[1]);return t;}
        if(/^\\.\\s+/.test(t)){if(prevN>0){prevN+=1;return prevN+'. '+t.replace(/^\\.\\s+/,'');}return '• '+t.replace(/^\\.\\s+/,'');}
        return t;
      }).filter(Boolean);
      var headline=(lines[0]||'Новость AVTOY KOREA').replace(/[!?.]+$/,'').trim();
      var paragraphs=lines.length>1?lines.slice(1):[];
      var isUrgent=/(?:утильсбор|срочно|подорожан|удорожан|закрыть|таких\\s+цен.*не\\s+будет|индексац)/i.test(raw);
      var media=(Array.isArray(item.mediaItems)&&item.mediaItems.length?item.mediaItems:(item.media?[{url:item.media,type:'photo'}]:[])).filter(function(m){return m&&(m.url||typeof m==='string');});

      var card=document.createElement('article');
      card.className='card news-card'+(media.length?' has-media':'');

      if(media.length){
        var first=typeof media[0]==='string'?{url:media[0],type:'photo'}:media[0];
        var mWrap=document.createElement('div');mWrap.className='news-media-wrap';
        if(first.type==='video'||/\\.(mp4|webm|mov)$/i.test(first.url)){
          var vid=document.createElement('video');vid.src=first.url;vid.controls=true;vid.playsInline=true;vid.preload='metadata';
          mWrap.style.cursor='default';mWrap.appendChild(vid);
        }else{
          var img=document.createElement('img');img.src=first.url;img.alt=headline;img.loading='lazy';
          var hint=document.createElement('span');hint.className='news-zoom-hint';hint.textContent='🔍 Увеличить таблицу';
          mWrap.appendChild(img);mWrap.appendChild(hint);
          mWrap.onclick=function(){openNewsZoom(first.url);};
        }
        card.appendChild(mWrap);
      }

      var content=document.createElement('div');content.className='news-content';
      var badge=document.createElement('span');badge.className='news-badge'+(isUrgent?' is-urgent':'');
      badge.textContent=isUrgent?'⚡ Важное изменение рынка':'📰 Новость AVTOY KOREA';
      content.appendChild(badge);

      var h3=document.createElement('h3');h3.className='news-title';h3.textContent=headline;
      content.appendChild(h3);

      if(paragraphs.length){
        var bodyDiv=document.createElement('div');bodyDiv.className='news-body';
        paragraphs.forEach(function(pText){
          var p=document.createElement('p');p.textContent=pText;bodyDiv.appendChild(p);
        });
        content.appendChild(bodyDiv);
      }

      var cta=document.createElement('a');cta.className='news-cta';cta.href='#request';
      cta.textContent='Рассчитать автомобиль по актуальным условиям →';
      cta.onclick=function(e){
        var reqSec=document.getElementById('request'),nm=document.getElementById('name');
        if(reqSec){e.preventDefault();reqSec.scrollIntoView({behavior:'smooth',block:'start'});if(nm)window.setTimeout(function(){nm.focus({preventScroll:true});},350);}
      };
      content.appendChild(cta);
      card.appendChild(content);
      list.appendChild(card);
    });
  }).catch(function(){});

  var activeMaxUrl='';
  function isMaxHref(u){return String(u||'').toLowerCase().indexOf('https://max.ru/')===0;}
  function applyMaxBotLinks(url){
    if(isMaxHref(url))activeMaxUrl=url;
    document.querySelectorAll('[data-max-bot-link]').forEach(function(el){
      if(activeMaxUrl){
        el.href=activeMaxUrl;
        el.target='_blank';
        el.rel='noopener';
      }
    });
  }
  document.querySelectorAll('[data-max-bot-link]').forEach(function(el){
    var initialHref=el.getAttribute('href')||'';
    if(isMaxHref(initialHref))activeMaxUrl=initialHref;
    el.addEventListener('click',function(e){
      if(activeMaxUrl)return;
      e.preventDefault();
      var banner=document.getElementById('selected-car-banner');
      var label=document.getElementById('selected-car-label');
      var contact=document.getElementById('contact');
      var details=document.getElementById('details');
      if(banner&&label){
        label.textContent='💬 Связь через мессенджер MAX: укажите ваш номер телефона или контакт в MAX — бот и менеджер напишут вам в MAX';
        banner.classList.add('is-visible');
      }
      if(contact)contact.placeholder='Ваш номер телефона в MAX';
      if(details&&details.value.indexOf('MAX')<0)details.value=(details.value?details.value+NL:'')+'Предпочтительная связь: мессенджер MAX';
      var sec=document.getElementById('request'),nm=document.getElementById('name');
      if(sec)sec.scrollIntoView({behavior:'smooth',block:'start'});
      if(nm)window.setTimeout(function(){(nm.value?contact:nm)?.focus({preventScroll:true});},350);
    });
  });
  fetch('/api/public-config',{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(cfg){
    if(cfg&&cfg.maxBotUrl)applyMaxBotLinks(cfg.maxBotUrl);
  }).catch(function(){});
})();
</script>
</body>
</html>`;
  return new Response(html,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"strict-origin-when-cross-origin"}});
 }
};
