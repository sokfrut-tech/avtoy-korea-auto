import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbRequestStore } from '../storage/ydb-request-store.mjs';

function fakeSql() {
  const enquiries = new Map();
  const idempotency = new Map();
  const calls = [];
  const maxEvents = new Map();
  const fakeAudit = new Map();
  const rateLimits = new Map();
  async function execute(strings, ...values) {
    const q = strings.join(' ? ').replace(/\\s+/g, ' ').trim();
    calls.push(q);
    if (q.startsWith('SELECT event_digest FROM standby_max_webhook_events')) {
      const row = maxEvents.get(values[0]); return row ? [[{ ...row }]] : [];
    }
    if (q.startsWith('INSERT INTO standby_max_webhook_events')) {
      const [digest,eventType,eventTimestamp,chatId,messageId,senderUserId,receivedAt] = values;
      maxEvents.set(digest,{event_digest:digest,event_type:eventType,event_timestamp:eventTimestamp,chat_id:chatId,message_id:messageId,sender_user_id:senderUserId,received_at:receivedAt});
      return [];
    }
    if (q.startsWith('DELETE FROM standby_max_webhook_events ON')) {
      const [cutoff, limit] = values;
      const expired = [...maxEvents.values()].filter(row => row.received_at < cutoff).sort((a,b) => a.received_at.localeCompare(b.received_at)).slice(0, Number(limit));
      for (const row of expired) maxEvents.delete(row.event_digest);
      return [];
    }
    if (q.startsWith('CREATE TABLE IF NOT EXISTS standby_operator_auth_rate_limits')) return [];
    if (q.startsWith('SELECT key_digest, window_start, failures FROM standby_operator_auth_rate_limits')) {
      const row=rateLimits.get(values[0]); return row ? [[{...row}]] : [];
    }
    if (q.startsWith('UPSERT INTO standby_operator_auth_rate_limits')) {
      const [key_digest,window_start,failures=1]=values; rateLimits.set(key_digest,{key_digest,window_start,failures}); return [];
    }
    if (q.startsWith('DELETE FROM standby_operator_auth_rate_limits ON')) {
      const [cutoff,limit]=values;
      const rows=[...rateLimits.values()].filter(row=>row.window_start<cutoff).sort((a,b)=>a.window_start.localeCompare(b.window_start)).slice(0,Number(limit));
      for(const row of rows) rateLimits.delete(row.key_digest);
      return [];
    }
    if (q.startsWith('CREATE TABLE IF NOT EXISTS standby_operator_audit_events')) return [];
    if (q.startsWith('INSERT INTO standby_operator_audit_events')) {
      const [id, occurredAt, actorId, role, action, targetType, targetId, outcome, metadata] = values;
      fakeAudit.set(id,{event_id:id,occurred_at:occurredAt,actor_id:actorId,actor_role:role,action,target_type:targetType,target_id:targetId,outcome,metadata});
      return [];
    }
    if (q.startsWith('DELETE FROM standby_operator_audit_events ON')) {
      const [cutoff,limit]=values;
      const rows=[...fakeAudit.values()].filter(row=>row.occurred_at<cutoff).sort((a,b)=>a.occurred_at.localeCompare(b.occurred_at)).slice(0,Number(limit));
      for(const row of rows) fakeAudit.delete(row.event_id);
      return [];
    }
    if (q.startsWith('SELECT event_id, occurred_at, actor_id, actor_role, action, target_type, target_id, outcome, metadata')) {
      return [[...fakeAudit.values()].sort((a,b)=>b.occurred_at.localeCompare(a.occurred_at)).slice(0,Number(values[0]))];
    }
    if (q.startsWith('SELECT request_id, expires_at FROM standby_idempotency')) {
      const row = idempotency.get(values[0]); return row ? [[{ ...row }]] : [];
    }
    if (q.startsWith('SELECT * FROM standby_enquiries')) {
      const row = enquiries.get(values[0]); return row ? [[{ ...row }]] : [];
    }
    if (q.startsWith('INSERT INTO standby_enquiries')) {
      const [id, created, next, payload] = values;
      if (enquiries.has(id)) throw new Error('duplicate primary key');
      enquiries.set(id, { request_id:id, created_at:created, status:'queued', next_attempt_at:next, lock_until:'', lease_token:'', attempts:0, delivered_admin_ids:'[]', last_error:'', payload });
      return [];
    }
    if (q.startsWith('UPSERT INTO standby_idempotency')) {
      idempotency.set(values[0], { request_id:values[1], expires_at:values[2] }); return [];
    }
    if (q.startsWith('UPDATE standby_enquiries SET status')) {
      const [lockUntil, leaseToken, id] = values; const row = enquiries.get(id);
      if (row) Object.assign(row, { status:'sending', lock_until:lockUntil, lease_token:leaseToken });
      return [];
    }
    if (q.startsWith('UPDATE standby_enquiries SET')) {
      const [status,next,lock,token,attempts,receipts,error,id] = values;
      const row = enquiries.get(id);
      if (row) Object.assign(row, { status, next_attempt_at:next, lock_until:lock, lease_token:token, attempts, delivered_admin_ids:receipts, last_error:error });
      return [];
    }
    if (q.startsWith('SELECT request_id FROM standby_enquiries VIEW')) {
      const view = q.includes('idx_due_queue') ? 'due' : 'expired';
      const [timestamp, limit] = values;
      const rows = [...enquiries.values()].filter(r => view === 'due'
        ? r.status === 'queued' && r.next_attempt_at <= timestamp
        : r.status === 'sending' && r.lock_until !== '' && r.lock_until <= timestamp
      ).slice(0, Number(limit)).map(r => ({ request_id:r.request_id }));
      return [rows];
    }
    return [];
  }
  execute.begin = async (_options, callback) => callback(execute);
  return { sql:execute, enquiries, idempotency, maxEvents, fakeAudit, rateLimits, calls };
}

