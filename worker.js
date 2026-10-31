
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
 await env.REVIEWS.put("moderation_edit:" + adminId, JSON.stringify(session), { expirationTtl: 1800 });
 const label = isCar ? "описание автомобиля" : "текст отзыва";
 const instructions = "Текущий текст ниже. Чтобы не переписывать всё, ответьте одной командой:\n" +
  "• ЗАМЕНИТЬ: старый фрагмент => новый фрагмент\n" +
  "• УДАЛИТЬ: ненужный фрагмент\n" +
  "• ДОБАВИТЬ В КОНЕЦ: новый текст\n" +
  "Или отправьте полный исправленный текст, если хотите заменить всё. Команда должна быть ответом на это сообщение.";
 await callTelegram(env, "sendMessage", {
  chat_id: adminId,
  text: "✏️ РЕДАКТИРОВАНИЕ " + label.toUpperCase() + "\n\n" + instructions + "\n\nТЕКУЩИЙ ТЕКСТ:\n" + (currentText || "— пусто —").slice(0, 3000),
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

async function handleAdminModerationEditReply(msg, env, adminIds) {
 const adminId = String(msg.chat && msg.chat.id || "");
 if (!adminIds.includes(adminId) || !env.REVIEWS || !msg.reply_to_message) return false;
 const rawSession = await env.REVIEWS.get("moderation_edit:" + adminId);
 if (!rawSession) return false;
 if (!rawSession) {
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: "Сессия редактирования истекла. Откройте карточку и нажмите «Редактировать» ещё раз." });
  return true;
 }
 const session = JSON.parse(rawSession);
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
function cleanPublicationText(value) {
 return String(value || "")
  .replace(/\r/g, "")
  .replace(/(?:^|\n)\s*Для заказа аналогичного автомобиля обращайтесь\s*:?[^]*$/i, "")
  .replace(/^\s*Источник:\s*https?:\/\/\S+\s*$/gim, "")
  .replace(/^\s*(?:📞|☎️?|тел(?:ефон)?\s*[:：]?|владимир\s*[:：]?|whats?app\s*[:：]?|telegram\s*[:：]?|контакт\s*[:：]?|имя\s*[:：]?).*$/gim, "")
  .replace(/^\s*Видео\s*$/gim, "")
  .replace(/(?:https?:\/\/)?t\.me\/[\w+/?=&%-]+/gi, "")
  .replace(/\+?\d[\d\s().-]{7,}\d/g, "")
  .replace(/^\s*[-–—|,;:]+\s*$/gm, "")
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

async function handleAdminMediaUpload(msg, env, adminIds) {
 const adminId = String(msg.chat && msg.chat.id || "");
 if (!adminIds.includes(adminId) || msg.forward_origin) return false;
 const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null;
 const video = msg.video || null;
 if (!photo && !video) return false;
 if (!env.REVIEWS) {
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"Хранилище REVIEWS не настроено. Медиа не принято."});
  return true;
 }
 const id = adminId + "_" + String(msg.message_id);
 const uploadKey = "admin_upload:" + id;
 let state = JSON.parse(await env.REVIEWS.get(uploadKey) || "null");
 if (state && ["approved","rejected"].includes(state.status)) {
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"Это медиа уже обработано."});
  return true;
 }
 if (!state) {
  const caption = String(msg.caption || "").trim().slice(0,1000);
  const review = {id,kind:video ? "video" : "text",text:caption,name:"Администратор загрузил",fileId:video ? video.file_id : photo.file_id,hasPhoto:Boolean(photo),hasThanks:THANKS_PATTERN.test(caption),anonymous:false,createdAt:new Date().toISOString(),sourceUrl:"Загрузка администратора"};
  state = {review,cardSent:false,status:"pending"};
  await env.REVIEWS.put("pending:" + id,JSON.stringify(review));
  await env.REVIEWS.put(uploadKey,JSON.stringify(state),{expirationTtl:2592000});
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
 const body = String(msg.text || msg.caption || "").trim();
 if (!/^\/review(@\w+)?(\s|$)/i.test(body)) return;
 const text = body.replace(/^\/review(@\w+)?/i, "").trim().slice(0, 1000);
 const video = msg.video ? msg.video.file_id : null;
 const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1].file_id : null;
 if (!text && !video) return;
 const id = `${msg.chat.id}_${msg.message_id}`;
 const review = {
  id,
  kind: video ? "video" : "text",
  text,
  name: String((msg.from && msg.from.first_name) || "Клиент").slice(0, 50),
  fileId: video || photo || null,
  photos: photo ? [{file_id: photo}] : [],
  hasPhoto: Boolean(photo),
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
  if (review.fileId) {
   await callTelegram(env, video ? "sendVideo" : "sendPhoto", { chat_id: adminId, [video ? "video" : "photo"]: review.fileId });
  }
  await callTelegram(env, "sendMessage", { chat_id: adminId, text: formatReviewCard(review), reply_markup: keyboard });
 }));
}

