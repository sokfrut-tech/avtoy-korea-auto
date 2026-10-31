// --- Отзывы: модерация администратором через кнопки в личке с ботом ---
const THANKS_PATTERN = /спасибо|благодар/i;

async function callTelegram(env, method, payload) {
 const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload)
 });
 if (!response.ok) throw new Error("Telegram API request failed");
 return response.json();
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
  [{ text: "🙈 Скрыть имя", callback_data: `anon:${id}` }]
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
 const match = String(callback.data || "").match(/^(pub|rej|anon):(-?\d+_\d+)$/);
 if (!match || !env.REVIEWS) return answer("Отзыв не найден", true);
 const [, action, id] = match;
 const raw = await env.REVIEWS.get(`pending:${id}`);
 if (!raw) return answer("Отзыв уже обработан или не найден", true);
 const review = JSON.parse(raw);
 if (action === "anon") {
  review.anonymous = true;
  await env.REVIEWS.put(`pending:${id}`, JSON.stringify(review));
  return answer("Имя будет скрыто");
 }
 if (action === "rej") {
  await env.REVIEWS.delete(`pending:${id}`);
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
  publishedAt: new Date().toISOString()
 };
 await env.REVIEWS.put(`approved:${id}`, JSON.stringify(published));
 await env.REVIEWS.delete(`pending:${id}`);
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
 const caption = String(post.caption || post.text || "").trim().slice(0, 3000);
 const photos = Array.isArray(post.photo) ? post.photo : [];
 const fileId = photos.length ? photos[photos.length - 1].file_id : null;
 if (!caption && !fileId) return;
 if (!env.REVIEWS) { await Promise.all(adminIds.map(id => callTelegram(env, "sendMessage", {chat_id:id,text:"Объявление получено, но хранилище REVIEWS не настроено."}))); return; }
 const id = "car_" + String(chat.id).replace(/-/g,"") + "_" + String(post.message_id);
 const existing = await env.REVIEWS.get("car_pending:" + id) || await env.REVIEWS.get("car_approved:" + id);
 if (existing) {
  await Promise.all(adminIds.map(adminId => callTelegram(env,"sendMessage",{chat_id:adminId,text:"ℹ️ Это объявление уже импортировано или находится на модерации: https://t.me/" + chat.username + "/" + post.message_id})));
  return;
 }
 const car = {id,caption,fileId,sourceUrl:"https://t.me/" + chat.username + "/" + post.message_id,createdAt:new Date().toISOString(),sourceDate:created};
 await env.REVIEWS.put("car_pending:" + id, JSON.stringify(car));
 const keyboard = {inline_keyboard:[[{text:"✅ Опубликовать",callback_data:"carpub:" + id},{text:"❌ Отклонить",callback_data:"carrej:" + id}]]};
 await Promise.all(adminIds.map(async adminId => {
  if (fileId) await callTelegram(env,"sendPhoto",{chat_id:adminId,photo:fileId});
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"🚘 Автомобиль из канала AVTOY KOREA\n\n" + (caption || "Описание отсутствует") + "\n\nИсточник: " + car.sourceUrl,reply_markup:keyboard});
 }));
}

