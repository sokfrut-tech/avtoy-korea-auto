import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbRequestStore } from '../storage/ydb-request-store.mjs';

function fakeSql() {
  const enquiries = new Map();
  const idempotency = new Map();
  const calls = [];
  const maxEvents = new Map();
  const fakeAudit = new Map();
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
    if (q.startsWith('CREATE TABLE IF NOT EXISTS standby_operator_audit_events')) return [];
    if (q.startsWith('INSERT INTO standby_operator_audit_events')) {
      const [id, occurredAt, actorId, role, action, targetType, targetId, outcome, metadata] = values;
      fakeAudit.set(id,{event_id:id,occurred_at:occurredAt,actor_id:actorId,actor_role:role,action,target_type:targetType,target_id:targetId,outcome,metadata});
      return [];
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
  return { sql:execute, enquiries, idempotency, maxEvents, fakeAudit, calls };
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
