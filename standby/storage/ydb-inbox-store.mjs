function parsePayload(value) {
  if (typeof value !== 'string') throw new Error('YDB inbox payload is missing or invalid');
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('YDB inbox payload must be an array');
  return parsed;
}

/**
 * Transactional inbox storage backed by YDB.
 *
 * The mutator must be deterministic and free of network/external side effects:
 * YDB may retry a serializable transaction. Telegram delivery belongs outside
 * this transaction (the HTTP server uses a claim -> deliver -> finalize flow).
 */
export function createYdbInboxStore({ sql } = {}) {
  if (typeof sql !== 'function' || typeof sql.begin !== 'function') {
    throw new TypeError('A @ydbjs/query client is required');
  }

  async function ensureSchema() {
    await sql`CREATE TABLE IF NOT EXISTS standby_inbox (
      singleton Utf8,
      revision Int64,
      payload Utf8,
      PRIMARY KEY (singleton)
    )`;
  }

  async function readInbox() {
    const result = await sql`SELECT payload FROM standby_inbox WHERE singleton = 'inbox'`;
    const row = result?.[0]?.[0];
    return row ? parsePayload(row.payload) : [];
  }

  async function transactInbox(mutator) {
    if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
    return sql.begin({ isolation: 'serializableReadWrite', idempotent: true }, async (tx) => {
      const result = await tx`SELECT revision, payload FROM standby_inbox WHERE singleton = 'inbox'`;
      const row = result?.[0]?.[0];
      const current = row ? parsePayload(row.payload) : [];
      const revision = row ? BigInt(row.revision) : 0n;
      const outcome = await mutator(current);
      const next = Array.isArray(outcome) ? outcome : (outcome?.items ?? current);
      if (!Array.isArray(next)) throw new TypeError('Mutator must return an array or { items, result }');

      const payload = JSON.stringify(next);
      if (Buffer.byteLength(payload, 'utf8') > 3_500_000) {
        throw Object.assign(new Error('YDB inbox capacity limit reached'), { code: 'INBOX_CAPACITY' });
      }
      await tx`UPSERT INTO standby_inbox (singleton, revision, payload)
        VALUES ('inbox', ${revision + 1n}, ${payload})`;
      return outcome && !Array.isArray(outcome) && Object.prototype.hasOwnProperty.call(outcome, 'result')
        ? outcome.result
        : undefined;
    });
  }

  return Object.freeze({ ensureSchema, readInbox, transactInbox });
}

/**
 * Bootstrap:
 *   const driver = new Driver(process.env.YDB_CONNECTION_STRING);
 *   await driver.ready();
 *   const store = createYdbInboxStore({ sql: query(driver) });
 *   await store.ensureSchema();
 * Close the driver on graceful shutdown. Use Yandex Cloud metadata/workload
 * identity credentials; never commit connection strings or access tokens.
 */
