import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMaxAdapter } from './channels/max-adapter.mjs';
import { authenticateOperator, operatorCan, parseOperatorConfig, operatorPermissions } from './security/operator-auth.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const MAX_BODY = 12_000;
const MAX_INBOX = 10_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
const MIME = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.svg':'image/svg+xml', '.mp4':'video/mp4', '.ico':'image/x-icon' };

function json(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer', ...headers });
  res.end(JSON.stringify(value));
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
}
async function readJson(req, limit = MAX_BODY) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > limit) throw Object.assign(new Error('BODY_TOO_LARGE'), { status:413 });
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('BODY_TOO_LARGE'), { status:413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('BAD_JSON'), { status:400 }); }
}
function cleanText(value, max) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function validateEnquiry(input) {
  const name = cleanText(input.name, 100);
  const contact = cleanText(input.contact, 160);
  const model = cleanText(input.model, 180);
  const comment = cleanText(input.comment, 1500);
  if (!name || !contact || (!model && !comment)) return { error:'Укажите имя, контакт и автомобиль или комментарий.' };
  if (/[<>]/.test(name + contact + model + comment)) return { error:'Проверьте введённые данные.' };
  return { value:{ name, contact, model, comment } };
}

export function assertDurableAdminRuntime({ operatorsConfigured = false, maxWebhookConfigured = false, requestStore = null } = {}) {
  if (!operatorsConfigured && !maxWebhookConfigured) return true;
  if (!requestStore || typeof requestStore.ensureMaxWebhookSchema !== 'function' || typeof requestStore.verifySchema !== 'function') {
    throw new Error('Per-operator administration and MAX webhook require a durable YDB request store');
  }
  const enquiryCapabilities = ['createEnquiry','getEnquiry','claimEnquiry','claimDueEnquiries','listPrivateEnquiries','completeDelivery'];
  const missingEnquiryCapabilities = enquiryCapabilities.filter(name => typeof requestStore[name] !== 'function');
  if (missingEnquiryCapabilities.length) {
    throw new Error('Russian standby requires durable enquiry persistence and delivery queue capabilities: ' + missingEnquiryCapabilities.join(', '));
  }
  if (maxWebhookConfigured && typeof requestStore.recordMaxWebhookEvent !== 'function') {
    throw new Error('MAX webhook requires durable idempotent webhook receipt storage');
  }
  if (operatorsConfigured) {
    const operatorCapabilities = ['ensureOperatorAuditSchema','consumeOperatorAuthFailure','recordOperatorAuditEvent','listOperatorAuditEvents','listPrivateEnquiries'];
    const missingOperatorCapabilities = operatorCapabilities.filter(name => typeof requestStore[name] !== 'function');
    if (missingOperatorCapabilities.length) {
      throw new Error('Per-operator administration requires durable YDB audit, rate-limit and inbox capabilities: ' + missingOperatorCapabilities.join(', '));
    }
  }
  return true;
}

