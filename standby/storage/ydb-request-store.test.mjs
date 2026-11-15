import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbRequestStore } from '../storage/ydb-request-store.mjs';

function fakeSql() {
  const enquiries = new Map();
  const idempotency = new Map();
  const calls = [];
  async function execute(strings, ...values) {
    const q = strings.join(' ? ').replace(/\\s+/g, ' ').trim();
    calls.push(q);
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
  return { sql:execute, enquiries, idempotency, calls };
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
