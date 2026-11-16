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
export function createYdbRequestStore({ sql, clock = () => Date.now(), idFactory = randomUUID, schemaManagedExternally = false } = {}) {
  if (typeof sql !== 'function' || typeof sql.begin !== 'function') throw new TypeError('A @ydbjs/query client is required');

  async function ensureMaxWebhookSchema() {
    if (schemaManagedExternally) return true;
    await sql`CREATE TABLE IF NOT EXISTS standby_max_webhook_events (
      event_digest Utf8 NOT NULL,
      event_type Utf8 NOT NULL,
      event_timestamp Int64 NOT NULL,
      chat_id Utf8 NOT NULL,
      message_id Utf8 NOT NULL,
      sender_user_id Utf8 NOT NULL,
      received_at Utf8 NOT NULL,
      PRIMARY KEY (event_digest)
    )`;
  }

  async function ensureMaxCommandReplySchema() {
    if (schemaManagedExternally) return true;
    await sql`CREATE TABLE IF NOT EXISTS standby_max_command_replies (
      event_digest Utf8 NOT NULL,
      command_kind Utf8 NOT NULL,
      actor_id Utf8 NOT NULL,
      reply_text Utf8 NOT NULL,
      status Utf8 NOT NULL,
      created_at Utf8 NOT NULL,
      next_attempt_at Utf8 NOT NULL,
      lock_until Utf8 NOT NULL,
      lease_token Utf8 NOT NULL,
      attempts Uint32 NOT NULL,
      last_error Utf8 NOT NULL,
      INDEX idx_max_reply_due GLOBAL SYNC ON (status, next_attempt_at),
      INDEX idx_max_reply_lease GLOBAL SYNC ON (status, lock_until),
      PRIMARY KEY (event_digest)
    )`;
  }

  async function verifySchema() {
    // Read-only startup checks: the production app identity needs SELECT/WRITE,
    // not CREATE/DROP/ALTER privileges. The index probes also validate queue indexes.
    await sql`SELECT request_id FROM standby_enquiries LIMIT 1`;
    await sql`SELECT idempotency_digest FROM standby_idempotency LIMIT 1`;
    await sql`SELECT event_digest FROM standby_max_webhook_events LIMIT 1`;
    await sql`SELECT event_digest FROM standby_max_command_replies LIMIT 1`;
    await sql`SELECT event_digest FROM standby_max_command_replies VIEW idx_max_reply_due WHERE status = 'queued' ORDER BY next_attempt_at LIMIT 1`;
    await sql`SELECT event_digest FROM standby_max_command_replies VIEW idx_max_reply_lease WHERE status = 'sending' ORDER BY lock_until LIMIT 1`;
    await sql`SELECT event_id FROM standby_operator_audit_events LIMIT 1`;
    await sql`SELECT key_digest FROM standby_operator_auth_rate_limits LIMIT 1`;
    await sql`SELECT request_id FROM standby_enquiries VIEW idx_due_queue WHERE status = 'queued' ORDER BY next_attempt_at LIMIT 1`;
    await sql`SELECT request_id FROM standby_enquiries VIEW idx_expired_lease WHERE status = 'sending' ORDER BY lock_until LIMIT 1`;
    return true;
  }

  async function recordMaxWebhookEvent(event) {
    if (!event || !/^[a-f0-9]{64}$/.test(String(event.digest || ''))) throw new TypeError('A SHA-256 event digest is required');
    if (!['message_created','message_callback'].includes(event.eventType)) throw new TypeError('Unsupported MAX event type');
    const receivedAt = new Date(clock()).toISOString();
    const reply = event.reply || null;
    if (reply) {
      if (!reply.auditEvent || !/^[A-Za-z0-9_-]{8,80}$/.test(String(reply.auditEvent.eventId || '')) || !/^[A-Za-z0-9._:-]{1,100}$/.test(String(reply.auditEvent.targetId || ''))) throw new TypeError('A safe MAX command audit event is required');
      if (!['help','status','invalid'].includes(reply.commandKind)) throw new TypeError('Unsupported MAX command kind');
      if (!/^[0-9]{1,20}$/.test(String(reply.actorId || ''))) throw new TypeError('Invalid MAX command actor');
      if (typeof reply.text !== 'string' || !reply.text.trim() || reply.text.length > 4000) throw new TypeError('Invalid MAX command reply text');
    }
    return sql.begin({ isolation:'serializableReadWrite', idempotent:true }, async tx => {
      const existing = firstRow(await tx`SELECT event_digest FROM standby_max_webhook_events WHERE event_digest = ${event.digest}`);
      if (existing) return { duplicate:true };
      // Receipt retention may expire before the outbox row is pruned. Keep the
      // outbox primary key as a second idempotency fence for late webhook replay.
      if (reply) {
        const priorReply = firstRow(await tx`SELECT event_digest FROM standby_max_command_replies WHERE event_digest = ${event.digest}`);
        if (priorReply) return { duplicate:true };
      }
      await tx`INSERT INTO standby_max_webhook_events
        (event_digest, event_type, event_timestamp, chat_id, message_id, sender_user_id, received_at)
        VALUES (${event.digest}, ${event.eventType}, ${event.eventTimestamp}, ${String(event.chatId)}, ${String(event.messageId || '')}, ${String(event.senderUserId || '')}, ${receivedAt})`;
      if (reply) {
        await tx`INSERT INTO standby_max_command_replies
          (event_digest, command_kind, actor_id, reply_text, status, created_at, next_attempt_at, lock_until, lease_token, attempts, last_error)
          VALUES (${event.digest}, ${reply.commandKind}, ${String(reply.actorId)}, ${reply.text.trim()}, 'queued', ${receivedAt}, ${receivedAt}, '', '', 0, '')`;
      }
      if (reply?.auditEvent) {
        const audit = reply.auditEvent;
        await tx`INSERT INTO standby_operator_audit_events
          (event_id, occurred_at, actor_id, actor_role, action, target_type, target_id, outcome, metadata)
          VALUES (${String(audit.eventId)}, ${receivedAt}, ${String(reply.actorId)}, 'operator', ${'max.command.' + reply.commandKind}, ${reply.commandKind === 'status' ? 'request' : 'group'}, ${String(audit.targetId || 'group')}, 'accepted', ${JSON.stringify({ reason:'max_group_command' })})`;
      }
      return { duplicate:false, queuedReply:Boolean(reply) };
    });
  }

  async function claimDueMaxCommandReplies({ now = clock(), limit = 20, leaseMs = 60_000 } = {}) {
    const take = boundedLimit(limit);
    if (take > 100) throw new TypeError('limit must not exceed 100');
    if (!Number.isFinite(leaseMs) || leaseMs < 1000 || leaseMs > 15 * 60_000) throw new TypeError('leaseMs must be between 1 second and 15 minutes');
    const nowIso = iso(now);
    const due = await sql`SELECT event_digest FROM standby_max_command_replies VIEW idx_max_reply_due
      WHERE status = 'queued' AND next_attempt_at <= ${nowIso}
      ORDER BY next_attempt_at LIMIT ${take}`;
    const expired = await sql`SELECT event_digest FROM standby_max_command_replies VIEW idx_max_reply_lease
      WHERE status = 'sending' AND lock_until <= ${nowIso}
      ORDER BY lock_until LIMIT ${take}`;
    const dueIds = (due?.[0] || []).map(row=>row.event_digest);
    const expiredIds = (expired?.[0] || []).map(row=>row.event_digest);
    const ordered = [];
    for (let i=0; ordered.length<take && (i<dueIds.length || i<expiredIds.length); i+=1) {
      if (i<dueIds.length) ordered.push(dueIds[i]);
      if (ordered.length<take && i<expiredIds.length) ordered.push(expiredIds[i]);
    }
    const ids = [...new Set(ordered)].slice(0,take);
    const claimed = [];
    for (const eventDigest of ids) {
      const leaseToken = idFactory();
      const leaseUntil = new Date(Number(new Date(nowIso)) + leaseMs).toISOString();
      const row = await sql.begin({ isolation:'serializableReadWrite', idempotent:true }, async tx => {
        const current = firstRow(await tx`SELECT * FROM standby_max_command_replies WHERE event_digest = ${eventDigest}`);
        if (!current) return null;
        const eligible = (current.status === 'queued' && current.next_attempt_at <= nowIso) ||
          (current.status === 'sending' && current.lock_until !== '' && current.lock_until <= nowIso);
        if (!eligible) return null;
        await tx`UPDATE standby_max_command_replies SET status = 'sending', lock_until = ${leaseUntil}, lease_token = ${leaseToken}
          WHERE event_digest = ${eventDigest}`;
        return { eventDigest, commandKind:current.command_kind, actorId:current.actor_id, text:current.reply_text, attempts:Number(current.attempts || 0), leaseToken, lockUntil:leaseUntil };
      });
      if (row) claimed.push(row);
    }
    return claimed;
  }

  async function completeMaxCommandReply({ eventDigest, leaseToken, now = clock() } = {}) {
    if (!/^[a-f0-9]{64}$/.test(String(eventDigest || '')) || !leaseToken) throw new TypeError('eventDigest and leaseToken are required');
    const completedAt = iso(now);
    return sql.begin({ isolation:'serializableReadWrite', idempotent:true }, async tx => {
      const row = firstRow(await tx`SELECT status, lease_token FROM standby_max_command_replies WHERE event_digest = ${eventDigest}`);
      if (!row || row.status !== 'sending' || row.lease_token !== leaseToken) return null;
      await tx`UPDATE standby_max_command_replies SET status = 'sent', next_attempt_at = ${completedAt}, lock_until = '', lease_token = '', last_error = ''
        WHERE event_digest = ${eventDigest}`;
      return { eventDigest, status:'sent' };
    });
  }

  async function failMaxCommandReply({ eventDigest, leaseToken, retryable = true, errorCode = 'max_network_error', now = clock(), retryBaseMs = 5000, retryMaxMs = 15 * 60_000, maxAttempts = 8 } = {}) {
    if (!/^[a-f0-9]{64}$/.test(String(eventDigest || '')) || !leaseToken) throw new TypeError('eventDigest and leaseToken are required');
    if (!/^[a-z][a-z0-9_]{2,48}$/.test(String(errorCode))) throw new TypeError('Invalid normalized MAX error code');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new TypeError('maxAttempts must be between 1 and 20');
    if (!Number.isFinite(retryBaseMs) || retryBaseMs < 100 || retryBaseMs > 60 * 60_000 || !Number.isFinite(retryMaxMs) || retryMaxMs < retryBaseMs || retryMaxMs > 24 * 60 * 60_000) throw new TypeError('Retry delays are outside the allowed bounds');
    const nowIso = iso(now);
    return sql.begin({ isolation:'serializableReadWrite', idempotent:true }, async tx => {
      const row = firstRow(await tx`SELECT status, lease_token, attempts FROM standby_max_command_replies WHERE event_digest = ${eventDigest}`);
      if (!row || row.status !== 'sending' || row.lease_token !== leaseToken) return null;
      const attempts = Number(row.attempts || 0) + 1;
      const dead = !retryable || attempts >= maxAttempts;
      const delay = Math.min(retryBaseMs * (2 ** Math.min(attempts - 1, 8)), retryMaxMs);
      const next = dead ? nowIso : new Date(Number(new Date(nowIso)) + delay).toISOString();
      await tx`UPDATE standby_max_command_replies SET status = ${dead ? 'dead' : 'queued'}, attempts = ${attempts},
        next_attempt_at = ${next}, lock_until = '', lease_token = '', last_error = ${errorCode}
        WHERE event_digest = ${eventDigest}`;
      return { eventDigest, status:dead ? 'dead' : 'queued', attempts, nextAttemptAt:next, lastError:errorCode };
    });
  }

  async function pruneMaxCommandReplies({ before, limit = 200 } = {}) {
    const cutoffDate = new Date(before);
    if (!before || !Number.isFinite(cutoffDate.getTime())) throw new TypeError('A valid MAX reply retention cutoff is required');
    const cutoff = cutoffDate.toISOString();
    if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 500) throw new TypeError('limit must be between 1 and 500');
    const take = Number(limit);
    await sql`DELETE FROM standby_max_command_replies ON
      SELECT event_digest FROM standby_max_command_replies
      WHERE status = 'sent' AND created_at < ${cutoff}
      ORDER BY created_at LIMIT ${take}`;
    return { cutoff, limit:take };
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

  /**
   * Delete at most 500 old MAX webhook receipts per call. The cutoff is an
   * explicit ISO timestamp supplied by the retention scheduler; no implicit
   * clock or unbounded table-wide DELETE is used.
   */
  async function pruneMaxWebhookEvents({ before, limit = 500 } = {}) {
    const cutoffDate = new Date(before);
    if (!before || !Number.isFinite(cutoffDate.getTime())) throw new TypeError('A valid retention cutoff timestamp is required');
    const cutoff = cutoffDate.toISOString();
    if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 500) {
      throw new TypeError('limit must be an integer between 1 and 500');
    }
    const take = Number(limit);
    await sql`DELETE FROM standby_max_webhook_events ON
      SELECT event_digest FROM standby_max_webhook_events
      WHERE received_at < ${cutoff}
      ORDER BY received_at
      LIMIT ${take}`;
    return Object.freeze({ cutoff, limit: take });
  }
  async function ensureOperatorAuditSchema() {
    if (schemaManagedExternally) return true;
    await sql`CREATE TABLE IF NOT EXISTS standby_operator_auth_rate_limits (
      key_digest Utf8 NOT NULL,
      window_start Utf8 NOT NULL,
      failures Uint32 NOT NULL,
      PRIMARY KEY (key_digest)
    )`;
    await sql`CREATE TABLE IF NOT EXISTS standby_operator_audit_events (
      event_id Utf8 NOT NULL, occurred_at Utf8 NOT NULL, actor_id Utf8 NOT NULL, actor_role Utf8 NOT NULL, action Utf8 NOT NULL,
      target_type Utf8 NOT NULL, target_id Utf8 NOT NULL, outcome Utf8 NOT NULL, metadata Utf8 NOT NULL,
      PRIMARY KEY (event_id)
    )`;
  }

  async function consumeOperatorAuthFailure({ keyDigest, now = clock(), windowMs = 600_000, maxFailures = 10 } = {}) {
    if (!/^[a-f0-9]{64}$/.test(String(keyDigest || ''))) throw new TypeError('A SHA-256 rate-limit key digest is required');
    if (!Number.isInteger(windowMs) || windowMs < 60_000 || windowMs > 60 * 60_000) throw new TypeError('windowMs must be between 1 and 60 minutes');
    if (!Number.isInteger(maxFailures) || maxFailures < 1 || maxFailures > 100) throw new TypeError('maxFailures must be between 1 and 100');
    const nowIso = iso(now);
    const cutoff = new Date(Number(new Date(nowIso)) - windowMs).toISOString();
    await ensureOperatorAuditSchema();
    return sql.begin({ isolation:'serializableReadWrite', idempotent:true }, async tx => {
      const row = firstRow(await tx`SELECT key_digest, window_start, failures FROM standby_operator_auth_rate_limits WHERE key_digest = ${keyDigest}`);
      if (!row || row.window_start <= cutoff) {
        await tx`UPSERT INTO standby_operator_auth_rate_limits (key_digest, window_start, failures) VALUES (${keyDigest}, ${nowIso}, 1)`;
        return { allowed:true, failures:1, windowStart:nowIso };
      }
      const failures = Number(row.failures || 0);
      if (failures >= maxFailures) return { allowed:false, failures, windowStart:row.window_start };
      const next = failures + 1;
      await tx`UPSERT INTO standby_operator_auth_rate_limits (key_digest, window_start, failures) VALUES (${keyDigest}, ${row.window_start}, ${next})`;
      return { allowed:true, failures:next, windowStart:row.window_start };
    });
  }

  async function pruneOperatorAuthRateLimits({ before, limit = 500 } = {}) {
    const cutoffDate = new Date(before);
    if (!before || !Number.isFinite(cutoffDate.getTime())) throw new TypeError('A valid rate-limit retention cutoff is required');
    const cutoff = cutoffDate.toISOString();
    if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 500) throw new TypeError('limit must be an integer between 1 and 500');
    const take = Number(limit);
    await sql`DELETE FROM standby_operator_auth_rate_limits ON
      SELECT key_digest FROM standby_operator_auth_rate_limits
      WHERE window_start < ${cutoff}
      ORDER BY window_start
      LIMIT ${take}`;
    return Object.freeze({ cutoff, limit:take });
  }

  async function recordOperatorAuditEvent(event) {
    if (!event || !/^[A-Za-z0-9_-]{8,80}$/.test(String(event.eventId || ''))) throw new TypeError('A valid audit event ID is required');
    const occurredAt = iso(event.occurredAt);
    const actorId = String(event.actorId || '');
    const actorRole = String(event.actorRole || '');
    const action = String(event.action || '');
    const targetType = String(event.targetType || '');
    const targetId = String(event.targetId || '');
    const outcome = String(event.outcome || '');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(actorId) || !['viewer','operator','supervisor','owner'].includes(actorRole)) throw new TypeError('Invalid audit actor');
    if (!/^[a-z][a-z0-9._-]{1,63}$/.test(action) || !/^[a-z][a-z0-9._-]{0,31}$/.test(targetType) || ! /^[A-Za-z0-9._:-]{1,100}$/.test(targetId) || !['accepted','denied','failed'].includes(outcome)) throw new TypeError('Invalid audit event fields');
    const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata) ? event.metadata : {};
    const safeMetadata = {};
    for (const [key,value] of Object.entries(metadata)) {
      if (!['count','processed','role','status','reason'].includes(key)) throw new TypeError('Unsupported audit metadata field');
      if (typeof value === 'number' && Number.isFinite(value)) safeMetadata[key] = value;
      else if (typeof value === 'boolean') safeMetadata[key] = value;
      else if (typeof value === 'string' && /^[a-z0-9._-]{1,40}$/i.test(value)) safeMetadata[key] = value;
      else throw new TypeError('Unsafe audit metadata value');
    }
    await ensureOperatorAuditSchema();
    await sql`INSERT INTO standby_operator_audit_events
      (event_id, occurred_at, actor_id, actor_role, action, target_type, target_id, outcome, metadata)
      VALUES (${String(event.eventId)}, ${occurredAt}, ${actorId}, ${actorRole}, ${action}, ${targetType}, ${targetId}, ${outcome}, ${JSON.stringify(safeMetadata)})`;
    return { eventId:String(event.eventId), recorded:true };
  }
  async function pruneOperatorAuditEvents({ before, limit = 500 } = {}) {
    const cutoffDate = new Date(before);
    if (!before || !Number.isFinite(cutoffDate.getTime())) throw new TypeError('A valid audit retention cutoff is required');
    const cutoff = cutoffDate.toISOString();
    if (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 500) throw new TypeError('limit must be an integer between 1 and 500');
    const take = Number(limit);
    await sql`DELETE FROM standby_operator_audit_events ON
      SELECT event_id FROM standby_operator_audit_events
      WHERE occurred_at < ${cutoff}
      ORDER BY occurred_at
      LIMIT ${take}`;
    return Object.freeze({ cutoff, limit:take });
  }

  async function listOperatorAuditEvents({ limit = 100 } = {}) {
    const take = boundedLimit(limit);
    const result = await sql`SELECT event_id, occurred_at, actor_id, actor_role, action, target_type, target_id, outcome, metadata
      FROM standby_operator_audit_events ORDER BY occurred_at DESC LIMIT ${take}`;
    return (result?.[0] || []).map(row => ({
      eventId:row.event_id, occurredAt:row.occurred_at, actorId:row.actor_id, actorRole:row.actor_role,
      action:row.action, targetType:row.target_type, targetId:row.target_id, outcome:row.outcome,
      metadata:parseJson(row.metadata,{})
    }));
  }

  return Object.freeze({ ensureMaxWebhookSchema, ensureMaxCommandReplySchema, ensureOperatorAuditSchema, verifySchema, recordMaxWebhookEvent, claimDueMaxCommandReplies, completeMaxCommandReply, failMaxCommandReply, pruneMaxCommandReplies, createEnquiry, getEnquiry, claimEnquiry, claimDueEnquiries, listPrivateEnquiries, completeDelivery, pruneMaxWebhookEvents, consumeOperatorAuthFailure, pruneOperatorAuthRateLimits, recordOperatorAuditEvent, listOperatorAuditEvents, pruneOperatorAuditEvents });
}