async function handleReviewCallback(callback, env, adminIds) {
 const answer = (text, alert = false) => callTelegram(env, "answerCallbackQuery", { callback_query_id: callback.id, text, show_alert: alert });
 const fromId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(fromId)) return answer("Нет доступа", true);
 const match = String(callback.data || "").match(/^(pub|rej|anon|edit):(-?\d+_\d+)$/);
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
  return answer("Не публикуется");
 }
 const problem = reviewRuleProblem(review);
 if (problem) return answer(`Нельзя опубликовать: ${problem}`, true);
 const published = {
  id,
  kind: review.kind,
  text: review.text,
  name: review.anonymous ? "" : review.name,
  fileId: review.fileId,
  photos: Array.isArray(review.photos) && review.photos.length ? review.photos : (review.fileId && review.kind !== "video" ? [{file_id:review.fileId}] : []),
  publishedAt: new Date().toISOString()
 };
 await env.REVIEWS.put(`approved:${id}`, JSON.stringify(published));
 await env.REVIEWS.delete(`pending:${id}`);
 const uploadRaw = await env.REVIEWS.get("admin_upload:" + id);
 if (uploadRaw) { const uploadState = JSON.parse(uploadRaw); uploadState.status = "approved"; await env.REVIEWS.put("admin_upload:" + id,JSON.stringify(uploadState),{expirationTtl:2592000}); }
 return answer("Опубликовано на сайте");
}

// --- Импорт канала: сначала администратор выбирает тип, затем отдельная модерация ---
function sourcePostDate(post) {
 const value = Number(post.sourceDate || post.date || 0);
 return value > 0 ? value : 0;
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
 const photos = Array.isArray(post.photo) ? post.photo : [];
 const fileId = photos.length ? photos[photos.length - 1].file_id : (post.video ? post.video.file_id : null);
 if (!caption && !fileId) return;
 if (!env.REVIEWS) { await Promise.all(adminIds.map(id => callTelegram(env, "sendMessage", {chat_id:id,text:"Объявление получено, но хранилище REVIEWS не настроено."}))); return; }
 const id = "car_" + String(chat.id).replace(/-/g,"") + "_" + String(post.message_id);
 const existing = await env.REVIEWS.get("car_pending:" + id) || await env.REVIEWS.get("car_approved:" + id);
 if (existing) {
  await Promise.all(adminIds.map(adminId => callTelegram(env,"sendMessage",{chat_id:adminId,text:"ℹ️ Это объявление уже импортировано или находится на модерации: https://t.me/" + chat.username + "/" + post.message_id})));
  return;
 }
 const car = {id,caption,fileId,photos,mediaType:post.video ? "video" : "photo",sourceUrl:"https://t.me/" + chat.username + "/" + post.message_id,createdAt:new Date().toISOString(),sourceDate:created};
 await env.REVIEWS.put("car_pending:" + id, JSON.stringify(car));
 const keyboard = {inline_keyboard:[[{text:"✅ Опубликовать",callback_data:"carpub:" + id},{text:"❌ Отклонить",callback_data:"carrej:" + id}],[{text:"✏️ Редактировать описание",callback_data:"caredit:" + id}]]};
 await Promise.all(adminIds.map(async adminId => {
  if (photos.length > 1) {
   const media = photos.slice(0,10).map((photo,index)=>({type:"photo",media:photo.file_id,...(index===0 && caption ? {caption:caption.slice(0,1024)} : {})}));
   await callTelegram(env,"sendMediaGroup",{chat_id:adminId,media});
  } else if (fileId) {
   await callTelegram(env,post.video ? "sendVideo" : "sendPhoto",{chat_id:adminId,[post.video ? "video" : "photo"]:fileId, ...(caption ? {caption:caption.slice(0,1024)} : {})});
  }
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"🚘 Один автомобиль из канала AVTOY KOREA\nФотографий: " + photos.length + "\n\n" + (caption || "Описание отсутствует") + "\n\nИсточник: " + car.sourceUrl,reply_markup:keyboard});
 }));
}