test('creates one request per row and stores only a digest for idempotency', async () => {
  const fake = fakeSql(); let n = 0;
  const store = createYdbRequestStore({ sql:fake.sql, clock:()=>1_800_000_000_000, idFactory:()=> 'request-' + (++n) });
  const first = await store.createEnquiry({ name:'A', contact:'B' }, 'form-key-0001');
  assert.equal(first.duplicate, false);
  assert.equal(fake.enquiries.size, 1);
  assert.equal([...fake.idempotency.keys()][0].length, 64);
  assert.equal([...fake.idempotency.keys()][0].includes('form-key'), false);
});

test('returns the original request for a repeated idempotency key', async () => {
  const fake = fakeSql(); let n = 0;
  const store = createYdbRequestStore({ sql:fake.sql, clock:()=>1_800_000_000_000, idFactory:()=> 'request-' + (++n) });
  const first = await store.createEnquiry({ name:'A', contact:'B' }, 'form-key-0001');
  const second = await store.createEnquiry({ name:'A changed', contact:'B' }, 'form-key-0001');
  assert.equal(second.duplicate, true);
  assert.equal(second.item.id, first.item.id);
  assert.equal(fake.enquiries.size, 1);
});

test('claims due work with a lease and rejects stale lease completion', async () => {
  const fake = fakeSql(); let n = 0;
  const store = createYdbRequestStore({ sql:fake.sql, clock:()=>1_800_000_000_000, idFactory:()=> 'id-' + (++n) });
  const created = await store.createEnquiry({ name:'A', contact:'B' });
  const claimed = await store.claimDueEnquiries({ now:1_800_000_000_000, limit:10 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].id, created.item.id);
  assert.equal(await store.completeDelivery({ requestId:created.item.id, leaseToken:'stale', requiredAdminIds:['1'], deliveredAdminIds:['1'] }), null);
  const completed = await store.completeDelivery({ requestId:created.item.id, leaseToken:claimed[0].leaseToken, requiredAdminIds:['1'], deliveredAdminIds:['1'], now:1_800_000_000_100 });
  assert.equal(completed.status, 'delivered');
  assert.deepEqual(completed.deliveredAdminIds, ['1']);
});

