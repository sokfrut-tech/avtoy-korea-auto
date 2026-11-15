import { createHash, randomUUID } from 'node:crypto';

const TABLE = 'standby_enquiries';
const IDEM_TABLE = 'standby_idempotency';
const MAX_LIMIT = 100;
const IDEM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('A valid timestamp is required');
  return date.toISOString();
}
function firstRow(result) { return result?.[0]?.[0] || null; }
function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}
function mapRow(row) {
  if (!row) return null;
  return {
    ...parseJson(row.payload, {}),
    id: row.request_id,
    createdAt: row.created_at,
    status: row.status,
    nextAttemptAt: Date.parse(row.next_attempt_at),
    lockUntil: row.lock_until ? Date.parse(row.lock_until) : undefined,
    leaseToken: row.lease_token || undefined,
    attempts: Number(row.attempts || 0),
    deliveredAdminIds: parseJson(row.delivered_admin_ids, []),
    lastError: row.last_error || null
  };
}
function boundedLimit(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new TypeError('limit must be a positive integer');
  return Math.min(n, MAX_LIMIT);
}
function digestKey(key) {
  const normalized = String(key || '').trim();
  if (!normalized) return null;
  if (!/^[a-zA-Z0-9._:-]{8,100}$/.test(normalized)) throw new TypeError('Invalid idempotency key');
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Request-oriented YDB inbox adapter. Telegram/network work must stay outside
 * these short serializable transactions. This adapter is opt-in; the HTTP
 * server selects it only when INBOX_STORE=v2 is explicitly configured.
 */
export function createYdbRequestStore({ sql, clock = () => Date.now(), idFactory = randomUUID } = {}) {
  if (typeof sql !== 'function' || typeof sql.begin !== 'function') throw new TypeError('A @ydbjs/query client is required');

  async function ensureMaxWebhookSchema() {
    await sql`CREATE TABLE IF NOT EXISTS standby_max_webhook_events (
      event_digest Utf8,
      event_type Utf8,
      event_timestamp Int64,
      chat_id Utf8,
      message_id Utf8,
      sender_user_id Utf8,
      received_at Utf8,
      PRIMARY KEY (event_digest)
    )`;
  }

  async function recordMaxWebhookEvent(event) {
    if (!event || !/^[a-f0-9]{64}$/.test(String(event.digest || ''))) throw new TypeError('A SHA-256 event digest is required');
    if (!['message_created','message_callback'].includes(event.eventType)) throw new TypeError('Unsupported MAX event type');
    const receivedAt = new Date(clock()).toISOString();
    return sql.begin({ isolation:'serializableReadWrite', idempotent:true }, async tx => {
      const existing = firstRow(await tx`SELECT event_digest FROM standby_max_webhook_events WHERE event_digest = ${event.digest}`);
      if (existing) return { duplicate:true };
      await tx`INSERT INTO standby_max_webhook_events
        (event_digest, event_type, event_timestamp, chat_id, message_id, sender_user_id, received_at)
        VALUES (${event.digest}, ${event.eventType}, ${event.eventTimestamp}, ${String(event.chatId)}, ${String(event.messageId || '')}, ${String(event.senderUserId || '')}, ${receivedAt})`;
      return { duplicate:false };
    });
  }

  async function createEnquiry(enquiry, idempotencyKey = null) {
    const requestId = idFactory();
    const now = clock();
    const createdAt = new Date(now).toISOString();
    const digest = digestKey(idempotencyKey);
    const expiresAt = new Date(now + IDEM_TTL_MS).toISOString();
    const payload = JSON.stringify(enquiry);
    return sql.begin({ isolation: 'serializableReadWrite', idempotent: true }, async tx => {
      if (digest) {
        const existing = firstRow(await tx`SELECT request_id, expires_at FROM standby_idempotency WHERE idempotency_digest = ${digest}`);
        if (existing && existing.expires_at > createdAt) {
          const row = firstRow(await tx`SELECT * FROM standby_enquiries WHERE request_id = ${existing.request_id}`);
          if (row) return { item: mapRow(row), duplicate: true };
        }
      }
      await tx`INSERT INTO standby_enquiries
        (request_id, created_at, status, next_attempt_at, lock_until, lease_token, attempts, delivered_admin_ids, last_error, payload)
        VALUES (${requestId}, ${createdAt}, 'queued', ${createdAt}, '', '', 0, '[]', '', ${payload})`;
      if (digest) {
        await tx`UPSERT INTO standby_idempotency (idempotency_digest, request_id, expires_at)
          VALUES (${digest}, ${requestId}, ${expiresAt})`;
      }
      return { item: { ...enquiry, id: requestId, createdAt, status: 'queued', nextAttemptAt: now, attempts: 0, deliveredAdminIds: [], lastError: null }, duplicate: false };
    });
  }

  async function getEnquiry(requestId) {
    const row = firstRow(await sql`SELECT * FROM standby_enquiries WHERE request_id = ${String(requestId)}`);
    return mapRow(row);
  }

  async function claimEnquiry(requestId, { now = clock(), leaseMs = 120_000 } = {}) {
    const nowIso = iso(now);
    if (!Number.isFinite(leaseMs) || leaseMs < 1000 || leaseMs > 15 * 60_000) throw new TypeError('leaseMs must be between 1 second and 15 minutes');
    const leaseUntil = new Date(Number(now) + leaseMs).toISOString();
    const leaseToken = idFactory();
    return sql.begin({ isolation: 'serializableReadWrite', idempotent: true }, async tx => {
      const row = firstRow(await tx`SELECT * FROM standby_enquiries WHERE request_id = ${String(requestId)}`);
      if (!row || row.status === 'delivered') return null;
      const eligible = (row.status === 'queued' && row.next_attempt_at <= nowIso) || (row.status === 'sending' && row.lock_until !== '' && row.lock_until <= nowIso);
      if (!eligible) return null;
      await tx`UPDATE standby_enquiries SET status = 'sending', lock_until = ${leaseUntil}, lease_token = ${leaseToken} WHERE request_id = ${String(requestId)}`;
      return { ...mapRow(row), status: 'sending', lockUntil: Date.parse(leaseUntil), leaseToken };
    });
  }

  async function claimDueEnquiries({ now = clock(), limit = 25, leaseMs = 120_000 } = {}) {
    const take = boundedLimit(limit);
    const nowIso = iso(now);
    if (!Number.isFinite(leaseMs) || leaseMs < 1000 || leaseMs > 15 * 60_000) throw new TypeError('leaseMs must be between 1 second and 15 minutes');
    const due = await sql`SELECT request_id FROM standby_enquiries VIEW idx_due_queue WHERE status = 'queued' AND next_attempt_at <= ${nowIso} ORDER BY next_attempt_at LIMIT ${take}`;
    const expired = await sql`SELECT request_id FROM standby_enquiries VIEW idx_expired_lease WHERE status = 'sending' AND lock_until <= ${nowIso} ORDER BY lock_until LIMIT ${take}`;
    // Interleave both queues so a sustained stream of new requests cannot
    // starve expired delivery leases indefinitely.
    const dueIds = (due?.[0] || []).map(row => row.request_id);
    const expiredIds = (expired?.[0] || []).map(row => row.request_id);
    const ids = [];
    for (let i = 0; ids.length < take && (i < dueIds.length || i < expiredIds.length); i += 1) {
      if (i < dueIds.length) ids.push(dueIds[i]);
      if (ids.length < take && i < expiredIds.length) ids.push(expiredIds[i]);
    }
    const uniqueIds = [...new Set(ids)].slice(0, take);
    const claimed = [];
    for (const requestId of uniqueIds) { const result = await claimEnquiry(requestId, { now, leaseMs }); if (result) claimed.push(result); }
    return claimed;
  }

  async function listPrivateEnquiries({ limit = 50 } = {}) {
    const take = boundedLimit(limit);
    const result = await sql`SELECT * FROM standby_enquiries ORDER BY created_at DESC LIMIT ${take}`;
    return (result?.[0] || []).map(mapRow);
  }

  async function completeDelivery({ requestId, leaseToken, deliveredAdminIds = [], requiredAdminIds = [], error = null, now = clock(), retryBaseMs = 60_000, retryMaxMs = 6 * 60 * 60_000 }) {
    if (!requestId || !leaseToken) throw new TypeError('requestId and leaseToken are required');
    const nowIso = iso(now);
    return sql.begin({ isolation: 'serializableReadWrite', idempotent: true }, async tx => {
      const row = firstRow(await tx`SELECT * FROM standby_enquiries WHERE request_id = ${String(requestId)}`);
      if (!row || row.status === 'delivered' || row.lease_token !== leaseToken) return null;
      const previous = parseJson(row.delivered_admin_ids, []);
      const receipts = [...new Set([...previous, ...deliveredAdminIds.map(String)])];
      const done = requiredAdminIds.length > 0 && requiredAdminIds.every(id => receipts.includes(String(id)));
      const attempts = Number(row.attempts || 0) + 1;
      const delay = Math.min(retryBaseMs * (2 ** Math.min(attempts - 1, 8)), retryMaxMs);
      const nextAttempt = done ? nowIso : new Date(Number(new Date(nowIso)) + delay).toISOString();
      await tx`UPDATE standby_enquiries SET
        status = ${done ? 'delivered' : 'queued'},
        next_attempt_at = ${nextAttempt},
        lock_until = '',
        lease_token = '',
        attempts = ${attempts},
        delivered_admin_ids = ${JSON.stringify(receipts)},
        last_error = ${done ? '' : String(error || 'telegram_delivery_failed').slice(0, 300)}
        WHERE request_id = ${String(requestId)}`;
      return { ...mapRow(row), status: done ? 'delivered' : 'queued', attempts, deliveredAdminIds: receipts, lastError: done ? null : String(error || 'telegram_delivery_failed'), nextAttemptAt: Date.parse(nextAttempt), lockUntil: undefined, leaseToken: undefined };
    });
  }

  return Object.freeze({ ensureMaxWebhookSchema, recordMaxWebhookEvent, createEnquiry, getEnquiry, claimEnquiry, claimDueEnquiries, listPrivateEnquiries, completeDelivery });
}
