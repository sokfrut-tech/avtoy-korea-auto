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

// Правило публикации: видео — только с благодарностью в тексте; текстовый отзыв — только с фото автомобиля.
function reviewRuleProblem(review) {
 if (review.kind === "video" && !review.hasThanks) return "нет благодарности в тексте видео-отзыва";
 if (review.kind === "text" && !review.hasPhoto) return "нет фото автомобиля";
 return null;
}

function formatReviewCard(review) {
 const kindLabel = review.kind === "video" ? "видео" : "текст";
 const check = review.kind === "video"
  ? `Благодарность: ${review.hasThanks ? "✅ есть" : "❌ нет"}`
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
    try { await handleReviewCallback(update.callback_query, env, adminIds); } catch { return new Response("Telegram processing failed", { status: 502 }); }
    return Response.json({ ok: true });
   }
   const msg = update.message;
   if (!msg || !msg.chat || !msg.chat.id) return Response.json({ ok: true });
   // Groups/channels: only the one review group, only /review messages. Everything else is ignored.
   if (msg.chat.type !== "private") {
    try { await handleReviewSubmission(msg, env, adminIds); } catch { return new Response("Telegram processing failed", { status: 502 }); }
    return Response.json({ ok: true });
   }
   const chatId = String(msg.chat.id);
   const text = String(msg.text || "").trim();
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
    if (text.startsWith("/reply") && adminIds.includes(chatId)) {
     const match = text.match(/^\/reply\s+(-?\d+)\s+([\s\S]+)$/);
     if (!match) {
      await send(chatId, "Формат ответа: /reply CHAT_ID текст сообщения");
     } else {
      await send(match[1], match[2]);
      await send(chatId, "Ответ отправлен.");
     }
    } else if (text === "/start" || text.startsWith("/start ")) {
     await send(chatId, "Здравствуйте! Это AVTOY KOREA 🚘\n\nПомогаем с подбором автомобилей из Кореи, Китая и ОАЭ.\n\nКоманды:\n/countries — страны покупки\n/catalog — как проходит подбор\n/contact — оставить заявку\n/help — помощь\n\nНапишите, какой автомобиль ищете, и мы передадим запрос менеджеру.");
     if (!adminIds.includes(chatId)) {
      const notice = "👋 Новый пользователь бота AVTOY KOREA\nИмя: " + String((msg.from && (msg.from.first_name || msg.from.username)) || "не указано") + "\nChat ID: " + chatId;
      await Promise.all(adminIds.map(id => send(id, notice)));
     }
    } else if (text === "/help") {
     await send(chatId, "Напишите марку и модель, бюджет и страну покупки. Чтобы обратиться к менеджеру, просто отправьте сообщение сюда. Команда для администратора: /reply CHAT_ID текст сообщения.");
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
   if (env.TELEGRAM_BOT_TOKEN && adminIds.length) {
    const deliveries = await Promise.all(adminIds.map(async chat_id => {
     try {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id,text:message})});
      const payload = await r.json().catch(() => null);
      return r.ok && payload && payload.ok === true;
     } catch {
      return false;
     }
    }));
    if (deliveries.some(ok => !ok)) return Response.json({ok:false,error:"Не удалось отправить заявку всем администраторам."},{status:502});
    return Response.json({ok:true});
   }
   return Response.json({ok:true,telegramText:message,setupNeeded:true});
  }
  if (request.method === "GET" && url.pathname === "/api/reviews") {
   const reviews = [];
   if (env.REVIEWS) {
    const list = await env.REVIEWS.list({ prefix: "approved:" });
    for (const key of list.keys) {
     const raw = await env.REVIEWS.get(key.name);
     if (!raw) continue;
     const r = JSON.parse(raw);
     reviews.push({ id: r.id, kind: r.kind, text: r.text, name: r.name || "Клиент", media: r.fileId ? `/api/review-media/${r.id}` : null });
    }
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
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#08090b"><meta name="description" content="Подбор автомобилей из Кореи, Китая и ОАЭ"><title>AVTOY KOREA — автомобили под заказ</title>
<style>
:root{color-scheme:dark;--bg:#08090b;--panel:#121419;--text:#f7f7f8;--muted:#a3a5ad;--red:#ff4b35;--line:#292c33;--max:1160px}*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:90px}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,"Segoe UI",Arial,sans-serif;line-height:1.55}a{color:inherit;text-decoration:none}button,input,textarea,select{font:inherit}.wrap{width:min(var(--max),calc(100% - 40px));margin:auto}.topbar{position:sticky;top:0;z-index:10;background:#08090beF;backdrop-filter:blur(18px);border-bottom:1px solid #ffffff12}.nav{min-height:82px;display:flex;align-items:center;justify-content:space-between;gap:18px}.brand{font-weight:900;letter-spacing:.16em;font-size:19px;line-height:1.1}.brand em{color:var(--red);font-style:normal}.brand small{display:block;margin-top:7px;color:#a6a8af;font-size:10px;letter-spacing:.27em}.pill,.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;border-radius:15px;padding:14px 20px;font-weight:750;border:1px solid var(--line);cursor:pointer;transition:transform .18s}.pill{border-radius:999px;padding:12px 18px}.btn:hover,.pill:hover{transform:translateY(-2px)}.btn-red{background:var(--red);border-color:var(--red);color:#fff;box-shadow:0 10px 35px #ff4b3520}.btn-dark{background:#0d0e11;color:#fff}.hero{padding:70px 0 48px;overflow:hidden}.hero-grid{display:grid;grid-template-columns:1fr 1.05fr;align-items:center;gap:42px}.eyebrow{font-size:12px;font-weight:850;letter-spacing:.28em;color:var(--red);text-transform:uppercase}.hero h1{font-size:clamp(46px,6.6vw,82px);line-height:.99;letter-spacing:-.065em;margin:22px 0 24px;font-weight:900}.hero h1 span{display:block;color:#85868c}.intro{max-width:520px;font-size:clamp(17px,2vw,21px);color:#b2b4bc;line-height:1.7}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.actions .btn{min-height:58px}.flags{display:flex;gap:8px;margin-bottom:18px}.flag{width:35px;height:35px;border-radius:50%;display:grid;place-items:center;background:#fff;font-size:18px;box-shadow:0 5px 18px #0005}.car-frame{position:relative;overflow:hidden;aspect-ratio:1.12/1;border:1px solid #33363d;border-radius:30px;background:radial-gradient(ellipse at 70% 35%,#56251e,transparent 43%),linear-gradient(135deg,#191b20,#090a0c 65%);box-shadow:0 35px 100px #0008}.car-frame img{width:100%;height:100%;object-fit:cover;display:block;opacity:.92}.car-frame:after{content:"";position:absolute;inset:0;background:linear-gradient(0deg,#08090b 0%,transparent 48%);pointer-events:none}.visual-label{position:absolute;bottom:22px;left:24px;right:24px;display:flex;justify-content:space-between;gap:10px;z-index:1;font-size:11px;letter-spacing:.2em;color:#eee;text-transform:uppercase}.trust{border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:24px 0;margin:0 0 90px}.trust-grid{display:grid;grid-template-columns:repeat(3,1fr);text-align:center}.trust strong{display:block;font-size:24px;line-height:1.2}.trust span{display:block;color:var(--muted);font-size:13px;margin-top:5px}.section{padding:0 0 95px}.section-head{max-width:700px;margin-bottom:30px}.section h2{font-size:clamp(30px,4vw,48px);line-height:1.08;letter-spacing:-.045em;margin:13px 0}.sub{color:var(--muted);font-size:16px}.features{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.feature{background:linear-gradient(145deg,#14161b,#0e0f12);border:1px solid var(--line);border-radius:20px;padding:25px;min-height:190px}.num{color:var(--red);font-weight:900;font-size:12px;letter-spacing:.14em}.ico{width:46px;height:46px;display:grid;place-items:center;border:1px solid #71352e;background:#241411;border-radius:14px;margin:18px 0 12px;color:#ff765f;font-size:24px}.feature h3{font-size:20px;margin:0 0 8px}.feature p,.why-item p,.step p{color:var(--muted);font-size:14px;margin:0}.why{display:grid;grid-template-columns:.8fr 1.2fr;gap:38px;align-items:start}.why-list{display:grid;gap:12px}.why-item{display:grid;grid-template-columns:52px 1fr;gap:16px;padding:22px;background:var(--panel);border:1px solid var(--line);border-radius:18px}.why-item .ico{margin:0}.why-item h3{margin:0 0 6px;font-size:18px}.form-card{display:grid;grid-template-columns:.8fr 1.2fr;gap:36px;background:linear-gradient(140deg,#17191e,#0d0e11);border:1px solid #30333a;border-radius:28px;padding:clamp(22px,4vw,42px)}.form-card h2{font-size:clamp(30px,4vw,44px)}.form-intro,.hint{color:var(--muted)}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.field{display:flex;flex-direction:column;gap:7px}.field.full{grid-column:1/-1}.field label{font-size:12px;color:#c2c3c9}.field input,.field textarea,.field select{width:100%;background:#0b0c0f;border:1px solid #30333a;border-radius:12px;color:#fff;padding:14px;outline:none;min-width:0}.field input:focus,.field textarea:focus,.field select:focus{border-color:var(--red);box-shadow:0 0 0 3px #ff4b351a}.field textarea{min-height:110px;resize:vertical}.form-foot{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:15px}.hint{font-size:11px}.status{font-size:14px;margin-top:12px;min-height:24px}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.step{border:1px solid var(--line);border-radius:18px;padding:23px;background:var(--panel)}.step b{color:var(--red);font-size:12px;letter-spacing:.14em}.step h3{margin:12px 0 8px}footer{border-top:1px solid var(--line);padding:26px 0;color:var(--muted);font-size:13px}.footer-row{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}.telegram:hover{color:var(--red)}.review-media{width:100%;border-radius:14px;margin-top:12px;display:block;background:#0b0c0f}.review-meta{color:var(--muted);font-size:13px;margin-top:10px}
@media(max-width:780px){.wrap{width:calc(100% - 28px)}.nav{min-height:70px}.brand{font-size:15px}.brand small{font-size:8px}.pill{padding:10px 12px;font-size:12px}.hero{padding:42px 0 32px}.hero-grid{grid-template-columns:1fr;gap:28px}.hero h1{font-size:clamp(46px,13vw,72px);margin:18px 0}.intro{font-size:17px}.car-frame{aspect-ratio:1.05/1;border-radius:24px}.trust{margin-bottom:68px;padding:20px 0}.trust strong{font-size:20px}.trust span{font-size:11px}.section{padding-bottom:68px}.features,.why,.form-card,.steps{grid-template-columns:1fr}.feature{min-height:0;padding:20px}.feature .ico{margin:12px 0}.why{gap:20px}.why-item{padding:18px}.form-card{gap:18px;padding:22px;border-radius:22px}.form-grid{grid-template-columns:1fr}.field.full{grid-column:auto}.visual-label{left:16px;right:16px;bottom:16px;font-size:9px}.actions{display:grid;grid-template-columns:1fr 1fr}.actions .btn{padding:13px 10px;font-size:14px}.actions .btn:first-child{grid-column:1/-1}.section h2{font-size:34px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{transition:none!important}}
</style></head><body>
<header class="topbar"><div class="wrap nav"><a class="brand" href="#">AVTO<em>Y</em> KOREA<small>КОРЕЯ · КИТАЙ · ОАЭ</small></a><a class="pill" href="#request">Подобрать автомобиль ↗</a></div></header>
<main><section class="hero"><div class="wrap hero-grid"><div><div class="flags" aria-label="Страны покупки"><span class="flag" title="Южная Корея">🇰🇷</span><span class="flag" title="Китай">🇨🇳</span><span class="flag" title="ОАЭ">🇦🇪</span></div><div class="eyebrow">Автомобили под заказ</div><h1>Автомобиль <span>под заказ</span></h1><p class="intro">Подберём автомобиль под ваш бюджет, проверим перед покупкой и организуем доставку из Кореи, Китая или ОАЭ.</p><div class="actions"><a class="btn btn-red" href="#request">Получить подбор →</a><a class="btn btn-dark telegram" href="https://t.me/avtoYkorea" target="_blank" rel="noopener">✈ Telegram</a></div></div><div class="car-frame"><img src="https://images.unsplash.com/photo-1492144534655-ae79c964c9d7?auto=format&fit=crop&w=1400&q=85" alt="Современный автомобиль" fetchpriority="high"><div class="visual-label"><span>AVTOY KOREA</span><span>Корея / Китай / ОАЭ</span></div></div></div></section>
<div class="wrap trust"><div class="trust-grid"><div><strong>3</strong><span>страны покупки</span></div><div><strong>24/7</strong><span>связь в Telegram</span></div><div><strong>Лично</strong><span>обсудим ваш запрос</span></div></div></div>
<section class="section"><div class="wrap"><div class="section-head"><div class="eyebrow">Почему мы</div><h2>От поиска до доставки</h2><p class="sub">Сопровождаем процесс и помогаем принять взвешенное решение до покупки.</p></div><div class="features"><article class="feature"><div class="num">01 / ПОДБОР</div><div class="ico">⌕</div><h3>Подбор автомобиля</h3><p>Ищем варианты под бюджет, год выпуска, пробег и комплектацию.</p></article><article class="feature"><div class="num">02 / ПРОВЕРКА</div><div class="ico">✓</div><h3>Проверка перед покупкой</h3><p>Помогаем оценить состояние автомобиля и документы до решения.</p></article><article class="feature"><div class="num">03 / ДОСТАВКА</div><div class="ico">↗</div><h3>Организация доставки</h3><p>Координируем покупку и логистику из выбранной страны.</p></article></div></div></section>
<section class="section"><div class="wrap why"><div class="section-head"><div class="eyebrow">Как это работает</div><h2>Понятный путь к вашему автомобилю</h2><p class="sub">Помогаем разобраться во всех этапах покупки за рубежом.</p></div><div class="why-list"><article class="why-item"><div class="ico">01</div><div><h3>Расскажите, что ищете</h3><p>Оставьте заявку с бюджетом, желаемой моделью и предпочтениями.</p></div></article><article class="why-item"><div class="ico">02</div><div><h3>Получите варианты</h3><p>Согласуем подходящие автомобили и обсудим проверку.</p></div></article><article class="why-item"><div class="ico">03</div><div><h3>Согласуйте покупку и доставку</h3><p>Обсудим условия до принятия решения.</p></div></article></div></div></section>
<section class="section" id="request"><div class="wrap form-card"><div><div class="eyebrow">Бесплатный подбор</div><h2>Какой автомобиль вы ищете?</h2><p class="form-intro">Оставьте параметры автомобиля и удобный контакт. Мы свяжемся с вами, уточним детали и обсудим варианты сотрудничества.</p><p class="hint">Можно обратиться и по вопросам рекламы, партнёрства или размещения предложений.</p></div><div><form id="request-form"><div class="form-grid">
<div class="field"><label for="name">Ваше имя *</label><input id="name" name="name" required maxlength="100" autocomplete="name" placeholder="Как к вам обращаться"></div><div class="field"><label for="contact">Telegram или телефон *</label><input id="contact" name="contact" required maxlength="150" autocomplete="tel" placeholder="@username или номер"></div>
<div class="field"><label for="model">Марка / модель</label><input id="model" name="model" maxlength="150" placeholder="Например, Kia Sorento"></div><div class="field"><label for="budget">Бюджет</label><input id="budget" name="budget" maxlength="100" placeholder="Например, 3 000 000 ₽"></div>
<div class="field"><label for="country">Страна покупки</label><select id="country" name="country"><option value="">Пока не решил(а)</option><option>Южная Корея</option><option>Китай</option><option>ОАЭ</option></select></div><div class="field"><label for="year">Год выпуска от</label><input id="year" name="year" maxlength="30" placeholder="Например, 2021"></div>
<div class="field full"><label for="purpose">Тема обращения</label><select id="purpose" name="purpose"><option value="Подбор автомобиля">Подбор автомобиля</option><option value="Реклама и продвижение">Реклама и продвижение</option><option value="Партнёрство">Партнёрство</option><option value="Другое">Другое</option></select></div>
<div class="field full"><label for="details">Пожелания</label><textarea id="details" name="details" maxlength="1000" placeholder="Комплектация, пробег, тип двигателя и другое"></textarea></div></div><div class="form-foot"><button class="btn btn-red" type="submit" id="submit-btn">Подготовить заявку →</button><span class="hint">Оставляя заявку, вы соглашаетесь на обратную связь по вашему обращению.</span></div><div class="status" id="status" role="status" aria-live="polite"></div></form></div></div></section>
<section class="section"><div class="wrap"><div class="section-head"><div class="eyebrow">Прозрачный процесс</div><h2>Три простых шага</h2></div><div class="steps"><div class="step"><b>ШАГ 01</b><h3>Заявка</h3><p>Расскажите о бюджете и желаемом автомобиле.</p></div><div class="step"><b>ШАГ 02</b><h3>Обсуждение</h3><p>Уточним параметры и согласуем варианты.</p></div><div class="step"><b>ШАГ 03</b><h3>План покупки</h3><p>Обсудим проверку, условия и доставку.</p></div></div></div></section>
<section class="section" id="reviews"><div class="wrap"><div class="section-head"><div class="eyebrow">Отзывы</div><h2>Что говорят клиенты</h2><p class="sub">Публикуем отзывы только с согласия клиентов.</p></div><div class="features" id="reviews-list"><p class="sub">Отзывы скоро появятся.</p></div></div></section></main>
<footer><div class="wrap footer-row"><a class="brand" href="#">AVTO<em>Y</em> KOREA</a><span>Автомобили под заказ · Корея · Китай · ОАЭ</span><a class="telegram" href="https://t.me/avtoYkorea" target="_blank" rel="noopener">Telegram ↗</a></div></footer>
<script>
const form=document.getElementById('request-form'),statusEl=document.getElementById('status');
form.addEventListener('submit',async e=>{e.preventDefault();const b=document.getElementById('submit-btn');b.disabled=true;statusEl.textContent='Готовим заявку…';try{const r=await fetch('/api/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form).entries()))});const x=await r.json();if(!r.ok||!x.ok)throw Error(x.error||'Не удалось подготовить заявку.');if(x.setupNeeded){statusEl.textContent='Заявка подготовлена. Откроется Telegram: выберите чат менеджера и отправьте сообщение.';location.href='https://t.me/share/url?url='+encodeURIComponent(location.origin)+'&text='+encodeURIComponent(x.telegramText)}else{statusEl.textContent='Заявка отправлена. Спасибо!';form.reset()}}catch(err){statusEl.textContent=err.message||'Ошибка. Попробуйте ещё раз.'}finally{b.disabled=false}});
fetch('/api/reviews',{cache:'no-store'}).then(function(r){return r.json()}).then(function(data){var list=document.getElementById('reviews-list');if(!data.reviews||!data.reviews.length)return;list.textContent='';data.reviews.forEach(function(rv){var card=document.createElement('article');card.className='feature';var who=document.createElement('div');who.className='num';who.textContent=rv.name;var text=document.createElement('p');text.textContent=rv.text||'';card.appendChild(who);card.appendChild(text);if(rv.media){var el=document.createElement(rv.kind==='video'?'video':'img');el.className='review-media';el.src=rv.media;if(rv.kind==='video'){el.controls=true;el.preload='metadata'}else{el.loading='lazy';el.alt='Фото автомобиля'}card.appendChild(el)}list.appendChild(card)})}).catch(function(){});
</script></body></html>`;
  return new Response(html,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","referrer-policy":"strict-origin-when-cross-origin"}});
 }
};
