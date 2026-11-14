import test from 'node:test';
import assert from 'node:assert/strict';
import { createYdbInboxStore } from '../storage/ydb-inbox-store.mjs';

function fakeSql(initial = []) {
  let payload = JSON.stringify(initial);
  let revision = initial.length ? 1n : 0n;
  const calls = [];
  const beginOptions = [];

  async function execute(strings, ...values) {
    const statement = strings.join(' ? ');
    calls.push(statement.trim().split(/\\s+/).slice(0, 3).join(' '));
    if (statement.includes('SELECT')) {
      return revision === 0n ? [] : [[{ revision, payload }]];
    }
    if (statement.includes('UPSERT')) {
      revision = BigInt(values[0]);
      payload = values[1];
      return [];
    }
    return [];
  }

  execute.identifier = (name) => name;
  execute.begin = async (optionsOrCallback, maybeCallback) => {
    if (typeof optionsOrCallback !== 'function') beginOptions.push(optionsOrCallback);
    return (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback)(execute);
  };
  execute.calls = calls;
  execute.beginOptions = beginOptions;
  execute.snapshot = () => ({ revision, payload: JSON.parse(payload) });
  return execute;
}

test('YDB inbox store validates its SQL client', () => {
  assert.throws(() => createYdbInboxStore({ sql: {} }), /query client/);
});

test('YDB inbox store creates schema and reads an empty inbox', async () => {
  const sql = fakeSql();
  const store = createYdbInboxStore({ sql });
  await store.ensureSchema();
  assert.deepEqual(await store.readInbox(), []);
  assert.ok(sql.calls.some((call) => call.startsWith('CREATE TABLE IF')));
});

test('YDB inbox store commits a complete mutation inside one transaction', async () => {
  const sql = fakeSql([{ id: 'first', status: 'queued' }]);
  const store = createYdbInboxStore({ sql });
  const result = await store.transactInbox((items) => ({
    items: [...items, { id: 'second', status: 'queued' }],
    result: 'saved'
  }));

  assert.equal(result, 'saved');
  assert.deepEqual(sql.beginOptions[0], { isolation: 'serializableReadWrite', idempotent: true });
  assert.deepEqual(sql.snapshot().payload, [
    { id: 'first', status: 'queued' },
    { id: 'second', status: 'queued' }
  ]);
  assert.equal(sql.snapshot().revision, 2n);
});

test('YDB inbox store rejects invalid mutation output', async () => {
  const sql = fakeSql();
  const store = createYdbInboxStore({ sql });
  await assert.rejects(
    () => store.transactInbox(() => ({ items: 'not-an-array' })),
    /Mutator must return an array/
  );
});


test('YDB inbox store rejects payloads above the safe row-size budget', async () => {
  const sql = fakeSql();
  const store = createYdbInboxStore({ sql });
  await assert.rejects(
    () => store.transactInbox(() => ({ items: [{ id: 'large', text: 'x'.repeat(3_600_000) }] })),
    (error) => error.code === 'INBOX_CAPACITY'
  );
});
