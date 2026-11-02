
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
 item.fileId = remaining.length ? remaining[remaining.length - 1].file_id : null;
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
 const text = String(record.text || "").trim();
 return "Отзыв: " + (text ? "«" + text.slice(0, 50) + "»" : "видео без текста");
}

// Подсказка для администраторов: открывается из меню команд (слева внизу) и кнопкой под списком /site.
const ADMIN_HELP_TEXT = [
 "❓ Подсказка администратора",
 "",
 "Сайт:",
 "/site — что сейчас опубликовано. Убрать: 🗑 → Да.",
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
  text: ADMIN_HELP_TEXT,
  reply_markup: { inline_keyboard: [[{ text: "🌐 Что на сайте", callback_data: "admincmd:site" }]] }
 });
}

async function setAdminCommands(env, adminId) {
 await callTelegram(env, "setMyCommands", {
  commands: [
   { command: "site", description: "Что опубликовано на сайте" },
   { command: "log", description: "Журнал действий администраторов" },
   { command: "help", description: "Подсказка администратора" },
   { command: "reply", description: "Ответить клиенту: /reply <chat_id> текст" }
  ],
  scope: { type: "chat", chat_id: Number(adminId) }
 });
}

async function showSiteList(chatId, env) {
 if (!env.REVIEWS) return callTelegram(env, "sendMessage", { chat_id: chatId, text: "Хранилище не настроено." });
 const cars = await env.REVIEWS.list({ prefix: "car_approved:" });
 const reviews = await env.REVIEWS.list({ prefix: "approved:" });
 const items = [];
 for (const key of [...cars.keys, ...reviews.keys]) {
  const raw = await env.REVIEWS.get(key.name);
  if (!raw) continue;
  const id = key.name.replace(/^(car_approved|approved):/, "");
  items.push({ id, label: siteLabel(id, JSON.parse(raw)) });
 }
 if (!items.length) return callTelegram(env, "sendMessage", { chat_id: chatId, text: "На сайте сейчас ничего не опубликовано." });
 const shown = items.slice(0, 30);
 const text = "🌐 Сейчас на сайте: " + items.length + "\n\n" + shown.map((item, index) => (index + 1) + ". " + item.label).join("\n") + (items.length > shown.length ? "\n\nПоказаны первые " + shown.length + "." : "");
 const keyboard = { inline_keyboard: [...shown.map(item => [{ text: "🗑 " + item.label.slice(0, 40), callback_data: "sitedel:" + item.id }]), [{ text: "❓ Подсказка", callback_data: "adminhelp" }]] };
 return callTelegram(env, "sendMessage", { chat_id: chatId, text, reply_markup: keyboard });
}