async function handleImportedReview(post, env, adminIds) {
 const chat = post.chat || {};
 if ((String(chat.username || "").toLowerCase() !== "avtoykorea" && post.sourceType !== "group") || !env.REVIEWS) return;
 const text = cleanPublicationText(post.caption || post.text).slice(0, 1000);
 const rawPhotos = Array.isArray(post.photos) ? post.photos : (Array.isArray(post.photo) ? post.photo : []);
 const photoIds = [...new Set(rawPhotos.map(item => item && item.file_id ? item.file_id : item).filter(Boolean))];
 const photo = photoIds[0] || null;
 const video = post.video && post.video.file_id ? post.video.file_id : null;
 if (!text && !photo && !video) {
  await Promise.all(adminIds.map(adminId => callTelegram(env,"sendMessage",{chat_id:adminId,text:"Отзыв не импортирован: в публикации нет текста, фото или видео."})));
  return;
 }
 const id = String(chat.id) + "_" + String(post.message_id);
 if (await env.REVIEWS.get("approved:" + id)) return;
 const existingReview = await env.REVIEWS.get("pending:" + id);
 const review = existingReview ? JSON.parse(existingReview) : {
  id,kind:video ? "video" : "text",text,name:"Клиент",fileId:video || photo || null,photos:photoIds.map(file_id=>({file_id})),hasPhoto:Boolean(photo),hasThanks:THANKS_PATTERN.test(text),anonymous:false,createdAt:new Date().toISOString(),sourceUrl:post.sourceUrl || (chat.username ? "https://t.me/" + chat.username + "/" + post.message_id : "Сообщение из закрытой группы")
 };
 if (existingReview) {
  review.photos = Array.isArray(review.photos) ? review.photos : (review.fileId && review.kind !== "video" ? [{file_id:review.fileId}] : []);
  const known = new Set(review.photos.map(item=>item.file_id));
  for (const fileId of photoIds) if (!known.has(fileId)) review.photos.push({file_id:fileId});
  if (!review.fileId) review.fileId = photo;
  review.hasPhoto = Boolean(review.photos.length || photo);
  if (!review.text && text) review.text = text;
  await env.REVIEWS.put("pending:" + id,JSON.stringify(review));
 } else await env.REVIEWS.put("pending:" + id,JSON.stringify(review));
 const keyboard = {inline_keyboard:[[{text:"✅ Опубликовать",callback_data:"pub:" + id},{text:"❌ Не публиковать",callback_data:"rej:" + id}],[{text:"🙈 Скрыть имя",callback_data:"anon:" + id},{text:"✏️ Редактировать текст",callback_data:"edit:" + id}]]};
 const deliveryKey = "review_delivery:" + id;
 const delivery = JSON.parse(await env.REVIEWS.get(deliveryKey) || "{}");
 delivery.admins = delivery.admins || {};
 for (const adminId of adminIds) {
  const status = delivery.admins[String(adminId)] || {mediaSent:!review.fileId && !(review.photos && review.photos.length),cardSent:false};
  if (!status.mediaSent) {
   if (review.kind === "video" && review.fileId) {
    await callTelegram(env,"sendVideo",{chat_id:adminId,video:review.fileId});
   } else {
    const ids = (Array.isArray(review.photos) && review.photos.length ? review.photos : (review.fileId ? [{file_id:review.fileId}] : [])).map(item=>item.file_id).filter(Boolean);
    for (let offset=0; offset<ids.length; offset+=10) {
     const chunk = ids.slice(offset,offset+10);
     if (chunk.length > 1) {
      const media = chunk.map((file_id,index)=>({type:"photo",media:file_id,...(offset===0 && index===0 && text ? {caption:text.slice(0,1024)} : {})}));
      await callTelegram(env,"sendMediaGroup",{chat_id:adminId,media});
     } else if (chunk.length === 1) {
      await callTelegram(env,"sendPhoto",{chat_id:adminId,photo:chunk[0],...(offset===0 && text ? {caption:text.slice(0,1024)} : {})});
     }
    }
   }
   status.mediaSent = true;
   delivery.admins[String(adminId)] = status;
   await env.REVIEWS.put(deliveryKey,JSON.stringify(delivery),{expirationTtl:2592000});
  }
  if (!status.cardSent) {
   await callTelegram(env,"sendMessage",{chat_id:adminId,text:formatReviewCard(review) + "\n\nФотографий: " + (review.photos || []).length + "\nИсточник: " + review.sourceUrl,reply_markup:keyboard});
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

async function stageChannelPost(post, env, adminIds) {
 const chat = post.chat || {};
 if (String(chat.username || "").toLowerCase() !== "avtoykorea" || !env.REVIEWS) return;
 // Telegram sends each album photo as a separate channel_post update.
 // Keep the normal numeric callback ID, and map the album ID to that record.
 const albumId = String(post.media_group_id || "");
 const albumPointer = albumId ? "import_album:" + String(chat.id) + "_" + albumId : null;
 let id = String(chat.id) + "_" + String(post.message_id);
 let key = "import_pending:" + id;
 if (albumPointer) {
  const linkedId = await env.REVIEWS.get(albumPointer);
  if (linkedId) {
   id = linkedId;
   key = "import_pending:" + id;
   const raw = await env.REVIEWS.get(key);
   if (raw) {
    const entry = JSON.parse(raw);
    const saved = entry.post || entry;
    const all = Array.isArray(saved.photo) ? saved.photo : [];
    const fileId = Array.isArray(post.photo) && post.photo.length ? post.photo[post.photo.length-1].file_id : null;
    if (fileId && !all.some(p => p.file_id === fileId)) all.push({file_id:fileId});
    saved.photo = all;
    if (!saved.caption && post.caption) saved.caption = post.caption;
    entry.post = saved;
    entry.photo = saved.photo;
    entry.caption = saved.caption;
    await env.REVIEWS.put(key,JSON.stringify(entry),{expirationTtl:2592000});
   }
   return;
  }
 }
 const duplicateCarId = "car_" + String(chat.id).replace(/-/g,"") + "_" + String(post.message_id);
 if (await env.REVIEWS.get(key) || await env.REVIEWS.get("pending:" + id) || await env.REVIEWS.get("approved:" + id) || await env.REVIEWS.get("car_pending:" + duplicateCarId) || await env.REVIEWS.get("car_approved:" + duplicateCarId)) return;
 const stored = {...post,chat,message_id:Number(post.message_id),albumId};
 await env.REVIEWS.put(key,JSON.stringify({...stored,post:stored,albumId}),{expirationTtl:2592000});
 if (albumPointer) await env.REVIEWS.put(albumPointer,id,{expirationTtl:2592000});
 const keyboard = {inline_keyboard:[[{text:"🚗 Автомобиль",callback_data:"imp:car:" + id},{text:"⭐ Отзыв",callback_data:"imp:review:" + id}]]};
 await Promise.all(adminIds.map(async adminId => {
  if (post.video) await callTelegram(env,"sendVideo",{chat_id:adminId,video:post.video.file_id});
  else if (Array.isArray(post.photo) && post.photo.length) await callTelegram(env,"sendPhoto",{chat_id:adminId,photo:post.photo[post.photo.length-1].file_id});
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"📥 Новая публикация из @avtoYkorea. Выберите раздел для импорта.\n\n" + String(post.caption || post.text || "Без текста").slice(0,2500) + "\n\nСнимки одного альбома объединяются в одну карточку.\nДата оригинала: " + (post.sourceDate ? new Date(post.sourceDate*1000).toLocaleString("ru-RU",{timeZone:"Europe/Moscow"}) : "не определена"),reply_markup:keyboard});
 }));
}

// Администратор может отправить фото/видео в настроенную группу отзывов; публикация всё равно проходит личную модерацию.
async function stageGroupMedia(msg, env, adminIds) {
 const groupId = String(env.TELEGRAM_REVIEW_GROUP_ID || "").trim();
 if (!groupId || String(msg.chat && msg.chat.id) !== groupId || !env.REVIEWS) return;
 const photo = Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null;
 const video = msg.video || null;
 if (!photo && !video) return;
 const id = String(msg.chat.id) + "_" + String(msg.message_id);
 if (await env.REVIEWS.get("pending:" + id) || await env.REVIEWS.get("approved:" + id)) return;
 const key = "import_pending:" + id;
 let state = JSON.parse(await env.REVIEWS.get(key) || "null");
 if (!state || !state.post) {
  state = {type:"group_media",post:{...msg,sourceType:"group"},notified:{}};
  await env.REVIEWS.put(key,JSON.stringify(state),{expirationTtl:2592000});
 }
 const keyboard = {inline_keyboard:[[{text:"⭐ Передать в модерацию отзывов",callback_data:"imp:review:" + id}]]};
 for (const adminId of adminIds) {
  const status = state.notified[String(adminId)] || {mediaSent:false,cardSent:false};
  if (!status.mediaSent) {
   await callTelegram(env,video ? "sendVideo" : "sendPhoto",{chat_id:adminId,[video ? "video" : "photo"]:(video ? video.file_id : photo.file_id)});
   status.mediaSent = true;
   state.notified[String(adminId)] = status;
   await env.REVIEWS.put(key,JSON.stringify(state),{expirationTtl:2592000});
  }
  if (!status.cardSent) {
   await callTelegram(env,"sendMessage",{chat_id:adminId,text:"📥 Медиа из группы отзывов. Выберите, передавать ли его на модерацию сайта.\n\n" + String(msg.caption || "").slice(0,1000),reply_markup:keyboard});
   status.cardSent = true;
   state.notified[String(adminId)] = status;
   await env.REVIEWS.put(key,JSON.stringify(state),{expirationTtl:2592000});
  }
 }
}

async function handleCarCallback(callback, env, adminIds) {
 const answer = (text, alert=false) => callTelegram(env,"answerCallbackQuery",{callback_query_id:callback.id,text,show_alert:alert});
 const fromId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(fromId)) return answer("Нет доступа",true);
 const match = String(callback.data || "").match(/^car(pub|rej|edit):(car_-?[0-9]+_[0-9]+)$/);
 if (!match || !env.REVIEWS) return answer("Объявление не найдено",true);
 const action = match[1], id = match[2];
 const raw = await env.REVIEWS.get("car_pending:" + id);
 if (!raw) return answer("Объявление уже обработано или не найдено",true);
 const car = JSON.parse(raw);
 if (action === "edit") return beginModerationEdit(callback, env, "car", id, answer);
 if (action === "rej") { await env.REVIEWS.delete("car_pending:" + id); return answer("Объявление отклонено"); }
 await env.REVIEWS.put("car_approved:" + id,JSON.stringify({...car,publishedAt:new Date().toISOString()}));
 await env.REVIEWS.delete("car_pending:" + id);
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
     else if (String(cb.data || "").startsWith("car")) await handleCarCallback(cb, env, adminIds);
     else await handleReviewCallback(cb, env, adminIds);
    } catch { return new Response("Telegram processing failed", { status: 502 }); }
    return Response.json({ ok: true });
   }
   const channelPost = update.channel_post;
   if (channelPost) { try { await stageChannelPost({...channelPost,sourceDate:channelPost.date}, env, adminIds); } catch { return new Response("Telegram import staging failed", {status:502}); } return Response.json({ok:true}); }
   const msg = update.message;
   if (!msg || !msg.chat || !msg.chat.id) return Response.json({ ok: true });
   // Groups/channels: only the one review group, only /review messages. Everything else is ignored.
   if (msg.chat.type !== "private") {
    try {
     if (adminIds.includes(String((msg.from && msg.from.id) || ""))) await stageGroupMedia(msg, env, adminIds);
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
      await stageChannelPost({...msg, chat: sourceChat, message_id: origin.message_id, sourceDate: origin.date || 0}, env, adminIds);
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
     await send(chatId, "Здравствуйте! Это AVTOY KOREA 🚘\n\nПомогаем с подбором автомобилей из Кореи, Китая и ОАЭ.\n\nКоманды:\n/countries — страны покупки\n/catalog — как проходит подбор\n/contact — оставить заявку\n/help — помощь\n\nНапишите, какой автомобиль ищете, и мы передадим запрос менеджеру.");
     if (!adminIds.includes(chatId)) {
      const notice = "👋 Новый пользователь бота AVTOY KOREA\nИмя: " + String((msg.from && (msg.from.first_name || msg.from.username)) || "не указано") + "\nChat ID: " + chatId;
      await Promise.all(adminIds.map(id => send(id, notice)));
     }
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
     for (const key of page.keys) { const raw = await env.REVIEWS.get(key.name); if (!raw) continue; const car = JSON.parse(raw); const photos = Array.isArray(car.photos) && car.photos.length ? car.photos.map((_,index)=>"/api/car-media/"+car.id+"/"+index) : (car.fileId ? ["/api/car-media/"+car.id+"/0"] : []); cars.push({id:car.id,caption:cleanPublicationText(car.caption),media:photos[0] || null,mediaItems:photos,mediaType:car.mediaType || "photo",publishedAt:car.publishedAt}); }
     cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
   }
   cars.sort((a,b)=>String(b.publishedAt||"").localeCompare(String(a.publishedAt||"")));
   return Response.json({cars},{headers:{"cache-control":"no-store"}});
  }
  const carMediaPath = url.pathname.startsWith("/api/car-media/") ? url.pathname.slice("/api/car-media/".length) : "";
  const carMediaMatch = carMediaPath.match(/^(car_-?[0-9]+_[0-9]+)(?:\/(\d+))?$/);
  if (request.method === "GET" && carMediaMatch) {
   if (!env.REVIEWS || !env.TELEGRAM_BOT_TOKEN) return new Response("Not found",{status:404});
   const raw = await env.REVIEWS.get("car_approved:" + carMediaMatch[1]); if (!raw) return new Response("Not found",{status:404});
   const car = JSON.parse(raw); const index = Number(carMediaMatch[2] || 0);
   const photos = Array.isArray(car.photos) ? car.photos : [];
   const selected = photos[index]; const fileId = selected && selected.file_id ? selected.file_id : (!photos.length && index === 0 ? car.fileId : null);
   if (!fileId) return new Response("Not found",{status:404});
   const info = await callTelegram(env,"getFile",{file_id:fileId}).catch(()=>null); const path = info && info.result && info.result.file_path;
   if (!path) return new Response("Not found",{status:404});
   const upstream = await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + path); if (!upstream.ok) return new Response("Bad Gateway",{status:502});
   const contentType = /\.(mp4|webm)$/i.test(path) ? "video/mp4" : "image/jpeg";
   return new Response(upstream.body,{headers:{"content-type":contentType,"cache-control":"public, max-age=3600","x-content-type-options":"nosniff"}});
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
      const photos = Array.isArray(r.photos) && r.photos.length ? r.photos : (r.fileId && r.kind !== "video" ? [{file_id:r.fileId}] : []);
      const mediaItems = r.kind === "video" ? (r.fileId ? [`/api/review-media/${r.id}/0`] : []) : photos.map((_,index)=>`/api/review-media/${r.id}/${index}`);
      const media = mediaItems[0] || null;
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
   const photos = Array.isArray(review.photos) && review.photos.length ? review.photos : (review.fileId && review.kind !== "video" ? [{file_id:review.fileId}] : []);
   const fileId = review.kind === "video" ? (index === 0 ? review.fileId : null) : (photos[index] && photos[index].file_id);
   if (!fileId) return new Response("Not found", { status: 404 });
   const info = await callTelegram(env, "getFile", { file_id: fileId }).catch(() => null);
   const path = info && info.result && info.result.file_path;
   if (!path) return new Response("Not found", { status: 404 });
   const upstream = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
   if (!upstream.ok) return new Response("Bad Gateway", { status: 502 });
   return new Response(upstream.body, { headers: { "content-type": review.kind === "video" ? "video/mp4" : "image/jpeg", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" } });
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
</style>
</head>
<body>
<header class="topbar"><div class="wrap nav">
  <a class="brand" href="#">AVTO<em>Y</em> KOREA<small>КОРЕЯ · КИТАЙ · ОАЭ</small></a>
  <nav class="nav-links">
    <a href="#reviews">Отзывы</a>
    <a href="#order">Как заказать</a>
    <a class="pill" href="#request">Подобрать автомобиль</a>
  </nav>
</div></header>

<main>
<section class="wrap hero">
  <div>
    <div class="eyebrow">Автомобили под заказ</div>
    <h1>Подберём<br><span>ваш автомобиль</span></h1>
    <p class="intro">Подберём автомобиль под ваш бюджет, проверим перед покупкой и организуем доставку из Кореи, Китая или ОАЭ.</p>
    <div class="actions">
      <a class="btn btn-red" href="#request">Оставить заявку →</a>
      <a class="btn btn-dark telegram" href="https://t.me/avtoYkorea" target="_blank" rel="noopener">✈ Написать в Telegram</a>
    </div>
  </div>
  <div class="photo" aria-label="Галерея автомобилей">
    <div class="hero-slide active" style="background-image:url('https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1400&q=85')"></div>
    <div class="hero-slide" style="background-image:url('https://images.unsplash.com/photo-1503376780353-7e6692767b70?auto=format&fit=crop&w=1400&q=85')"></div>
    <div class="hero-slide" style="background-image:url('https://images.unsplash.com/photo-1552519507-da3b142c6e3d?auto=format&fit=crop&w=1400&q=85')"></div>
    <div class="hero-caption">Автомобили из Кореи, Китая и ОАЭ</div>
    <div class="hero-dots" aria-hidden="true"><span class="hero-dot active"></span><span class="hero-dot"></span><span class="hero-dot"></span></div>
  </div>
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

<section class="wrap section" id="cars" style="padding-top:20px">
  <div class="eyebrow">Наши автомобили</div>
  <h2>Примеры выполненных заказов</h2>
  <p class="sub">Точная стоимость зависит от курса и условий. Уточняйте у администратора.</p>
  <div class="cars" id="cars-list"><article class="card dashed"><div class="car-body">Объявления из Telegram появятся после проверки и одобрения администратором.</div></article></div>
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
    mediaItems.forEach(function(mediaUrl,mediaIndex){if(rv.kind==='video'){var label=document.createElement('div');label.className='review-video-label';label.textContent='Видеоотзыв клиента';if(mediaIndex===0)card.appendChild(label);var el=document.createElement('video');el.className='review-media';el.src=mediaUrl;el.controls=true;el.playsInline=true;el.preload='metadata';el.setAttribute('aria-label','Видеоотзыв клиента');card.appendChild(el)}else{var el=document.createElement('img');el.className='review-media';el.src=mediaUrl;el.loading='lazy';el.alt='Фото автомобиля клиента '+(mediaIndex+1);card.appendChild(el)}});
    var who=document.createElement('div');who.className='review-name';who.textContent=rv.name;
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
fetch('/api/cars',{cache:'no-store'}).then(r=>r.json()).then(data=>{
 const list=document.getElementById('cars-list'); if(!list || !data.cars || !data.cars.length)return; list.textContent='';
 data.cars.forEach(car=>{
  const article=document.createElement('article'); article.className='card car-card';
  (Array.isArray(car.mediaItems)&&car.mediaItems.length?car.mediaItems:(car.media?[car.media]:[])).forEach(function(mediaUrl,index){if(car.mediaType==='video'){const video=document.createElement('video');video.className='review-media';video.src=mediaUrl;video.controls=true;video.playsInline=true;video.preload='metadata';article.appendChild(video)}else{const img=document.createElement('img');img.className='review-media';img.src=mediaUrl;img.alt='Фотография автомобиля '+(index+1);img.loading='lazy';article.appendChild(img)}});
  const body=document.createElement('div');body.className='car-body';
  const title=document.createElement('h3');title.textContent=(car.caption||'Автомобиль из объявления').split('\\n')[0].slice(0,120);
  const desc=document.createElement('div');desc.className='car-specs';desc.style.display='block';desc.style.whiteSpace='pre-line';desc.textContent=car.caption||'Описание не указано';
  body.appendChild(title);body.appendChild(desc);

  article.appendChild(body);list.appendChild(article);
 });
}).catch(()=>{});
// Плавная смена фотографий в главном блоке
(function(){
  var slides=document.querySelectorAll('.hero-slide');
  var dots=document.querySelectorAll('.hero-dot');
  if(slides.length<2)return;
  var index=0;
  window.setInterval(function(){
    slides[index].classList.remove('active');dots[index].classList.remove('active');
    index=(index+1)%slides.length;
    slides[index].classList.add('active');dots[index].classList.add('active');
  },5000);
})();
</script>
</body>
</html>`;
  return new Response(html,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"strict-origin-when-cross-origin"}});
 }
};