async function handleImportedReview(post, env, adminIds) {
 const chat = post.chat || {};
 if (String(chat.username || "").toLowerCase() !== "avtoykorea" || !env.REVIEWS) return;
 const text = String(post.caption || post.text || "").trim().slice(0, 1000);
 const photos = Array.isArray(post.photo) ? post.photo : [];
 const photo = photos.length ? photos[photos.length - 1].file_id : null;
 const video = post.video && post.video.file_id ? post.video.file_id : null;
 if (!text && !photo && !video) {
  await Promise.all(adminIds.map(adminId => callTelegram(env,"sendMessage",{chat_id:adminId,text:"Отзыв не импортирован: в публикации нет текста, фото или видео."})));
  return;
 }
 const id = String(chat.id) + "_" + String(post.message_id);
 if (await env.REVIEWS.get("pending:" + id) || await env.REVIEWS.get("approved:" + id)) {
  await Promise.all(adminIds.map(adminId => callTelegram(env,"sendMessage",{chat_id:adminId,text:"ℹ️ Этот отзыв уже импортирован или находится на модерации."})));
  return;
 }
 const review = {id,kind:video ? "video" : "text",text,name:"Клиент",fileId:video || photo || null,hasPhoto:Boolean(photo),hasThanks:THANKS_PATTERN.test(text),anonymous:false,createdAt:new Date().toISOString(),sourceUrl:"https://t.me/" + chat.username + "/" + post.message_id};
 await env.REVIEWS.put("pending:" + id,JSON.stringify(review));
 const keyboard = {inline_keyboard:[[{text:"✅ Опубликовать",callback_data:"pub:" + id},{text:"❌ Не публиковать",callback_data:"rej:" + id}],[{text:"🙈 Скрыть имя",callback_data:"anon:" + id}]]};
 await Promise.all(adminIds.map(async adminId => {
  if (video) await callTelegram(env,"sendVideo",{chat_id:adminId,video});
  else if (photo) await callTelegram(env,"sendPhoto",{chat_id:adminId,photo});
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:formatReviewCard(review) + "\n\nИсточник: " + review.sourceUrl,reply_markup:keyboard});
 }));
}

async function handleImportChoice(callback, env, adminIds) {
 const answer = (text, alert=false) => callTelegram(env,"answerCallbackQuery",{callback_query_id:callback.id,text,show_alert:alert});
 const fromId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(fromId)) return answer("Нет доступа",true);
 const match = String(callback.data || "").match(/^imp:(car|review):(-?\d+_\d+)$/);
 if (!match || !env.REVIEWS) return answer("Импорт не найден",true);
 const [,kind,id] = match;
 const raw = await env.REVIEWS.get("import_pending:" + id);
 if (!raw) return answer("Публикация уже обработана или не найдена",true);
 const post = JSON.parse(raw);
 await env.REVIEWS.delete("import_pending:" + id);
 if (kind === "car") await handleCarPost(post,env,adminIds);
 else await handleImportedReview(post,env,adminIds);
 return answer(kind === "car" ? "Передано в модерацию автомобилей" : "Передано в модерацию отзывов");
}

async function stageChannelPost(post, env, adminIds) {
 const chat = post.chat || {};
 if (String(chat.username || "").toLowerCase() !== "avtoykorea" || !env.REVIEWS) return;
 const id = String(chat.id) + "_" + String(post.message_id);
 if (await env.REVIEWS.get("import_pending:" + id) || await env.REVIEWS.get("pending:" + id) || await env.REVIEWS.get("approved:" + id) || await env.REVIEWS.get("car_pending:car_" + String(chat.id).replace(/-/g,"") + "_" + post.message_id) || await env.REVIEWS.get("car_approved:car_" + String(chat.id).replace(/-/g,"") + "_" + post.message_id)) {
  await Promise.all(adminIds.map(adminId => callTelegram(env,"sendMessage",{chat_id:adminId,text:"ℹ️ Эта публикация уже импортирована или ожидает выбора/модерации."})));
  return;
 }
 await env.REVIEWS.put("import_pending:" + id,JSON.stringify(post));
 const keyboard = {inline_keyboard:[[{text:"🚗 Автомобиль",callback_data:"imp:car:" + id},{text:"⭐ Отзыв",callback_data:"imp:review:" + id}]]};
 await Promise.all(adminIds.map(async adminId => {
  if (post.video) await callTelegram(env,"sendVideo",{chat_id:adminId,video:post.video.file_id});
  else if (Array.isArray(post.photo) && post.photo.length) await callTelegram(env,"sendPhoto",{chat_id:adminId,photo:post.photo[post.photo.length-1].file_id});
  await callTelegram(env,"sendMessage",{chat_id:adminId,text:"📥 Новая публикация из @avtoYkorea. Выберите раздел для импорта.\n\n" + String(post.caption || post.text || "Без текста").slice(0,2500) + "\n\nДата оригинала: " + (post.sourceDate ? new Date(post.sourceDate*1000).toLocaleString("ru-RU",{timeZone:"Europe/Moscow"}) : "не определена"),reply_markup:keyboard});
 }));
}