test('does not report delivery complete until every required admin has a receipt', async () => {
  const fake = fakeSql(); let n = 0;
  const store = createYdbRequestStore({ sql:fake.sql, clock:()=>1_800_000_000_000, idFactory:()=> 'id-' + (++n) });
  const created = await store.createEnquiry({ name:'A', contact:'B' });
  const [claim] = await store.claimDueEnquiries({ now:1_800_000_000_000 });
  const result = await store.completeDelivery({ requestId:created.item.id, leaseToken:claim.leaseToken, requiredAdminIds:['1','2'], deliveredAdminIds:['1'] });
  assert.equal(result.status, 'queued');
  assert.deepEqual(result.deliveredAdminIds, ['1']);
});

test('interleaves expired delivery leases with due enquiries instead of starving leases', async () => {
  const fake = fakeSql(); let n = 0;
  const start = 1_800_000_000_000;
  const store = createYdbRequestStore({ sql:fake.sql, clock:()=>start, idFactory:()=> 'id-' + (++n) });
  const first = await store.createEnquiry({ name:'expired', contact:'1' });
  await store.createEnquiry({ name:'due-1', contact:'2' });
  await store.createEnquiry({ name:'due-2', contact:'3' });
  await store.claimEnquiry(first.item.id, { now:start, leaseMs:1_000 });
  const claimed = await store.claimDueEnquiries({ now:start + 2_000, limit:2 });
  assert.equal(claimed.length, 2);
  assert.ok(claimed.some(item => item.id === first.item.id), 'expired lease must not be pushed behind every due request');
});


test('MAX webhook event persistence is idempotent and stores only event metadata', async () => {
  const fake=fakeSql();
  const store=createYdbRequestStore({sql:fake.sql,clock:()=>1_800_000_000_000});
  await store.ensureMaxWebhookSchema();
  const event={digest:'a'.repeat(64),eventType:'message_created',eventTimestamp:1_800_000_000_000,chatId:'987654321',messageId:'mid-1',senderUserId:'user-1'};
  assert.deepEqual(await store.recordMaxWebhookEvent(event),{duplicate:false});
  assert.deepEqual(await store.recordMaxWebhookEvent(event),{duplicate:true});
  assert.equal(fake.maxEvents.size,1);
  assert.equal(fake.maxEvents.get(event.digest).message_id,'mid-1');
  assert.equal(Object.hasOwn(fake.maxEvents.get(event.digest),'text'),false);
});

test('MAX webhook event persistence rejects invalid digests and unsupported types', async () => {
  const store=createYdbRequestStore({sql:fakeSql().sql});
  await assert.rejects(()=>store.recordMaxWebhookEvent({digest:'bad',eventType:'message_created',eventTimestamp:1,chatId:'1'}),/SHA-256/);
  await assert.rejects(()=>store.recordMaxWebhookEvent({digest:'b'.repeat(64),eventType:'bot_started',eventTimestamp:1,chatId:'1'}),/Unsupported/);
});

test('MAX webhook retention deletes only old events in bounded batches', async () => {
  let now = Date.parse('2026-11-15T12:00:00.000Z');
  const fake = fakeSql();
  const store = createYdbRequestStore({ sql:fake.sql, clock:()=>now });
  await store.ensureMaxWebhookSchema();
  const event = (digest) => ({ digest:digest.repeat(64), eventType:'message_created', eventTimestamp:now, chatId:'987654321', messageId:'mid-'+digest, senderUserId:'12345' });
  await store.recordMaxWebhookEvent(event('a'));
  now += 86_400_000;
  await store.recordMaxWebhookEvent(event('b'));
  now += 86_400_000;
  await store.recordMaxWebhookEvent(event('c'));
  const result = await store.pruneMaxWebhookEvents({ before:'2026-11-16T00:00:00.000Z', limit:1 });
  assert.equal(result.limit,1);
  assert.equal(fake.maxEvents.size,2);
  assert.equal(fake.maxEvents.has('a'.repeat(64)),false);
  assert.equal(fake.maxEvents.has('b'.repeat(64)),true);
  assert.equal(fake.maxEvents.has('c'.repeat(64)),true);
  assert.ok(fake.calls.some(q => q.startsWith('DELETE FROM standby_max_webhook_events ON')));
});