async function sendPendingCarCard(env, adminIds, car, id, lead) {
 const keyboard = { inline_keyboard: [[{ text: "✅ Опубликовать", callback_data: "carpub:" + id }, { text: "❌ Отклонить", callback_data: "carrej:" + id }], [{ text: "✏️ Редактировать описание", callback_data: "caredit:" + id }]] };
 await Promise.all(adminIds.map(async adminId => {
  await sendChannelMedia(env, adminId, postPhotos(car), postVideos(car), car.caption || "");
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: lead + "\n\n" + (car.caption || "Описание отсутствует") + "\n\nИсточник: " + (car.sourceUrl || "не указан"), reply_markup: keyboard });
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
 const match = data.match(/^sitedel(ok)?:(car_-?\d+_\d+|-?\d+_\d+)$/);
 if (!match || !env.REVIEWS) return answer("Материал не найден", true);
 const confirmed = Boolean(match[1]), id = match[2];
 const raw = await env.REVIEWS.get((id.startsWith("car_") ? "car_approved:" : "approved:") + id);
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
 await writeLog(env, fromId, "снят с сайта", id.startsWith("car_") ? "машина" : "отзыв", id, siteLabel(id, record));
 await offerUndo(env, fromId, id, { action: "restore", record }, "↩️ Снято с сайта. Материал в ожидании модерации.");
 if (chat && messageId) await callTelegram(env, "deleteMessage", { chat_id: chat.id, message_id: messageId });
 return answer("Снято с сайта. Материал вернулся в ожидание");
}

async function handleAdminModerationEditReply(msg, env, adminIds) {
 const adminId = String(msg.chat && msg.chat.id || "");
 if (!adminIds.includes(adminId) || !env.REVIEWS || !msg.reply_to_message) return false;
 const rawSession = await env.REVIEWS.get("moderation_edit:" + adminId);
 if (!rawSession) return false;
 const promptText = String(msg.reply_to_message.text || msg.reply_to_message.caption || "");
 if (!promptText.startsWith("✏️ РЕДАКТИРОВАНИЕ ")) return false;
 const session = JSON.parse(rawSession);
 if (!session || !["review", "car"].includes(session.type) || !session.id) return false;
 const instruction = String(msg.text || msg.caption || "").trim();
 if (!instruction) {
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: "Правка пустая. Отправьте команду изменения или полный текст ответом на сообщение редактирования." });
  return true;
 }
 const isCar = session.type === "car";
 const key = (isCar ? "car_pending:" : "pending:") + session.id;
 const raw = await env.REVIEWS.get(key);
 if (!raw) {
  await env.REVIEWS.delete("moderation_edit:" + adminId);
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: "Материал уже обработан или не найден. Изменения не сохранены." });
  return true;
 }
 const item = JSON.parse(raw);
 const currentText = String(isCar ? item.caption || "" : item.text || "");
 const photoCommand = instruction.match(/^УДАЛИТЬ\s+ФОТО\s*:?\s*([\d\s,]+)$/i);
 if (photoCommand) { await requestPhotoDelete(session, adminId, photoCommand[1], env); return true; }
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
 return cleanPublicationText(value)
  .split("\n")
  .filter(line => !/^\s*(?:📲|📞|☎️?|👤|✉️?)?\s*(?:контакт|продавец|менеджер|связ|звон|позвон|тел\b|телефон|whats?app|viber|telegram|телеграм|написать|писать)/i.test(line))
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();
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
 const check = review.kind === "video"
  ? "Видео"
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
  await sendChannelMedia(env, adminId, photos, videos, review.text ? String(review.text).slice(0, 1024) : "");
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
  const keyboard = {inline_keyboard:[[{text:"✅ Опубликовать",callback_data:"pub:" + id},{text:"❌ Не публиковать",callback_data:"rej:" + id}],[{text:"🙈 Скрыть имя",callback_data:"anon:" + id}]]};
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:formatReviewCard(review) + "\n\nМедиа загружено вами в личный чат с ботом. Проверьте и выберите действие.",reply_markup:keyboard});
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
 const storedKey = (isCar ? "car_approved:" : "approved:") + id;
 const raw = await env.REVIEWS.get(storedKey);
 if (!raw) return null;
 const record = JSON.parse(raw);
 if (isCar) {
  const car = { ...record };
  delete car.publishedAt;
  await env.REVIEWS.put("car_pending:" + id, JSON.stringify(car));
  await env.REVIEWS.delete(storedKey);
  await sendPendingCarCard(env, adminIds, car, id, "↩️ Снято с сайта. Объявление снова ожидает решения модератора.");
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
 const match = String(callback.data || "").match(/^undo:((?:car_)?-?\d+_\d+)$/);
 if (!match || !env.REVIEWS) return answer("Не распознано", true);
 const id = match[1];
 const raw = await env.REVIEWS.get("undo:" + id);
 if (!raw) return answer("Время для отмены вышло", true);
 const state = JSON.parse(raw);
 await env.REVIEWS.delete("undo:" + id);
 const kind = id.startsWith("car_") ? "машина" : "отзыв";
 if (state.action === "unpublish") {
  const done = await unpublishItem(env, adminIds, id);
  if (!done) return answer("Уже не на сайте", true);
  await writeLog(env, fromId, "отмена публикации", kind, id, "");
  return answer("Публикация отменена");
 }
  const isCar = id.startsWith("car_");
  await env.REVIEWS.put((isCar ? "car_approved:" : "approved:") + id, JSON.stringify(state.record));
  await env.REVIEWS.delete((isCar ? "car_pending:" : "pending:") + id);
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

function postPhotos(post) {
 const items = Array.isArray(post.photos) ? post.photos : (Array.isArray(post.photo) ? post.photo : []);
 const documentPhoto = imageDocumentItemFrom(post.document);
 return uniqueFileItems([...items, ...(documentPhoto ? [documentPhoto] : [])]);
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
async function sendChannelMedia(env, adminId, photos, videos, caption) {
 // Telegram принимает не больше 10 медиа в одной группе: отправляем все фото пачками.
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
 const photos = postPhotos(post);
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
   await sendChannelMedia(env, adminId, postPhotos(saved), postVideos(saved), saved.caption || "");
   await callTelegram(env,"sendMessage",{chat_id:adminId,text:"🔁 Повторная отправка: автомобиль всё ещё ожидает решения модератора.\n\n" + (saved.caption || "Описание отсутствует") + "\n\nИсточник: " + saved.sourceUrl,reply_markup:keyboard});
  }));
  return;
 }
 const car = {id,caption,fileId,photos,videos,mediaType:videos.length && !photos.length ? "video" : "photo",sourceUrl:"https://t.me/" + chat.username + "/" + messageNumberOf(post.message_id),createdAt:new Date().toISOString(),sourceDate:created};
 await env.REVIEWS.put("car_pending:" + id, JSON.stringify(car));
 const keyboard = {inline_keyboard:[[{text:"✅ Опубликовать",callback_data:"carpub:" + id},{text:"❌ Отклонить",callback_data:"carrej:" + id}],[{text:"✏️ Редактировать описание",callback_data:"caredit:" + id}]]};
 await Promise.all(adminIds.map(async adminId => {
  await sendChannelMedia(env, adminId, photos, videos, caption);
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"🚘 Один автомобиль из канала AVTOY KOREA\nФотографий: " + photos.length + (videos.length ? "\nВидео: " + videos.length : "") + "\n\n" + (caption || "Описание отсутствует") + "\n\nИсточник: " + car.sourceUrl,reply_markup:keyboard});
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
 const review = existingReview ? JSON.parse(existingReview) : {
  id,kind:video ? "video" : "text",text,name:"Клиент",fileId:video || photo || null,photos:photoItems,videos:videoItems,hasPhoto:Boolean(photo),hasThanks:THANKS_PATTERN.test(text),anonymous:false,createdAt:new Date().toISOString(),sourceUrl:post.sourceUrl || (chat.username ? "https://t.me/" + chat.username + "/" + number : "Пересылка администратора")
 };
 if (existingReview) {
  review.photos = uniqueFileItems([...(Array.isArray(review.photos) ? review.photos : (review.fileId && review.kind !== "video" ? [{file_id:review.fileId}] : [])), ...photoItems]);
  review.videos = uniqueFileItems([...(Array.isArray(review.videos) ? review.videos : (review.kind === "video" && review.fileId ? [{file_id:review.fileId}] : [])), ...videoItems]);
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
   for (let offset=0; offset<photosToSend.length; offset+=10) {
    const chunk = photosToSend.slice(offset,offset+10);
    if (chunk.length > 1) {
     const media = chunk.map((item,index)=>({type:"photo",media:item.file_id,...(offset===0 && index===0 && text ? {caption:text.slice(0,1024)} : {})}));
     await callTelegram(env,"sendMediaGroup",{chat_id:adminId,media});
    } else {
     await callTelegram(env,"sendPhoto",{chat_id:adminId,photo:chunk[0].file_id,...(offset===0 && text ? {caption:text.slice(0,1024)} : {})});
    }
   }
   for (const item of videosToSend) await callTelegram(env,"sendVideo",{chat_id:adminId,video:item.file_id});
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

async function handleImportChoice(callback, env, adminIds) {
 const answer = (text, alert=false) => callTelegram(env,"answerCallbackQuery",{callback_query_id:callback.id,text,show_alert:alert});
 const fromId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(fromId)) return answer("Нет доступа",true);
 const match = String(callback.data || "").match(/^imp:(car|review):(-?\d+_\d+)$/);
 if (!match || !env.REVIEWS) return answer("Импорт не найден",true);
 const [,kind,id] = match;
 const key = "import_pending:" + id;
 const raw = await env.REVIEWS.get(key);
 if (!raw) return answer("Публикация уже обработана или не найдена",true);
 const entry = JSON.parse(raw);
 const post = entry && entry.post ? entry.post : entry;
 if (kind === "car") await handleCarPost(post,env,adminIds);
 else await handleImportedReview(post,env,adminIds);
 await env.REVIEWS.delete(key);
 return answer(kind === "car" ? "Передано в модерацию автомобилей" : "Передано в модерацию отзывов");
}

async function resendChannelImportEntry(entry, id, env, adminIds) {
 const post = entry && entry.post ? entry.post : entry;
 const keyboard = {inline_keyboard:[[{text:"🚗 Автомобиль",callback_data:"imp:car:" + id},{text:"⭐ Отзыв",callback_data:"imp:review:" + id}]]};
 const photos = postPhotos(post);
 const videos = postVideos(post);
 const caption = String(post.caption || post.text || "Без текста").slice(0,2500);
 await Promise.all(adminIds.map(async adminId => {
  await sendChannelMedia(env, adminId, photos, videos, post.caption ? String(post.caption) : "");
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"🔁 Повторная пересылка из @avtoYkorea. Публикация ещё не опубликована; выберите действие.\n\n" + caption + "\n\nИсточник: https://t.me/" + (post.chat && post.chat.username || "avtoYkorea") + "/" + post.message_id,reply_markup:keyboard}); }));
}