export function createStandbyApp({ dataDir = path.join(ROOT, 'data'), publicDir = PUBLIC, env = process.env, fetchImpl = fetch, clock = () => Date.now(), inboxStore = null, requestStore = null, maxEventStore = requestStore, auditStore = requestStore, telegramTimeoutMs = 15_000, maxTimeoutMs = 10_000 } = {}) {
  const inboxFile = path.join(dataDir, 'inbox.json');
  const snapshotFile = path.join(dataDir, 'public-snapshot.json');
  let writeChain = Promise.resolve();
  const rate = new Map();
  const maxAdapter = createMaxAdapter({ token:env.MAX_BOT_TOKEN, operatorChatId:env.MAX_OPERATOR_CHAT_ID, fetchImpl, timeoutMs:maxTimeoutMs });
  const operatorConfig = env.STANDBY_OPERATORS_JSON ? parseOperatorConfig(env.STANDBY_OPERATORS_JSON) : null;
  function authorizeOperator(req, permission) {
    if (operatorConfig) {
      const actor = authenticateOperator(req.headers.authorization, operatorConfig);
      if (!actor) return { error:'unauthorized' };
      if (!operatorCan(actor, permission)) return { error:'forbidden', actor };
      return { actor, legacy:false };
    }
    const legacyToken = env.NODE_ENV === 'test' && env.STANDBY_ADMIN_TOKEN;
    if (legacyToken && safeEqual(req.headers.authorization?.replace(/^Bearer\s+/i,''), legacyToken)) return { actor:{ id:'legacy-local-admin', role:'owner' }, legacy:true };
    return { error:'unauthorized' };
  }
  const authFailures = new Map();
  async function recordAuthDenial(req, route, actor = null) {
    const forwarded = env.TRUST_PROXY === 'true' ? req.headers['x-forwarded-for'] : '';
    const ip = String(forwarded || req.socket.remoteAddress || 'unknown').split(',')[0].trim().slice(0,128) || 'unknown';
    const now = clock();
    const rateKey = createHash('sha256').update(ip).digest('hex');
    if (auditStore && typeof auditStore.consumeOperatorAuthFailure === 'function') {
      try {
        const result = await auditStore.consumeOperatorAuthFailure({ keyDigest:rateKey, now, windowMs:10 * 60_000, maxFailures:10 });
        if (!result.allowed) return false;
      } catch {
        // Fail closed if the shared rate-limit store is unavailable.
        return false;
      }
    } else {
      const recent = (authFailures.get(rateKey) || []).filter(time => time > now - 10 * 60_000);
      if (recent.length >= 10) return false;
      recent.push(now); authFailures.set(rateKey,recent);
      if (authFailures.size > 10_000) authFailures.delete(authFailures.keys().next().value);
    }
    if (auditStore && typeof auditStore.recordOperatorAuditEvent === 'function') {
      try {
        await auditStore.recordOperatorAuditEvent({ eventId:randomUUID(), occurredAt:new Date(now).toISOString(), actorId:actor?.id || 'unauthenticated', actorRole:actor?.role || 'viewer', action:actor ? 'auth.forbidden' : 'auth.denied', targetType:'ops', targetId:route, outcome:'denied', metadata:{ reason:actor ? 'insufficient_role' : 'invalid_credentials' } });
      } catch { /* Denial remains a denial even if audit storage is unavailable. */ }
    }
    return true;
  }
  async function auditOperatorAction(actor, action, targetType, targetId, metadata = {}) {
    if (!auditStore || typeof auditStore.recordOperatorAuditEvent !== 'function') throw new Error('Durable operator audit store is unavailable');
    await auditStore.recordOperatorAuditEvent({ eventId:randomUUID(), occurredAt:new Date(clock()).toISOString(), actorId:actor.id, actorRole:actor.role, action, targetType, targetId, outcome:'accepted', metadata });
  }
  const enqueueWrite = (operation) => { const next = writeChain.then(operation); writeChain = next.catch(() => {}); return next; };
  async function readInbox() {
    if (inboxStore) return inboxStore.readInbox();
    try { const parsed = JSON.parse(await fs.readFile(inboxFile, 'utf8')); return Array.isArray(parsed) ? parsed : []; }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  }
  async function writeInbox(items) {
    await fs.mkdir(dataDir, { recursive:true });
    const temp = inboxFile + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temp, JSON.stringify(items, null, 2), { mode:0o600 });
    await fs.rename(temp, inboxFile);
  }
  async function mutateInbox(mutator) {
    if (inboxStore) {
      return inboxStore.transactInbox(async (items) => {
        const result = await mutator(items);
        return { items, result };
      });
    }
    return enqueueWrite(async () => {
      const items = await readInbox();
      const result = await mutator(items);
      await writeInbox(items);
      return result;
    });
  }
  async function readSnapshot() {
    try {
      const data = JSON.parse(await fs.readFile(snapshotFile, 'utf8'));
      return { cars:Array.isArray(data.cars) ? data.cars.filter(c => c && c.id && c.caption && Array.isArray(c.mediaItems)) : [], reviews:Array.isArray(data.reviews) ? data.reviews.filter(r => r && r.id && r.text && Array.isArray(r.mediaItems)) : [], updatedAt:data.updatedAt || null };
    } catch (e) { if (e.code === 'ENOENT') return { cars:[], reviews:[], updatedAt:null }; throw e; }
  }
  async function deliver(item) {
    const token = env.TELEGRAM_BOT_TOKEN;
    const admins = [...new Set(String(env.TELEGRAM_ADMIN_IDS || '').split(/[\s,]+/).filter(x => /^\d+$/.test(x) && Number(x) > 0))];
    const alreadySent = new Set((item.deliveredAdminIds || []).filter(id => /^\d+$/.test(String(id))));
    const pendingAdmins = token ? admins.filter(id => !alreadySent.has(id)) : [];
    const text = [
      `Новая заявка с резервного сайта №${item.id.slice(0,8)}`,
      `Имя: ${item.name}`, `Контакт: ${item.contact}`,
      item.model ? `Автомобиль: ${item.model}` : '', item.comment ? `Комментарий: ${item.comment}` : '',
      `ID заявки: ${item.id}`
    ].filter(Boolean).join('\n');

    const telegramResults = await Promise.all(pendingAdmins.map(async chat_id => {
      try {
        const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify({ chat_id, text }),
          signal:AbortSignal.timeout(telegramTimeoutMs)
        });
        const body = await response.json().catch(() => ({}));
        return response.ok && body.ok === true ? chat_id : null;
      } catch { return null; }
    }));
    const deliveredAdminIds = [...alreadySent, ...telegramResults.filter(Boolean)];
    const telegramComplete = admins.length > 0 && admins.every(id => deliveredAdminIds.includes(id));
    if (telegramComplete) return { delivered:true, deliveredAdminIds:[...deliveredAdminIds, 'operators'], reason:null };

    // MAX is the failover destination: it receives only a privacy-safe summary,
    // and the adapter can send only to MAX_OPERATOR_CHAT_ID from server config.
    const maxResult = await maxAdapter.sendOperatorNotification(item);
    if (maxResult.ok) return { delivered:true, deliveredAdminIds:[...deliveredAdminIds, 'operators'], reason:null };

    const configured = admins.length > 0 || maxAdapter.configured;
    return {
      delivered:false,
      deliveredAdminIds,
      reason:configured ? 'notification_delivery_failed' : 'notification_channels_not_configured'
    };
  }
  async function receiveMaxWebhook(req, res) {
    if (!/^[A-Za-z0-9_-]{5,256}$/.test(String(env.MAX_WEBHOOK_SECRET || '')) || ! /^-?\d{1,20}$/.test(String(env.MAX_OPERATOR_CHAT_ID || ''))) return json(res,503,{ ok:false,error:'MAX webhook is not configured.' });
    const allowedOperatorIds = new Set(String(env.MAX_OPERATOR_USER_IDS || '').split(/[\s,]+/).filter(id => /^-?\d{1,20}$/.test(id)));
    if (!allowedOperatorIds.size) return json(res,503,{ ok:false,error:'MAX operator allowlist is not configured.' });
    if (!safeEqual(req.headers['x-max-bot-api-secret'],env.MAX_WEBHOOK_SECRET)) return json(res,401,{ ok:false,error:'Unauthorized' });
    if (!maxEventStore || typeof maxEventStore.recordMaxWebhookEvent !== 'function') return json(res,503,{ ok:false,error:'Durable MAX event storage is unavailable.' });
    let update;
    try { update = await readJson(req,64_000); }
    catch (error) { return json(res,error.status || 400,{ ok:false,error:error.status === 413 ? 'Webhook payload too large.' : 'Invalid JSON.' }); }
    const type = cleanText(update?.update_type,64);
    const timestamp = Number(update?.timestamp);
    const message = update?.message;
    const recipient = message?.recipient || update?.callback?.message?.recipient || {};
    const chatId = update?.chat_id ?? recipient.chat_id;
    const chatType = recipient.chat_type || (update?.chat_id != null ? 'chat' : '');
    if (!['message_created','message_callback'].includes(type) || !Number.isSafeInteger(timestamp) || timestamp <= 0) return json(res,400,{ ok:false,error:'Unsupported or malformed MAX update.' });
    if (String(chatId ?? '') !== String(env.MAX_OPERATOR_CHAT_ID) || chatType !== 'chat') return json(res,403,{ ok:false,error:'Event is outside the configured operator group.' });
    if (type === 'message_created' && message?.sender?.is_bot === true) return json(res,200,{ ok:true,ignored:true });
    const messageId = cleanText(message?.body?.mid || message?.mid || '',160);
    const senderValue = type === 'message_callback' ? update?.callback?.user?.user_id : message?.sender?.user_id;
    const senderId = cleanText(senderValue ?? '',80);
    if (!senderId || !allowedOperatorIds.has(senderId)) return json(res,403,{ ok:false,error:'Sender is not an authorized operator.' });
    const digest = createHash('sha256').update(JSON.stringify(update)).digest('hex');
    try {
      const result = await maxEventStore.recordMaxWebhookEvent({ digest,eventType:type,eventTimestamp:timestamp,chatId:String(chatId),messageId:messageId || null,senderUserId:senderId || null });
      return json(res,200,{ ok:true,duplicate:Boolean(result?.duplicate) });
    } catch {
      return json(res,503,{ ok:false,error:'Could not persist MAX event.' });
    }
  }
  async function submitEnquiry(req, res) {
    const forwarded = env.TRUST_PROXY === 'true' ? req.headers['x-forwarded-for'] : '';
    const ip = String(forwarded || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const now = clock(); const windowStart = now - 10 * 60_000;
    const attempts = (rate.get(ip) || []).filter(t => t > windowStart);
    if (attempts.length >= 5) return json(res,429,{ ok:false, error:'Слишком много заявок. Попробуйте позже.' });
    attempts.push(now); rate.set(ip, attempts);
    let input;
    try { input = await readJson(req); } catch (e) { return json(res,e.status || 400,{ ok:false,error:e.status === 413 ? 'Слишком большой запрос.' : 'Некорректные данные.' }); }
    if (input.website) return json(res,200,{ ok:true }); // honeypot
    const checked = validateEnquiry(input);
    if (checked.error) return json(res,422,{ ok:false,error:checked.error });
    const idem = cleanText(req.headers['idempotency-key'] || input.idempotencyKey, 100);
    if (idem && !/^[a-zA-Z0-9._:-]{8,100}$/.test(idem)) return json(res,400,{ ok:false,error:'Некорректный ключ заявки.' });
    if (requestStore) {
      let outcome;
      try { outcome = await requestStore.createEnquiry(checked.value, idem || null); }
      catch { return json(res,503,{ ok:false,error:'Не удалось сохранить заявку. Попробуйте позже.' }); }
      if (!outcome.duplicate && outcome.item.status !== 'delivered') await attemptDelivery(outcome.item.id);
      const current = await requestStore.getEnquiry(outcome.item.id) || outcome.item;
      return json(res,202,{ ok:true, requestId:current.id, delivery:current.status === 'delivered' ? 'sent' : 'queued', message:current.status === 'delivered' ? 'Заявка отправлена. Спасибо!' : 'Заявка сохранена. Отправим её администратору при восстановлении связи.' });
    }
    const requestId = randomUUID();
    let outcome;
    try {
      outcome = await mutateInbox((inbox) => {
      const existing = idem ? inbox.find(x => x.idempotencyKey === idem) : null;
      if (existing) return { item:existing, duplicate:true };
      if (inbox.length >= MAX_INBOX) return { full:true };
      const item = { id:requestId, idempotencyKey:idem || null, ...checked.value, createdAt:new Date(now).toISOString(), status:'queued', attempts:0, nextAttemptAt:now, lastError:null };
      inbox.push(item);
      return { item, duplicate:false };
      });
    } catch (error) {
      if (error?.code === 'INBOX_CAPACITY') return json(res,503,{ ok:false,error:'Очередь заявок временно заполнена. Попробуйте позже.' });
      throw error;
    }
    if (outcome.full) return json(res,503,{ ok:false,error:'Очередь заявок временно заполнена. Попробуйте позже.' });
    if (!outcome.duplicate && outcome.item.status !== 'delivered') await attemptDelivery(outcome.item.id);
    const current = (await readInbox()).find(x => x.id === outcome.item.id) || outcome.item;
    return json(res,202,{ ok:true, requestId:current.id, delivery:current.status === 'delivered' ? 'sent' : 'queued', message:current.status === 'delivered' ? 'Заявка отправлена. Спасибо!' : 'Заявка сохранена. Отправим её администратору при восстановлении связи.' });
  }
  async function attemptDelivery(id) {
    // Claim in a short DB transaction; never hold a transaction during Telegram HTTP calls.
    const claimTime = clock();
    if (requestStore) {
      const claimed = await requestStore.claimEnquiry(id, { now: claimTime, leaseMs: 120_000 });
      if (!claimed) return requestStore.getEnquiry(id);
      const result = await deliver(claimed);
      return requestStore.completeDelivery({ requestId:id, leaseToken:claimed.leaseToken, deliveredAdminIds:result.deliveredAdminIds || [], requiredAdminIds:['operators'], error:result.reason, now:clock(), retryBaseMs:RETRY_BASE_MS, retryMaxMs:RETRY_MAX_MS });
    }
    const claimed = await mutateInbox((inbox) => {
      const item = inbox.find(x => x.id === id);
      if (!item || item.status === 'delivered') return null;
      if (item.status === 'sending' && Number(item.lockUntil || 0) > claimTime) return null;
      if (item.status === 'queued' && Number(item.nextAttemptAt || 0) > claimTime) return null;
      item.status = 'sending';
      item.lockUntil = claimTime + 120_000;
      return structuredClone(item);
    });
    if (!claimed) return (await readInbox()).find(x => x.id === id) || null;
    const result = await deliver(claimed);
    const completedAt = clock();
    return mutateInbox((inbox) => {
      const item = inbox.find(x => x.id === id);
      if (!item || item.status === 'delivered') return item || null;
      item.attempts = Number(item.attempts || 0) + 1;
      item.lastAttemptAt = new Date(completedAt).toISOString();
      item.deliveredAdminIds = [...new Set([...(item.deliveredAdminIds || []), ...(result.deliveredAdminIds || [])])];
      delete item.lockUntil;
      if (result.delivered) {
        item.status = 'delivered';
        item.deliveredAt = new Date(completedAt).toISOString();
        item.lastError = null;
      } else {
        item.status = 'queued';
        item.lastError = result.reason || 'telegram_delivery_failed';
        item.nextAttemptAt = completedAt + Math.min(RETRY_BASE_MS * (2 ** Math.min(item.attempts - 1, 8)), RETRY_MAX_MS);
      }
      return structuredClone(item);
    });
  }
  async function retryDue() {
    if (requestStore) {
      const claims = await requestStore.claimDueEnquiries({ now:clock(), limit:50, leaseMs:120_000 });
      const results = [];
      for (const claimed of claims) {
        const result = await deliver(claimed);
        const updated = await requestStore.completeDelivery({ requestId:claimed.id, leaseToken:claimed.leaseToken, deliveredAdminIds:result.deliveredAdminIds || [], requiredAdminIds:['operators'], error:result.reason, now:clock(), retryBaseMs:RETRY_BASE_MS, retryMaxMs:RETRY_MAX_MS });
        results.push({ id:claimed.id, status:updated?.status || 'unknown' });
      }
      return results;
    }
    const inbox = await readInbox();
    const due = inbox.filter(item => (item.status === 'queued' && Number(item.nextAttemptAt || 0) <= clock()) || (item.status === 'sending' && Number(item.lockUntil || 0) <= clock())).slice(0, 50);
    const results = [];
    for (const item of due) {
      const updated = await attemptDelivery(item.id);
      results.push({ id: item.id, status: updated?.status || 'unknown' });
    }
    return results;
  }
  async function handle(req, res) {
    const url = new URL(req.url, 'http://standby.local');
    if (req.method === 'GET' && url.pathname === '/healthz') return json(res,200,{ ok:true, service:'avtoy-korea-standby' });
    if (req.method === 'GET' && url.pathname === '/api/cars') {
      try { const snapshot = await readSnapshot(); return json(res,200,{ cars:snapshot.cars, updatedAt:snapshot.updatedAt }); }
      catch { return json(res,500,{ error:'Каталог временно недоступен.' }); }
    }
    if (req.method === 'GET' && url.pathname === '/api/reviews') {
      try { const snapshot = await readSnapshot(); return json(res,200,{ reviews:snapshot.reviews, updatedAt:snapshot.updatedAt }); }
      catch { return json(res,500,{ error:'Отзывы временно недоступны.' }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/request') return submitEnquiry(req,res);
    if (req.method === 'POST' && url.pathname === '/api/max/webhook') return receiveMaxWebhook(req,res);
    if (req.method === 'GET' && url.pathname === '/robots.txt') {
      res.writeHead(200,{ 'content-type':'text/plain; charset=utf-8' }); return res.end('User-agent: *\nAllow: /\nDisallow: /ops/\nSitemap: /sitemap.xml\n');
    }
    if (req.method === 'GET' && url.pathname === '/sitemap.xml') {
      const snap = await readSnapshot(); const base = (env.PUBLIC_BASE_URL || '').replace(/\/$/,'');
      const urls = snap.cars.map(c => `<url><loc>${escapeXml(base)}/cars/${encodeURIComponent(c.id)}</loc></url>`).join('');
      res.writeHead(200,{ 'content-type':'application/xml; charset=utf-8' }); return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escapeXml(base)}/</loc></url>${urls}</urlset>`);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/cars/')) {
      const id = decodeURIComponent(url.pathname.slice(6)); const snap = await readSnapshot(); const car = snap.cars.find(c => c.id === id);
      if (!car) return sendFile(res,path.join(publicDir,'index.html'));
      const title = escapeHtml(cleanText(car.caption,160) || 'Автомобиль');
      const description = escapeHtml(cleanText(car.description || car.caption,240));
      const photo = Array.isArray(car.mediaItems) ? car.mediaItems.find(m => m && m.type === 'photo' && typeof m.url === 'string' && m.url.startsWith('/media/') && !m.url.includes('..')) : null;
      const image = photo ? `<img src="${escapeHtml(photo.url)}" alt="${title}" style="display:block;width:min(100%,900px);max-height:65vh;object-fit:contain;background:#0b0e14;border-radius:16px">` : '';
      const page = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="${description}"><title>${title} — AVTOY KOREA</title></head><body style="margin:0;padding:24px;background:#090b10;color:#f5f7fb;font:16px/1.6 system-ui,sans-serif"><main style="max-width:960px;margin:auto"><p><a href="/" style="color:#ff8b7f">← В каталог AVTOY KOREA</a></p><h1>${title}</h1>${image}<p>${description}</p><p><a href="/#request" style="display:inline-block;padding:12px 18px;background:#e84b3c;border-radius:10px;color:white;text-decoration:none">Оставить заявку</a></p></main></body></html>`;
      res.writeHead(200,{ 'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','content-security-policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" }); return res.end(page);
    }
    if (req.method === 'GET' && url.pathname === '/ops') return sendFile(res,path.join(publicDir,'ops.html'),{ cacheControl:'no-store, max-age=0' });
    if (req.method === 'GET' && url.pathname === '/ops/audit') {
      const auth = authorizeOperator(req,'audit:read');
      if (auth.error === 'unauthorized') return await recordAuthDenial(req,'audit') ? json(res,401,{ error:'Unauthorized' }) : json(res,429,{ error:'Too many failed attempts.' });
      if (auth.error === 'forbidden') { await recordAuthDenial(req,'audit',auth.actor); return json(res,403,{ error:'Forbidden' }); }
      if (!auth.legacy) {
        try { await auditOperatorAction(auth.actor,'audit.read','audit','recent'); }
        catch { return json(res,503,{ error:'Operator audit storage is unavailable.' }); }
      }
      if (!auditStore || typeof auditStore.listOperatorAuditEvents !== 'function') return json(res,503,{ error:'Operator audit listing is unavailable.' });
      try {
        const events = await auditStore.listOperatorAuditEvents({ limit:100 });
        return json(res,200,{ operator:auth.actor, events });
      } catch { return json(res,503,{ error:'Operator audit listing is unavailable.' }); }
    }
    if (req.method === 'GET' && url.pathname === '/ops/inbox') {
      const auth = authorizeOperator(req,'inbox:read');
      if (auth.error === 'unauthorized') return await recordAuthDenial(req,'inbox') ? json(res,401,{ error:'Unauthorized' }) : json(res,429,{ error:'Too many failed attempts.' });
      if (auth.error === 'forbidden') { await recordAuthDenial(req,'inbox',auth.actor); return json(res,403,{ error:'Forbidden' }); }
      if (!auth.legacy) {
        try { await auditOperatorAction(auth.actor,'inbox.read','inbox','all'); }
        catch { return json(res,503,{ error:'Operator audit storage is unavailable.' }); }
      }
      if (requestStore) {
        const items = await requestStore.listPrivateEnquiries({ limit:100 });
        return json(res,200,{ operator:auth.actor, permissions:operatorPermissions(auth.actor.role), items:items.map(({id,name,contact,model,comment,createdAt,status,attempts,lastError})=>({id,name,contact,model,comment,createdAt,status,attempts,lastError})) });
      }
      const inbox = await readInbox();
      return json(res,200,{ operator:auth.actor, permissions:operatorPermissions(auth.actor.role), items:inbox.map(({id,name,contact,model,comment,createdAt,status,attempts,lastError})=>({id,name,contact,model,comment,createdAt,status,attempts,lastError})) });
    }
    if (req.method === 'POST' && url.pathname === '/ops/retry') {
      const auth = authorizeOperator(req,'notifications:retry');
      if (auth.error === 'unauthorized') return await recordAuthDenial(req,'retry') ? json(res,401,{ error:'Unauthorized' }) : json(res,429,{ error:'Too many failed attempts.' });
      if (auth.error === 'forbidden') { await recordAuthDenial(req,'retry',auth.actor); return json(res,403,{ error:'Forbidden' }); }
      if (!auth.legacy) {
        try { await auditOperatorAction(auth.actor,'notifications.retry','queue','due'); }
        catch { return json(res,503,{ error:'Operator audit storage is unavailable.' }); }
      }
      const results = await retryDue();
      return json(res,200,{ operator:auth.actor, processed:results.length,results });
    }
    if (req.method === 'GET') {
      const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const resolved = path.resolve(publicDir,relative);
      if (resolved !== publicDir && !resolved.startsWith(path.resolve(publicDir) + path.sep)) return json(res,400,{ error:'Bad path' });
      return sendFile(res,resolved);
    }
    return json(res,404,{ error:'Not found' });
  }
  async function sendFile(res,file,{ cacheControl = 'no-cache' } = {}) {
    try { const data = await fs.readFile(file); res.writeHead(200,{ 'content-type':MIME[path.extname(file).toLowerCase()] || 'application/octet-stream','x-content-type-options':'nosniff','cache-control':cacheControl,'referrer-policy':'no-referrer','cross-origin-resource-policy':'same-origin','permissions-policy':'camera=(), microphone=(), geolocation=()','x-frame-options':'DENY','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" }); res.end(data); }
    catch { json(res,404,{ error:'Not found' }); }
  }
  const handler = async (req,res) => { try { await handle(req,res); } catch { if (!res.headersSent) json(res,500,{ error:'Внутренняя ошибка резервного сайта.' }); else res.destroy(); } };
  handler.retryDue = retryDue;
  return handler;
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeXml(value) { return escapeHtml(value); }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  let driver;
  let server;
  let retryTimer;
  const shutdown = async () => {
    if (retryTimer) clearInterval(retryTimer);
    if (server) await new Promise(resolve => server.close(resolve));
    if (driver) await driver.close();
  };
  try {
    let inboxStore = null;
    let requestStore = null;
    if (process.env.INBOX_STORE === 'v2' && !process.env.YDB_CONNECTION_STRING) {
      throw new Error('INBOX_STORE=v2 requires YDB_CONNECTION_STRING; refusing local inbox fallback');
    }
    if (process.env.YDB_CONNECTION_STRING && process.env.INBOX_STORE === 'v2') {
      const schemaManagedExternally = process.env.YDB_SCHEMA_MANAGED_EXTERNALLY === 'true';
      if (process.env.NODE_ENV === 'production' && !schemaManagedExternally) {
        throw new Error('Production YDB requires YDB_SCHEMA_MANAGED_EXTERNALLY=true; apply the reviewed schema migration with a separate privileged identity first');
      }
      const [{ Driver }, { query }, { MetadataCredentialsProvider }, { createYdbRequestStore }] = await Promise.all([
        import('@ydbjs/core'), import('@ydbjs/query'), import('@ydbjs/auth/metadata'), import('./storage/ydb-request-store.mjs')
      ]);
      driver = new Driver(process.env.YDB_CONNECTION_STRING, { credentialsProvider:new MetadataCredentialsProvider() });
      await driver.ready();
      requestStore = createYdbRequestStore({ sql:query(driver), schemaManagedExternally });
      if (schemaManagedExternally) await requestStore.verifySchema();
      else await requestStore.ensureMaxWebhookSchema();
      process.stdout.write('YDB request-oriented inbox v2 enabled\\n');
    } else if (process.env.YDB_CONNECTION_STRING) {
      const [{ Driver }, { query }, { MetadataCredentialsProvider }, { createYdbInboxStore }] = await Promise.all([
        import('@ydbjs/core'), import('@ydbjs/query'), import('@ydbjs/auth/metadata'), import('./storage/ydb-inbox-store.mjs')
      ]);
      driver = new Driver(process.env.YDB_CONNECTION_STRING, {
        credentialsProvider: new MetadataCredentialsProvider()
      });
      await driver.ready();
      inboxStore = createYdbInboxStore({ sql: query(driver) });
      await inboxStore.ensureSchema();
      process.stdout.write('YDB inbox storage enabled\n');
    }
    assertDurableAdminRuntime({
      operatorsConfigured:Boolean(process.env.STANDBY_OPERATORS_JSON),
      maxWebhookConfigured:Boolean(process.env.MAX_WEBHOOK_SECRET),
      requestStore
    });
    if (process.env.STANDBY_OPERATORS_JSON) {
      await requestStore.ensureOperatorAuditSchema();
      process.stdout.write('YDB operator audit storage enabled\\n');
    }
    const app = createStandbyApp({ inboxStore, requestStore });
    server = http.createServer(app);
    retryTimer = setInterval(() => { app.retryDue().catch(error => process.stderr.write('Retry cycle failed: ' + error.message + '\n')); }, 30_000);
    retryTimer.unref();
    server.listen(port,'0.0.0.0',()=>process.stdout.write('AVTOY KOREA standby listening on ' + port + '\n'));
    process.once('SIGINT', () => shutdown().finally(() => process.exit(0)));
    process.once('SIGTERM', () => shutdown().finally(() => process.exit(0)));
  } catch (error) {
    process.stderr.write('Startup failed: ' + error.message + '\\n');
    await shutdown().catch(() => {});
    process.exitCode = 1;
  }
}