test('MAX webhook retention rejects missing cutoff and unsafe batch limits', async () => {
  const store = createYdbRequestStore({ sql:fakeSql().sql });
  await assert.rejects(() => store.pruneMaxWebhookEvents({}), /cutoff/);
  await assert.rejects(() => store.pruneMaxWebhookEvents({ before:'2026-11-15T00:00:00Z', limit:0 }), /limit/);
  await assert.rejects(() => store.pruneMaxWebhookEvents({ before:'2026-11-15T00:00:00Z', limit:501 }), /limit/);
});

test('operator audit persists allowlisted events without customer PII', async () => {
  const fake=fakeSql(); const store=createYdbRequestStore({sql:fake.sql,clock:()=>1_800_000_000_000});
  const event={eventId:'audit-event-0001',occurredAt:'2026-11-15T18:00:00.000Z',actorId:'operator-a',actorRole:'operator',action:'inbox.read',targetType:'inbox',targetId:'all',outcome:'accepted',metadata:{count:3}};
  assert.deepEqual(await store.recordOperatorAuditEvent(event),{eventId:event.eventId,recorded:true});
  const row=fake.fakeAudit.get(event.eventId);
  assert.equal(row.actor_id,'operator-a');
  assert.equal(row.metadata,'{"count":3}');
  assert.equal(JSON.stringify(row).includes('phone'),false);
});

test('operator audit rejects PII and unapproved metadata fields', async () => {
  const store=createYdbRequestStore({sql:fakeSql().sql});
  const base={eventId:'audit-event-0002',occurredAt:'2026-11-15T18:00:00Z',actorId:'operator-a',actorRole:'operator',action:'inbox.read',targetType:'inbox',targetId:'all',outcome:'accepted'};
  await assert.rejects(()=>store.recordOperatorAuditEvent({...base,metadata:{phone:'+79990000000'}}),/Unsupported/);
  await assert.rejects(()=>store.recordOperatorAuditEvent({...base,metadata:{reason:'phone:+79990000000'}}),/Unsafe/);
});

test('operator audit listing returns only stored audit fields in reverse chronological order', async () => {
  const fake=fakeSql(); const store=createYdbRequestStore({sql:fake.sql});
  await store.recordOperatorAuditEvent({eventId:'audit-event-001',occurredAt:'2026-11-15T18:00:00Z',actorId:'operator-a',actorRole:'operator',action:'inbox.read',targetType:'inbox',targetId:'all',outcome:'accepted',metadata:{count:2}});
  const rows=await store.listOperatorAuditEvents({limit:10});
  assert.equal(rows.length,1);
  assert.equal(rows[0].actorId,'operator-a');
  assert.deepEqual(rows[0].metadata,{count:2});
  assert.equal(Object.hasOwn(rows[0],'phone'),false);
});


test('distributed auth limiter counts failures by digest and blocks at the configured threshold', async () => {
  const fake=fakeSql(); const store=createYdbRequestStore({sql:fake.sql,clock:()=>Date.parse('2026-11-15T12:00:00.000Z')});
  const key='a'.repeat(64);
  for(let i=1;i<=10;i++){
    const result=await store.consumeOperatorAuthFailure({keyDigest:key,now:Date.parse('2026-11-15T12:00:00.000Z'),maxFailures:10});
    assert.equal(result.allowed,true); assert.equal(result.failures,i);
  }
  const blocked=await store.consumeOperatorAuthFailure({keyDigest:key,now:Date.parse('2026-11-15T12:00:00.000Z'),maxFailures:10});
  assert.equal(blocked.allowed,false); assert.equal(blocked.failures,10);
  assert.equal(fake.rateLimits.size,1);
});