async function handleCarCallback(callback, env, adminIds) {
 const answer = (text, alert=false) => callTelegram(env,"answerCallbackQuery",{callback_query_id:callback.id,text,show_alert:alert});
 const fromId = String((callback.from && callback.from.id) || "");
 if (!adminIds.includes(fromId)) return answer("Нет доступа",true);
 const match = String(callback.data || "").match(/^car(pub|rej):(car_-?[0-9]+_[0-9]+)$/);
 if (!match || !env.REVIEWS) return answer("Объявление не найдено",true);
 const action = match[1], id = match[2];
 const raw = await env.REVIEWS.get("car_pending:" + id);
 if (!raw) return answer("Объявление уже обработано или не найдено",true);
 const car = JSON.parse(raw);
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
 const data=String(callback.data||""),match=data.match(/^ord:(\d+)$/),detail=data.match(/^ordinfo:(\d+)$/);
 if((!match&&!detail)||!env.REVIEWS)return answer("Заявка не найдена",true);
 const number=(match||detail)[1],raw=await env.REVIEWS.get((/^[0-9a-f]{16}$/i.test(number)?"order:":"order_no:")+number);
 if(!raw)return answer("Заявка не найдена",true);
 const order=JSON.parse(raw);
 if(detail){const targetChat=callback.message&&callback.message.chat; if(!targetChat||targetChat.type!=="private"||String(targetChat.id)!==fromId)return answer("Откройте карточку в личном чате с ботом. Данные не отправлены.",true); await callTelegram(env,"sendMessage",{chat_id:fromId,text:formatOrderPrivate(order)});return answer("Данные отправлены только вам");}
 if(order.status==="in_work")return answer("Заявка уже принята в работу"); if(order.status==="done")return answer("Заявка уже завершена");
 order.status="in_work";order.acceptedBy=fromId;order.acceptedAt=new Date().toISOString();
 await env.REVIEWS.put("order_no:"+number,JSON.stringify(order));await env.REVIEWS.put("order:"+order.id,JSON.stringify(order));
 if(callback.message)await callTelegram(env,"editMessageReplyMarkup",{chat_id:callback.message.chat.id,message_id:callback.message.message_id,reply_markup:{inline_keyboard:[[{text:"🔐 Данные клиента",callback_data:"ordinfo:"+number},{text:"🏁 Завершить",callback_data:"orddone:"+number}]]}});
 if(order.chatId)await callTelegram(env,"sendMessage",{chat_id:order.chatId,text:"Ваша заявка №"+(order.number||number)+" принята в работу. С вами свяжутся в этом чате."});
 return answer("Заявка принята в работу");
}
async function handleOrderDoneCallback(callback,env,adminIds){
 const answer=(text,alert=false)=>callTelegram(env,"answerCallbackQuery",{callback_query_id:callback.id,text,show_alert:alert});
 const fromId=String((callback.from&&callback.from.id)||"");if(!adminIds.includes(fromId))return answer("Нет доступа",true);
 const m=String(callback.data||"").match(/^orddone:(\d+)$/);if(!m||!env.REVIEWS)return answer("Заявка не найдена",true);
 const raw=await env.REVIEWS.get("order_no:"+m[1]);if(!raw)return answer("Заявка не найдена",true);
 const order=JSON.parse(raw);order.status="done";order.completedAt=new Date().toISOString();
 await env.REVIEWS.put("order_no:"+order.number,JSON.stringify(order));await env.REVIEWS.put("order:"+order.id,JSON.stringify(order));
 if(callback.message)await callTelegram(env,"editMessageReplyMarkup",{chat_id:callback.message.chat.id,message_id:callback.message.message_id,reply_markup:{inline_keyboard:[]}});
 return answer("Заявка завершена");
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
   let update;
   try { update = await request.json(); } catch {
    return new Response("Bad Request", { status: 400 });
   }
   if (update.callback_query) {
    const cb = update.callback_query;
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
    try { await handleReviewSubmission(msg, env, adminIds); } catch { return new Response("Telegram processing failed", { status: 502 }); }
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
    return response.json();
   };
   const send = (target, body) => api("sendMessage", {
    chat_id: target, text: body, disable_web_page_preview: true
   });
   try {
    // /myid returns only the sender's own numeric Telegram ID for safe admin configuration.
    if (/^\/myid(?:@\w+)?$/i.test(text)) {
     await send(chatId, "Ваш Telegram ID: " + chatId + "\nПередайте этот номер владельцу настройки TELEGRAM_ADMIN_IDS. Не отправляйте токен бота.");
    } else if (adminIds.includes(chatId) && msg.reply_to_message) {
     const repliedText = String(msg.reply_to_message.text || msg.reply_to_message.caption || "");
     const orderMatch = repliedText.match(/Заявка:\s*([0-9a-f]{16})/i);
     if (orderMatch && env.REVIEWS) {
      const rawOrder = await env.REVIEWS.get("order:" + orderMatch[1]);
      if (rawOrder) {
       const order = JSON.parse(rawOrder);
       if (order.chatId) {
        await send(order.chatId, text || " ");
        await send(chatId, "Ответ отправлен клиенту по заявке " + order.id + ".");
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
    } else if (/^\/start order_[0-9a-f]{16}$/.test(text)) {
     // Клиент открыл бота по ссылке с сайта: привязываем его чат к заявке.
     const orderId = text.slice("/start order_".length);
     const raw = env.REVIEWS ? await env.REVIEWS.get(`order:${orderId}`) : null;
     if (!raw) {
      await send(chatId, "Заявка не найдена. Оставьте её на сайте ещё раз.");
     } else {
      const order = JSON.parse(raw);
      order.chatId = chatId;
      await env.REVIEWS.put(`order:${orderId}`, JSON.stringify(order));
      await send(chatId, "Спасибо! Ваша заявка получена. С вами свяжутся в этом чате.");
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
     await Promise.all(adminIds.map(id => send(id, notice)));
     await send(chatId, "Спасибо! Ваше сообщение передано менеджеру. Мы ответим, как только сможем.");
    } else if (text && adminIds.includes(chatId)) {
     await send(chatId, "Для ответа клиенту используйте: /reply CHAT_ID текст сообщения\nChat ID клиента указан в уведомлении.");
    }
   } catch {
    return new Response("Telegram processing failed", { status: 502 });
   }
   return Response.json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/request") {
   let d;
   try { d = await request.json(); } catch { return Response.json({ok:false,error:"Некорректные данные"},{status:400}); }
   const clean = (v,n=500) => String(v||"").replace(/[<>]/g,"").trim().slice(0,n);
   const f = {name:clean(d.name,100),contact:clean(d.contact,150),model:clean(d.model,150),budget:clean(d.budget,100),country:clean(d.country,80),year:clean(d.year,30),purpose:clean(d.purpose,100),details:clean(d.details,1000)};
   if (!f.name || !f.contact) return Response.json({ok:false,error:"Укажите имя и контакт для связи."},{status:400});
   const message = ["🚘 Новая заявка AVTOY KOREA","",`Имя: ${f.name}`,`Контакт: ${f.contact}`,`Марка / модель: ${f.model||"не указано"}`,`Бюджет: ${f.budget||"не указан"}`,`Страна: ${f.country||"не указана"}`,`Год от: ${f.year||"не указан"}`,`Тема обращения: ${f.purpose||"Подбор автомобиля"}`,`Пожелания: ${f.details||"нет"}`].join("\n");
   if (!env.TELEGRAM_BOT_TOKEN || adminIds.length < 1 || !env.REVIEWS) {
    return Response.json({ok:false,error:"Система учёта заявок временно недоступна. Попробуйте позже."},{status:503});
   }
   const orderId=crypto.randomUUID().replace(/-/g,"").slice(0,16);
   const orderNumber=String(Date.now());
   const order={id:orderId,number:orderNumber,...f,status:"new",chatId:null,telegramId:null,username:null,createdAt:new Date().toISOString()};
   await env.REVIEWS.put("order:"+orderId,JSON.stringify(order));
   await env.REVIEWS.put("order_no:"+orderNumber,JSON.stringify(order));
   const cardText=["🚘 Новая заявка №"+orderNumber,"Модель: "+(f.model||"не указано"),"Бюджет: "+(f.budget||"не указан"),"Страна: "+(f.country||"не указана"),"Тема: "+(f.purpose||"Подбор автомобиля"),"Статус: новая","","Личные данные доступны администратору по кнопке.", "Заявка: " + orderId].join("\n");
   const keyboard={inline_keyboard:[[{text:"✅ Принять в работу",callback_data:"ord:"+orderNumber},{text:"🔐 Данные клиента",callback_data:"ordinfo:"+orderNumber}]]};
   const deliveries=await Promise.all(adminIds.map(async chat_id=>{try{const payload=await callTelegram(env,"sendMessage",{chat_id,text:cardText,reply_markup:keyboard});return Boolean(payload&&payload.ok===true);}catch{return false;}}));
   if(deliveries.some(ok=>!ok))return Response.json({ok:false,error:"Не удалось отправить заявку всем администраторам."},{status:502});
   const botUser=String(env.TELEGRAM_BOT_USERNAME||"").replace(/^@/,"");
   return Response.json({ok:true,orderId,orderNumber,botLink:botUser?"https://t.me/"+botUser+"?start=order_"+orderId:null});
  }
  if (request.method === "GET" && url.pathname === "/api/cars") {
   const cars = [];
   if (env.REVIEWS) {
    let cursor;
    do {
     const page = await env.REVIEWS.list({prefix:"car_approved:", ...(cursor ? {cursor} : {})});
     for (const key of page.keys) { const raw = await env.REVIEWS.get(key.name); if (!raw) continue; const car = JSON.parse(raw); cars.push({id:car.id,caption:car.caption,media:car.fileId ? "/api/car-media/" + car.id : null,sourceUrl:car.sourceUrl || "",publishedAt:car.publishedAt}); }
     cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
   }
   cars.sort((a,b)=>String(b.publishedAt||"").localeCompare(String(a.publishedAt||"")));
   return Response.json({cars},{headers:{"cache-control":"no-store"}});
  }
  const carMediaId = url.pathname.startsWith("/api/car-media/") ? url.pathname.slice("/api/car-media/".length) : "";
  const carMediaMatch = /^car_-?[0-9]+_[0-9]+$/.test(carMediaId) ? [null, carMediaId] : null;
  if (request.method === "GET" && carMediaMatch) {
   if (!env.REVIEWS || !env.TELEGRAM_BOT_TOKEN) return new Response("Not found",{status:404});
   const raw = await env.REVIEWS.get("car_approved:" + carMediaMatch[1]); if (!raw) return new Response("Not found",{status:404});
   const car = JSON.parse(raw); if (!car.fileId) return new Response("Not found",{status:404});
   const info = await callTelegram(env,"getFile",{file_id:car.fileId}).catch(()=>null); const path = info && info.result && info.result.file_path;
   if (!path) return new Response("Not found",{status:404});
   const upstream = await fetch("https://api.telegram.org/file/bot" + env.TELEGRAM_BOT_TOKEN + "/" + path); if (!upstream.ok) return new Response("Bad Gateway",{status:502});
   return new Response(upstream.body,{headers:{"content-type":"image/jpeg","cache-control":"public, max-age=3600","x-content-type-options":"nosniff"}});
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
      reviews.push({id:r.id,kind:r.kind,text:r.text,name:r.name || "Клиент",media:r.fileId ? `/api/review-media/${r.id}` : null});
     }
     cursor = page.list_complete ? null : page.cursor;
    } while (cursor);
   }
   return Response.json({ reviews }, { headers: { "cache-control": "no-store" } });
  }
  const mediaMatch = url.pathname.match(/^\/api\/review-media\/(-?\d+_\d+)$/);
  if (request.method === "GET" && mediaMatch) {
   // Файлы отдаются через Worker: токен бота в браузер не попадает.
   if (!env.REVIEWS || !env.TELEGRAM_BOT_TOKEN) return new Response("Not found", { status: 404 });
   const raw = await env.REVIEWS.get(`approved:${mediaMatch[1]}`);
   if (!raw) return new Response("Not found", { status: 404 });
   const review = JSON.parse(raw);
   const info = await callTelegram(env, "getFile", { file_id: review.fileId }).catch(() => null);
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
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
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
  <div class="reviews" id="reviews-list">
    <article class="card dashed"><div class="review-name" style="margin-top:0">Скоро здесь появятся отзывы</div><p class="review-text">Клиенты, которые уже купили автомобиль через нас, смогут поделиться опытом.</p></article>
  </div>
</section>

<section class="wrap section" id="telegram" style="padding-top:20px">
  <div class="telegram-promo">
    <div><div class="eyebrow">Мы в Telegram</div><h2>Присоединяйтесь к нашему Telegram</h2>
    <p>Следите за новыми автомобилями, свежими предложениями и новостями. Напишите нам напрямую — будем на связи.</p>
    <a class="telegram-promo-link" href="https://t.me/AVTOYKOREABOT" target="_blank" rel="noopener">Открыть бота @AVTOYKOREABOT</a></div>
    <a class="telegram-promo-qr" href="https://t.me/AVTOYKOREABOT" target="_blank" rel="noopener" aria-label="Открыть Telegram-бота по QR-коду">
      <img src="data:image/png;base64,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" alt="QR-код для перехода в Telegram-бот AVTOYKOREABOT">
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
 const data=Object.fromEntries(new FormData(form).entries());
 if(!String(data.name||'').trim()||!String(data.contact||'').trim()){
  showFormStatus('Заполните имя и телефон или Telegram для связи.',true);
  return;
 }
 b.disabled=true;
 b.textContent='Отправляем…';
 showFormStatus('Отправляем заявку администраторам…',false);
 try{
  const r=await fetch('/api/request',{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify(data)});
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
  var list=document.getElementById('reviews-list');
  if(!data.reviews||!data.reviews.length)return;
  list.textContent='';
  data.reviews.forEach(function(rv){
    var card=document.createElement('article');card.className='card';
    if(rv.media){var el=document.createElement(rv.kind==='video'?'video':'img');el.className='review-media';el.src=rv.media;if(rv.kind==='video'){el.controls=true;el.preload='metadata'}else{el.loading='lazy';el.alt='Фото автомобиля'}card.appendChild(el)}
    var who=document.createElement('div');who.className='review-name';who.textContent=rv.name;
    var text=document.createElement('p');text.className='review-text';text.textContent=rv.text||'';
    card.appendChild(who);card.appendChild(text);list.appendChild(card);
  });
}).catch(function(){});
// Каталог показывает только одобренные публикации из Telegram
fetch('/api/cars',{cache:'no-store'}).then(r=>r.json()).then(data=>{
 const list=document.getElementById('cars-list'); if(!list || !data.cars || !data.cars.length)return; list.textContent='';
 data.cars.forEach(car=>{
  const article=document.createElement('article'); article.className='card car-card';
  if(car.media){const img=document.createElement('img');img.className='review-media';img.src=car.media;img.alt='Фотография автомобиля';img.loading='lazy';article.appendChild(img)}
  const body=document.createElement('div');body.className='car-body';
  const title=document.createElement('h3');title.textContent=(car.caption||'Автомобиль из объявления').split('\\n')[0].slice(0,120);
  const desc=document.createElement('div');desc.className='car-specs';desc.style.display='block';desc.style.whiteSpace='pre-line';desc.textContent=car.caption||'Описание не указано';
  body.appendChild(title);body.appendChild(desc);
  if(car.sourceUrl){const a=document.createElement('a');a.className='car-link';a.href=car.sourceUrl;a.target='_blank';a.rel='noopener';a.textContent='Исходная публикация →';body.appendChild(a)}
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