// Другие части той же пересылки альбома: добавляем фото и видео к уже существующей записи, без новых карточек.
async function mergeChannelPartMedia(post, id, env) {
 const photos = [...largestPhotoOf(post.photo), ...(imageDocumentItemFrom(post.document) ? [imageDocumentItemFrom(post.document)] : [])];
 const videos = postVideos(post);
 if (!photos.length && !videos.length) return;
 const importKey = "import_pending:" + id;
 const importRaw = await env.REVIEWS.get(importKey);
 if (importRaw) {
  const entry = JSON.parse(importRaw);
  const saved = entry.post || entry;
  saved.photo = uniqueFileItems([...(Array.isArray(saved.photo) ? saved.photo : []), ...photos]);
  saved.videos = uniqueFileItems([...(Array.isArray(saved.videos) ? saved.videos : []), ...videos]);
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
  review.photos = uniqueFileItems([...(Array.isArray(review.photos) ? review.photos : (review.fileId && review.kind !== "video" ? [{file_id:review.fileId}] : [])), ...photos]);
  review.videos = uniqueFileItems([...(Array.isArray(review.videos) ? review.videos : (review.kind === "video" && review.fileId ? [{file_id:review.fileId}] : [])), ...videos]);
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
  car.photos = uniqueFileItems([...(Array.isArray(car.photos) ? car.photos : []), ...photos]);
  car.videos = uniqueFileItems([...(Array.isArray(car.videos) ? car.videos : []), ...videos]);
  if (!car.fileId) car.fileId = (car.photos[car.photos.length - 1] || car.videos[0] || {}).file_id || null;
  await env.REVIEWS.put(carKey, JSON.stringify(car));
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
 const approvedCar = await env.REVIEWS.get("car_approved:" + carId);
 if (await env.REVIEWS.get("approved:" + id) || approvedCar) {
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
   await sendChannelMedia(env, adminId, postPhotos(saved), postVideos(saved), saved.caption || "");
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
 const stored = {...post,chat,message_id:Number(number),albumId:post.media_group_id ? String(post.media_group_id) : "",photo:photos,videos};
 await env.REVIEWS.put("import_pending:" + id,JSON.stringify({...stored,post:stored}),{expirationTtl:2592000});
 const keyboard = {inline_keyboard:[[{text:"🚗 Автомобиль",callback_data:"imp:car:" + id},{text:"⭐ Отзыв",callback_data:"imp:review:" + id}]]};
 await Promise.all(adminIds.map(async adminId => {
  await sendChannelMedia(env, adminId, photos, videos, "");
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
 if (!photos.length && !videos.length) return false;
 const id = reviewIdFor(msg.chat.id, msg);
 if (await env.REVIEWS.get("pending:" + id) || await env.REVIEWS.get("approved:" + id)) return true;
 const key = "import_pending:" + id;
 let state = JSON.parse(await env.REVIEWS.get(key) || "null");
 if (!state || !state.post) {
  const albumNumber = msg.media_group_id ? String(msg.media_group_id).replace(/[^0-9]/g, "").slice(0, 40) : String(msg.message_id);
  state = {type:"group_media",post:{...msg,message_id:albumNumber,photo:photos,videos,sourceType:"group"},notified:{}};
 } else {
  const saved = state.post;
  saved.photo = uniqueFileItems([...(Array.isArray(saved.photo) ? saved.photo : []), ...photos]);
  saved.videos = uniqueFileItems([...(Array.isArray(saved.videos) ? saved.videos : []), ...videos]);
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
  const mediaItems = [...postPhotos(state.post), ...postVideos(state.post)];
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
     else if (String(cb.data || "").startsWith("sitedel")) await handleSiteDeleteCallback(cb, env, adminIds);
     else if (String(cb.data || "").startsWith("mphoto:")) await handlePhotoDeleteCallback(cb, env, adminIds);
     else if (String(cb.data || "") === "adminhelp") { await callTelegram(env, "answerCallbackQuery", { callback_query_id: cb.id }); await sendAdminHelp(env, cb.message.chat.id); }
     else if (String(cb.data || "") === "admincmd:site") { await callTelegram(env, "answerCallbackQuery", { callback_query_id: cb.id }); await showSiteList(cb.message.chat.id, env); }
     else if (String(cb.data || "").startsWith("rejr:")) await handleRejectReasonCallback(cb, env, adminIds);
     else if (String(cb.data || "").startsWith("undo:")) await handleUndoCallback(cb, env, adminIds);
     else if (String(cb.data || "").startsWith("car")) await handleCarCallback(cb, env, adminIds);
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
     await send(chatId, "🚘 Как проходит подбор AVTOY KOREA:\n1. Уточняем бюджет и пожелания.\n2. Ищем подходящие варианты.\n3. Обсуждаем проверку, покупку и доставку.\n\nГотового каталога объявлений пока нет — напишите желаемую марку, модель и бюджет, и менеджер поможет с подбором.");
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
  if (request.method === "POST" && url.pathname === "/api/request") {
   const headers = {"cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer"};
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
   if (!f.name || !f.contact) return Response.json({ok:false,error:"Укажите имя и контакт для связи."},{status:400});
   const message = ["🚘 Новая заявка AVTOY KOREA","",`Имя: ${f.name}`,`Контакт: ${f.contact}`,`Марка / модель: ${f.model||"не указано"}`,`Бюджет: ${f.budget||"не указан"}`,`Страна: ${f.country||"не указана"}`,`Год от: ${f.year||"не указан"}`,`Тема обращения: ${f.purpose||"Подбор автомобиля"}`,`Пожелания: ${f.details||"нет"}`].join("\n");
   if (!env.TELEGRAM_BOT_TOKEN || adminIds.length < 1 || !env.REVIEWS) {
    return Response.json({ok:false,error:"Система учёта заявок временно недоступна. Попробуйте позже."},{status:503});
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
   for(const chat_id of adminIds){
    if(delivered.has(String(chat_id)))continue;
    try{
     const payload=await callTelegram(env,"sendMessage",{chat_id,text:cardText,reply_markup:keyboard});
     if(payload&&payload.ok===true){delivered.add(String(chat_id));idem.deliveredAdminIds=[...delivered];await env.REVIEWS.put(idemKey,JSON.stringify(idem),{expirationTtl:604800});}
    }catch{}
   }
   if(adminIds.some(id=>!delivered.has(String(id))))return fail(503,"Заявка №"+orderNumber+" сохранена. Уведомление доставлено не всем администраторам. Нажмите «Отправить заявку» ещё раз — повторно отправим только недоставленные уведомления.");
   const botUser=String(env.TELEGRAM_BOT_USERNAME||"").replace(/^@/,"");
   return Response.json({ok:true,orderId,orderNumber,botLink:botUser?"https://t.me/"+botUser+"?start=order_"+bindToken:null},{headers});
  }
  if (request.method === "GET" && url.pathname === "/api/cars") {
   const cars = [];
   if (env.REVIEWS) {
    let cursor;
    do {
     const page = await env.REVIEWS.list({prefix:"car_approved:", ...(cursor ? {cursor} : {})});
     for (const key of page.keys) { const raw = await env.REVIEWS.get(key.name); if (!raw) continue; const car = JSON.parse(raw); const photoItems = uniqueFileItems(Array.isArray(car.photos) ? car.photos : (car.fileId && car.mediaType !== "video" ? [{file_id:car.fileId}] : [])); const videoItems = uniqueFileItems(Array.isArray(car.videos) ? car.videos : (car.mediaType === "video" && car.fileId ? [{file_id:car.fileId}] : [])); const mediaItems = [...photoItems.map((_,index)=>({url:"/api/car-media/"+car.id+"/photo/"+index,type:"photo"})), ...videoItems.map((_,index)=>({url:"/api/car-media/"+car.id+"/video/"+index,type:"video"}))]; cars.push({id:car.id,caption:publicCarCaption(car.caption),media:mediaItems[0] ? mediaItems[0].url : null,mediaItems,mediaType:car.mediaType || "photo",publishedAt:car.publishedAt}); }
     cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
   }
   cars.sort((a,b)=>String(b.publishedAt||"").localeCompare(String(a.publishedAt||"")));
   return Response.json({cars},{headers:{"cache-control":"no-store"}});
  }
  const carMediaPath = url.pathname.startsWith("/api/car-media/") ? url.pathname.slice("/api/car-media/".length) : "";
  const carMediaMatch = carMediaPath.match(/^(car_-?[0-9]+_[0-9]+)(?:\/(photo|video)\/(\d+)|(\d+))?$/);
  if (request.method === "GET" && carMediaMatch) {
   if (!env.REVIEWS || !env.TELEGRAM_BOT_TOKEN) return new Response("Not found",{status:404});
   const raw = await env.REVIEWS.get("car_approved:" + carMediaMatch[1]); if (!raw) return new Response("Not found",{status:404});
   const car = JSON.parse(raw); const mediaType = carMediaMatch[2] || (car.mediaType === "video" ? "video" : "photo"); const index = Number(carMediaMatch[3] || carMediaMatch[4] || 0);
   const photos = uniqueFileItems(Array.isArray(car.photos) ? car.photos : (car.fileId && car.mediaType !== "video" ? [{file_id:car.fileId}] : []));
   const videos = uniqueFileItems(Array.isArray(car.videos) ? car.videos : (car.mediaType === "video" && car.fileId ? [{file_id:car.fileId}] : []));
   const selected = (mediaType === "video" ? videos : photos)[index]; const fileId = selected && selected.file_id ? selected.file_id : null;
   if (!fileId) return new Response("Not found",{status:404});
   const info = await callTelegram(env,"getFile",{file_id:fileId}).catch(()=>null); const path = info && info.result && info.result.file_path;
   if (!path) return new Response("Not found",{status:404});
   const upstream = await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + path); if (!upstream.ok) return new Response("Bad Gateway",{status:502});
   const contentType = mediaType === "video" ? (/\.webm$/i.test(path) ? "video/webm" : "video/mp4") : ((selected && selected.mime_type) || "image/jpeg");
   // Media URLs use positional indexes. A car can be replaced while its URL stays the same, so never cache by index.
   return new Response(upstream.body,{headers:{"content-type":contentType,"cache-control":"no-store","x-content-type-options":"nosniff"}});
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
      const photos = uniqueFileItems(Array.isArray(r.photos) && r.photos.length ? r.photos : (r.fileId && r.kind !== "video" ? [{file_id:r.fileId}] : []));
      const mediaItems = r.kind === "video" ? (r.fileId ? [`/api/review-media/${r.id}/0`] : []) : photos.map((_,index)=>`/api/review-media/${r.id}/${index}`);
      const media = r.fileId ? `/api/review-media/${r.id}` : null;
      reviews.push({id:r.id,kind:r.kind,text:cleanPublicationText(r.text),media,mediaItems});
     }
     cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
   }
   return Response.json({ reviews }, { headers: { "cache-control": "no-store" } });
  }
  const mediaMatch = url.pathname.match(/^\/api\/review-media\/(-?\d+_\d+)(?:\/(\d+))?$/);
  if (request.method === "GET" && mediaMatch) {
   // Файлы отдаются через Worker: токен бота в браузер не попадает.
   if (!env.REVIEWS || !env.TELEGRAM_BOT_TOKEN) return new Response("Not found", { status: 404 });
   const raw = await env.REVIEWS.get(`approved:${mediaMatch[1]}`);
   if (!raw) return new Response("Not found", { status: 404 });
   const review = JSON.parse(raw);
   const index = Number(mediaMatch[2] || 0);
   const photos = uniqueFileItems(Array.isArray(review.photos) && review.photos.length ? review.photos : (review.fileId && review.kind !== "video" ? [{file_id:review.fileId}] : []));
   const photoItem = photos[index];
   const fileId = review.kind === "video" ? (index === 0 ? review.fileId : null) : (photoItem && photoItem.file_id);
   if (!fileId) return new Response("Not found", { status: 404 });
   const info = await callTelegram(env, "getFile", { file_id: fileId }).catch(() => null);
   const path = info && info.result && info.result.file_path;
   if (!path) return new Response("Not found", { status: 404 });
   const upstream = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
   if (!upstream.ok) return new Response("Bad Gateway", { status: 502 });
   const imageType = photoItem && photoItem.mime_type;
   const contentType = review.kind === "video" ? "video/mp4" : (imageType || "image/jpeg");
   return new Response(upstream.body, { headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }
  if(url.pathname==="/favicon.ico") return new Response(null,{status:204});
  const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#08090b">
<meta name="description" content="Подбор автомобилей из Кореи, Китая и ОАЭ под ваш бюджет">
<title>AVTOY KOREA: автомобили под заказ</title>
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
.review-gallery{position:relative;width:100%;max-width:100%;height:clamp(170px,22vw,250px);margin:0 0 4px;overflow:hidden;border-radius:14px;background:#080d14}
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
</style>
</head>
<body>
<header class="topbar"><div class="wrap nav">
  <a class="brand" href="#" aria-label="AVTOY KOREA — главная">
    <img class="brand-logo" src="/assets/logo.jpg" alt="AVTOY KOREA — автомобили из Кореи" width="380" height="148">
  </a>
  <nav class="nav-links" aria-label="Основная навигация">
    <a class="nav-home" href="#">Главная</a><a href="#cars">Каталог</a><a href="#order">О нас</a><a href="#order">Услуги</a><a href="#reviews">Отзывы</a><a href="#request">Контакты</a>
  </nav>
  <a class="nav-telegram" href="https://t.me/avtoYkorea" target="_blank" rel="noopener"><span>➤</span><b>Мы в Telegram<small>@avtoYkorea</small></b></a>
  <a class="pill" href="#request">Оставить заявку</a>
</div></header>

<main>
<section class="hero-standard">
  <div class="hero-standard-bg">
    <div class="hero-slide active" style="background-image:url('/assets/kia-sportage.jpg')"></div>
    <div class="hero-slide" style="background-image:url('https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=2000&q=90')"></div>
    <div class="hero-slide" style="background-image:url('https://images.unsplash.com/photo-1552519507-da3b142c6e3d?auto=format&fit=crop&w=2000&q=90')"></div>
  </div>
  <button class="hero-arrow hero-prev" type="button" aria-label="Предыдущий слайд">‹</button><button class="hero-arrow hero-next" type="button" aria-label="Следующий слайд">›</button>
  <div class="wrap hero-standard-content">
    <div class="eyebrow">ПРЯМЫЕ ПОСТАВКИ ИЗ КОРЕИ</div>
    <h1>Автомобили<br><span>из Кореи</span></h1>
    <p class="intro">Надёжные, проверенные, с гарантией.<br>Подберём и доставим автомобиль под ваши требования.</p>
    <a class="btn btn-red" href="#cars">Перейти в каталог <b>→</b></a>
    <div class="hero-dots"><button class="hero-dot active" aria-label="Слайд 1"></button><button class="hero-dot" aria-label="Слайд 2"></button><button class="hero-dot" aria-label="Слайд 3"></button></div>
  </div>
</section>
<section class="benefit-strip"><div class="wrap benefit-grid">
 <article><span class="benefit-icon">♧</span><div><b>Проверенные автомобили</b><small>Только честные предложения<br>и прозрачная история</small></div></article>
 <article><span class="benefit-icon">◇</span><div><b>Гарантия<br>на все авто</b><small>Официальная гарантия<br>на основные узлы</small></div></article>
 <article><span class="benefit-icon">▣</span><div><b>Быстрая доставка</b><small>Оптимальные сроки<br>и полное сопровождение</small></div></article>
 <article><span class="benefit-icon">♧</span><div><b>Поддержка 24/7</b><small>Всегда на связи<br>на всех этапах</small></div></article>
</div></section>

<section class="wrap section" id="about" style="padding-bottom:20px"><div class="eyebrow">AVTOY KOREA</div><h2>Автомобили из Кореи под ваш запрос</h2><p class="sub">Помогаем выбрать автомобиль, проверить его перед покупкой и организовать доставку. Сопровождаем на каждом этапе.</p></section>
<section class="wrap section" id="cars" style="padding-top:20px">
  <div class="eyebrow">Наши автомобили</div>
  <h2>Примеры выполненных заказов</h2>
  <p class="sub">Точная стоимость зависит от курса и условий. Уточняйте у администратора.</p>
  <div class="cars" id="cars-list"><article class="card dashed"><div class="car-body">Объявления из Telegram появятся после проверки и одобрения администратором.</div></article></div>
  <p class="cars-hint">← Листайте пальцем, справа видно следующую машину →</p>
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

<section class="wrap section" id="telegram" style="padding-top:20px">
  <div class="telegram-promo">
    <div><div class="eyebrow">Мы в Telegram</div><h2>Присоединяйтесь к нашему Telegram</h2>
    <p>Следите за новыми автомобилями, свежими предложениями и новостями. Напишите нам напрямую — будем на связи.</p>
    <a class="telegram-promo-link" href="https://t.me/AVTOYKOREABOT" target="_blank" rel="noopener">Открыть бота @AVTOYKOREABOT</a></div>
    <a class="telegram-promo-qr" href="https://t.me/AVTOYKOREABOT" target="_blank" rel="noopener" aria-label="Открыть Telegram-бота по QR-коду">
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAewAAAHsCAIAAACfSAk3AAAIhElEQVR42u3cvaodORCF0TlDY5jE7/+cTgxO5HzApkF1i9rSWrHx6b/7oWh/1lr/AJDpX48AQMQBEHEARBxAxAEQcQBEHAARBxBxAEQcABEHEHEARBwAEQdAxAFEHAARB0DEARBxABEHQMQBEHEAEQdAxAEQcQBEHEDEARBxAEQcABEHEHEARBwAEQcQcQBEHAARB0DEAUQcABEHQMQBRBwAEQdAxAEQcQARB0DEARBxAP7vmXZB3/77fu3L+PXzR9vz6fytzucz7VtNfKeJ38bN36GTOEAwEQcQcQBEHAARBxBxAEQcABEHQMQBRBwAEQdg15N40dO2C96Yto/RuaHR+b5u3vTwd3rn9+MkDhBMxAFEHAARB0DEAUQcABEHQMQBEHEAEQdAxAHY9Zx6Y50bCInbIFW7KFXX3LnTkvgMO3/L36mTOAAiDoCIA4g4ACIOgIgDIOIAIg6AiAMg4gAiDkCIxyPIkrjXUbVZ0bl9kXjNideDkziAiAMg4gCIOAAiDiDiAIg4ACIOgIgDiDgAIg7ABtspYap2Uao2T6q2ODr3Xk59p9O2bnASB0DEAUQcABEHQMQBEHEAEQdAxAEQcQARB0DEAfhix26nnLr/0LlVUrWzUbUNcvO3UXXN0+7dTouTOICIAyDiAIg4ACIOIOIAiDgAIg6AiAOIOAAiDsCGyO2UaVsc0+69c2ejc1/F/zPn//F36iQOgIgDiDgAIg6AiAMg4gAiDoCIAyDiAIg4gIgDMMBnreUpBJm2fVH1W1XX80bnNd/8/eAkDoCIA4g4ACIOgIgDIOIAIg6AiAMg4gAiDoCIA/DFHo9gX+emR+euReIGS+KWy7T31flOT/1/nMQBEHEAEQdAxAEQcQBEHEDEARBxAEQcQMQBEHEAWnzWWqMuaNp2QecuSuLz6XyG01RtcXReT+c3Nu1vx0kcABEHQMQBEHEAEQdAxAEQcQARB0DEARBxAEQc4DhP4kVP23aouuZpz7BK1btI3MzpfD6JbLA4iQNcTcQBRBwAEQdAxAFEHAARB0DEARBxABEHQMQB2DVuOyVxS6Fzy+XU/YfOdzHtO+x876dusDiJAyDiAIg4ACIOIOIAiDgAIg6AiAOIOAAiDoCIA1xp3HZK5x7FG282Kzp3UW7eV+l8hp5P1t/ptGfoJA6AiAOIOAAiDoCIAyDiACIOgIgDIOIAIg6AiAPQYtx2yqnbF6fumVTd16mbMJ3fc9XzSfwbPPXvy0kcQMQBEHEARBwAEQcQcQBEHAARBxBxAEQcABEH4K8+a624i07cTqlStWthH6PnO7x5W2baJsyp+zxO4gDBRBxAxAEQcQBEHEDEARBxAEQcABEHEHEARByAXZHbKW/Y/ch6hjfvopx6X50bPonvwkkcABEHEHEARBwAEQcQcQBEHAARB0DEAUQcABEHYNu47ZRpewuJGyyn3nsi+yp3dsNJHAARBxBxAEQcABEHQMQBRBwAEQdAxAFEHAARB6BF5HbKG537BrYmeu69c8ulc1tm2vPpvJ7EbRkncQBEHAARBxBxAEQcABEHEHEARBwAEQdAxAFEHIAxxm2nvNG5ofFG58ZI4uZJ1Tvt3DPpfO+J31jVNZ/69+4kDoCIA4g4ACIOgIgDIOIAIg6AiAMg4gAiDoCIA9DiOfXG7Jn0mLaz0fltdF5P4vuyeeIkDoCIA4g4ACIOgIgDIOIAIg6AiAMg4gAiDoCIA/DFIrdTEndIEvdVpm1fVH0bid/qqX8XNzfBSRwAEQcQcQBEHAARBxBxAEQcABEHQMQBRBwAEQdg27jtlM4dicTrSdxXSdyomfY9V+ncckmUuK/iJA4QTMQBRBwAEQdAxAFEHAARB0DEARBxABEHQMQB2PUkXvS0/YfOPZPO+5r2W9M2Kzp3dd781rSdn1Pb4iQOgIgDIOIAIg6AiAMg4gAiDoCIAyDiAIg4gIgDMMZz8813bpV0bjKcel83P+fE5zPt3quuedo37yQOEEzEAUQcABEHQMQBRBwAEQdAxAEQcQARB0DEAdgVuZ3SuclQtZNw6gZL570nbnFU7atMexeJz9lJHAARB0DEARBxABEHQMQBEHEAEQdAxAEQcQBEHOA4n7WWpxCkc2dj2vVU/da0Z3jzvSfuxkz7NpzEAYKJOICIAyDiAIg4gIgDIOIAiDgAIg4g4gCIOAC7nmkXVLVvkOjNJkPVPsa065n2W1Xfqi2XrN+a9pydxAEOJ+IAIg6AiAMg4gAiDoCIAyDiAIg4gIgDIOIA7HoSLzpx36Bqz2TaZgVzvufO95W45eIkDoCIAyDiAIg4gIgDIOIAiDiAiAMg4gCIOAAiDnCc59QbO3VH4uZdlM7dmGnv4s1vvfk3b35r2rdRdV+J35iTOMDhRBxAxAEQcQBEHEDEARBxAEQcABEHEHEARByAXY9HwJ9UbVZUbU0k7sacunXTuWcy7b6cxAEQcQBEHEDEARBxAEQcQMQBEHEARBwAEQcQcQDGsJ3CH1VtX1T9P9P2OqZtwlS9i877mrav0vl8nMQBEHEAEQdAxAEQcQARB0DEARBxAEQcQMQBEHEAth27nTJt3+DUZzht+6LqmhP/nyqdWzed93VqE5zEAUQcABEHQMQBRBwAEQdAxAEQcQARB0DEARBxgItFbqdM2+s49fl0PufOjZHEDY2bv/nO7znx23ASBwgm4gAiDoCIAyDiACIOgIgDIOIAiDiAiAMg4gDs+qy1PAUAJ3EARBwAEQcQcQBEHAARB0DEAUQcABEHQMQBRBwAEQdAxAEQcQARB0DEARBxAEQcQMQBEHEARBxAxAEQcQBEHAARBxBxAEQcABEHQMQBRBwAEQdAxAFEHAARB0DEARBxABEHQMQBEHEAEQdAxAEQcQBEHEDEARBxAEQcABEHOMVvuSvv2iMq+uYAAAAASUVORK5CYII=" alt="QR-код для перехода в Telegram-бот AVTOYKOREABOT">
    </a>
  </div>
</section>
<section class="wrap section" id="request" style="padding-top:20px">
  <div class="form-card">
    <div>
      <div class="eyebrow">Бесплатный подбор</div>
      <h2>Какой автомобиль вы ищете?</h2>
      <p class="form-intro">Оставьте параметры автомобиля и удобный контакт. Мы свяжемся с вами по указанному телефону или другому контакту.</p>
      <p class="hint">Можно обратиться и по вопросам рекламы, партнёрства или размещения предложений.</p>
    </div>
    <div>
      <form id="request-form" novalidate>
        <div class="form-grid">
          <div class="field"><label for="name">Ваше имя *</label><input id="name" name="name" required maxlength="100" autocomplete="name" placeholder="Как к вам обращаться"></div>
          <div class="field"><label for="contact">Telegram или телефон *</label><input id="contact" name="contact" required maxlength="150" autocomplete="tel" placeholder="@username или номер"></div>
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
  <a class="telegram" href="https://t.me/avtoYkorea" target="_blank" rel="noopener">Telegram ↗</a>
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
    var mediaItems=Array.isArray(rv.mediaItems)&&rv.mediaItems.length?rv.mediaItems:(rv.media?[rv.media]:[]);
    if(rv.kind==='video'){
      var label=document.createElement('div');label.className='review-video-label';label.textContent='Видео клиента';card.appendChild(label);
      mediaItems.forEach(function(mediaUrl){var el=document.createElement('video');el.className='review-media';el.src=mediaUrl;el.controls=true;el.playsInline=true;el.preload='metadata';el.setAttribute('aria-label','Видео клиента');card.appendChild(el)});
    }else if(mediaItems.length){
      var gallery=document.createElement('div');gallery.className='review-gallery';
      var photoLink=document.createElement('a');photoLink.className='review-gallery-photo';photoLink.target='_blank';photoLink.rel='noopener';
      var photo=document.createElement('img');photo.className='review-gallery-image';photo.loading='eager';photo.decoding='async';photo.alt='Фотография автомобиля клиента';
      photoLink.appendChild(photo);gallery.appendChild(photoLink);
      var photoIndex=0;
      function showReviewPhoto(nextIndex){
        photoIndex=(nextIndex+mediaItems.length)%mediaItems.length;
        photo.src=mediaItems[photoIndex];photoLink.href=mediaItems[photoIndex];
        photo.alt='Фотография автомобиля клиента '+(photoIndex+1);
        counter.textContent=(photoIndex+1)+' / '+mediaItems.length;
        back.disabled=mediaItems.length<2;forward.disabled=mediaItems.length<2;
        back.hidden=forward.hidden=mediaItems.length<2;
        counter.hidden=mediaItems.length<2;
      }
      var back=document.createElement('button');back.type='button';back.className='review-gallery-arrow is-prev';back.textContent='‹';back.setAttribute('aria-label','Предыдущее фото');
      var forward=document.createElement('button');forward.type='button';forward.className='review-gallery-arrow is-next';forward.textContent='›';forward.setAttribute('aria-label','Следующее фото');
      var counter=document.createElement('span');counter.className='review-gallery-count';
      back.addEventListener('click',function(){showReviewPhoto(photoIndex-1)});
      forward.addEventListener('click',function(){showReviewPhoto(photoIndex+1)});
      gallery.appendChild(back);gallery.appendChild(forward);gallery.appendChild(counter);
      var touchStart=0;
      gallery.addEventListener('touchstart',function(e){touchStart=e.changedTouches[0].clientX},{passive:true});
      gallery.addEventListener('touchend',function(e){var delta=e.changedTouches[0].clientX-touchStart;if(Math.abs(delta)>35)showReviewPhoto(photoIndex+(delta<0?1:-1))},{passive:true});
      showReviewPhoto(0);card.appendChild(gallery);
    }
    var who=document.createElement('div');who.className='review-name';who.textContent='Клиент';
    var text=document.createElement('p');text.className='review-text';text.textContent=rv.text||'';
    card.appendChild(who);card.appendChild(text);list.appendChild(card);
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
fetch('/api/cars',{cache:'no-store'}).then(function(r){return r.json()}).then(function(data){
 var list=document.getElementById('cars-list'); if(!list || !data.cars || !data.cars.length)return; list.textContent='';
 var NL=String.fromCharCode(10);
 var hint=document.querySelector('.cars-hint'); if(hint)hint.classList.add('is-on');
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
  var media=Array.isArray(car.mediaItems)&&car.mediaItems.length?car.mediaItems:(car.media?[car.media]:[]);
  var isVideo=car.mediaType==='video';
  var article=document.createElement('article'); article.className='card car-card';
  var body=document.createElement('div'); body.className='car-body';
  var title=document.createElement('h3'); title.textContent=(car.caption||'Автомобиль из объявления').split(NL)[0].slice(0,120);
  var desc=document.createElement('p'); desc.className='car-text'; desc.textContent=car.caption||'Описание не указано';
  body.appendChild(title); body.appendChild(desc);
  if(media.length){
   var gallery=document.createElement('div'); gallery.className='car-gallery';
   var carItems=media.map(function(item){return typeof item==='string'?{url:item,video:isVideo}:{url:item.url,video:item.type==='video'};});
   var stage=document.createElement('div'); stage.className='car-gallery-stage';
   function createCarMedia(item,index){var el=document.createElement(item.video?'video':'img');el.className='car-gallery-main';el.src=item.url;if(item.video){el.controls=true;el.playsInline=true;el.preload='metadata';el.setAttribute('aria-label','Видео автомобиля '+(index+1));}else{el.alt='Фотография автомобиля '+(index+1);el.loading='lazy';}return el;}
   var current=createCarMedia(carItems[0],0);
   stage.appendChild(current); gallery.appendChild(stage);
   var photoIndex=0;
   var count=document.createElement('span');count.className='car-gallery-count';count.textContent='1 / '+media.length;
   var back=document.createElement('button');back.type='button';back.className='car-gallery-arrow is-prev';back.textContent='‹';back.setAttribute('aria-label','Предыдущее фото');
   var forward=document.createElement('button');forward.type='button';forward.className='car-gallery-arrow is-next';forward.textContent='›';forward.setAttribute('aria-label','Следующее фото');
   function showCarPhoto(nextIndex){
    photoIndex=(nextIndex+media.length)%media.length;
    var previous=current;
    current=createCarMedia(carItems[photoIndex],photoIndex);
    stage.replaceChild(current,previous);count.textContent=(photoIndex+1)+' / '+media.length;
   }
   back.hidden=forward.hidden=count.hidden=media.length<2;
   back.onclick=function(){showCarPhoto(photoIndex-1)};
   forward.onclick=function(){showCarPhoto(photoIndex+1)};
   var touchStart=0;
   gallery.addEventListener('touchstart',function(e){touchStart=e.changedTouches[0].clientX},{passive:true});
   gallery.addEventListener('touchend',function(e){var delta=e.changedTouches[0].clientX-touchStart;if(Math.abs(delta)>35)showCarPhoto(photoIndex+(delta<0?1:-1))},{passive:true});
   stage.addEventListener('click',function(e){if(e.target&&e.target.tagName==='VIDEO')return;items=carItems;openBox(photoIndex)});
   gallery.appendChild(back);gallery.appendChild(forward);gallery.appendChild(count);body.appendChild(gallery);
  }
  article.appendChild(body); list.appendChild(article);
 });
}).catch(function(){});
// Главный слайдер: автоматическая смена, точки и стрелки
(function(){
  if(typeof document.querySelector!=='function')return;
  var root=document.querySelector('.hero-standard');
  if(!root || typeof root.querySelector!=='function')return;
  var slides=root.querySelectorAll('.hero-slide');
  var dots=root.querySelectorAll('.hero-dot');
  if(!slides.length)return;
  var index=0;
  function show(next){
    slides[index].classList.remove('active');
    if(dots[index])dots[index].classList.remove('active');
    index=(next+slides.length)%slides.length;
    slides[index].classList.add('active');
    if(dots[index])dots[index].classList.add('active');
  }
  root.querySelector('.hero-prev')?.addEventListener('click',function(){show(index-1)});
  root.querySelector('.hero-next')?.addEventListener('click',function(){show(index+1)});
  dots.forEach(function(dot,i){dot.addEventListener('click',function(){show(i)})});
  window.setInterval(function(){show(index+1)},5000);
})();
</script>
</body>
</html>`;
  return new Response(html,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"strict-origin-when-cross-origin"}});
 }
};