test('distributed auth limiter starts a fresh window and validates inputs', async () => {
  const fake=fakeSql(); const store=createYdbRequestStore({sql:fake.sql});
  const key='b'.repeat(64);
  await store.consumeOperatorAuthFailure({keyDigest:key,now:'2026-11-15T12:00:00.000Z'});
  const next=await store.consumeOperatorAuthFailure({keyDigest:key,now:'2026-11-15T12:11:00.000Z'});
  assert.equal(next.allowed,true); assert.equal(next.failures,1);
  await assert.rejects(()=>store.consumeOperatorAuthFailure({keyDigest:'bad'}),/digest/);
  await assert.rejects(()=>store.consumeOperatorAuthFailure({keyDigest:key,windowMs:1000}),/windowMs/);
});

test('distributed auth limiter cleanup deletes only expired buckets in bounded batches', async () => {
  const fake=fakeSql(); const store=createYdbRequestStore({sql:fake.sql});
  await store.consumeOperatorAuthFailure({keyDigest:'c'.repeat(64),now:'2026-11-14T00:00:00.000Z'});
  await store.consumeOperatorAuthFailure({keyDigest:'d'.repeat(64),now:'2026-11-15T00:00:00.000Z'});
  await store.pruneOperatorAuthRateLimits({before:'2026-11-15T00:00:00.000Z',limit:1});
  assert.equal(fake.rateLimits.has('c'.repeat(64)),false);
  assert.equal(fake.rateLimits.has('d'.repeat(64)),true);
  await assert.rejects(()=>store.pruneOperatorAuthRateLimits({}),/cutoff/);
});


test('operator audit retention removes only old events in bounded batches', async () => {
  const fake=fakeSql(); const store=createYdbRequestStore({sql:fake.sql});
  const base={actorId:'operator-a',actorRole:'operator',action:'inbox.read',targetType:'inbox',targetId:'all',outcome:'accepted'};
  await store.recordOperatorAuditEvent({ ...base,eventId:'audit-event-old',occurredAt:'2026-10-01T00:00:00Z' });
  await store.recordOperatorAuditEvent({ ...base,eventId:'audit-event-new',occurredAt:'2026-11-15T00:00:00Z' });
  await store.pruneOperatorAuditEvents({before:'2026-11-01T00:00:00Z',limit:1});
  assert.equal(fake.fakeAudit.has('audit-event-old'),false);
  assert.equal(fake.fakeAudit.has('audit-event-new'),true);
  await assert.rejects(()=>store.pruneOperatorAuditEvents({}),/cutoff/);
  await assert.rejects(()=>store.pruneOperatorAuditEvents({before:'2026-11-01T00:00:00Z',limit:501}),/limit/);
});


test('externally managed YDB schema skips all DDL and exposes read-only verification', async () => {
  const fake=fakeSql();
  const store=createYdbRequestStore({sql:fake.sql,schemaManagedExternally:true});
  assert.equal(await store.ensureMaxWebhookSchema(),true);
  assert.equal(await store.ensureOperatorAuditSchema(),true);
  assert.equal(await store.verifySchema(),true);
  assert.equal(fake.calls.some(call=>/^CREATE TABLE/.test(call.query)),false);
  assert.equal(fake.calls.some(call=>/^SELECT/.test(call.query)),true);
  assert.equal(fake.calls.some(call=>/^CREATE TABLE/.test(call.query)),false);
});

test('YDB schema verification checks queue indexes as well as required tables', async () => {
  const fake=fakeSql();
  const store=createYdbRequestStore({sql:fake.sql,schemaManagedExternally:true});
  await store.verifySchema();
  const queries=fake.calls.map(call=>call.query);
  assert.ok(queries.some(q=>q.includes('VIEW idx_due_queue')));
  assert.ok(queries.some(q=>q.includes('VIEW idx_expired_lease')));
});
