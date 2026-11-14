# YDB inbox scaling decision — 2026-11-14

## Current verified implementation

`standby/storage/ydb-inbox-store.mjs` stores the complete inbox as JSON in one YDB row:

- table: `standby_inbox`
- primary key: constant `singleton = 'inbox'`
- columns: `revision Int64`, `payload Utf8`
- every mutation reads, parses, rewrites, and commits the entire array in one serializable transaction
- payloads above 3,500,000 UTF-8 bytes are rejected with `INBOX_CAPACITY`

The 3.5 MB guard is useful fail-closed behavior, but it is not horizontal scaling. Every new enquiry and delivery-state update rewrites the same row. This creates a single hot key, write amplification proportional to inbox size, and a hard capacity ceiling. The current fake SQL tests validate the adapter contract and payload guard; they do not prove YDB transaction isolation, retry behavior, query result shape, or cloud credentials.

## Decision

Do not silently replace this store with a guessed YDB schema in the current MR. The server currently depends on an array-level API (`readInbox()` and `transactInbox(mutator)`), so changing only the table layout without changing the service boundary would still require full-table reads and rewrites.

The correct next design is a request-oriented repository API, for example:

- `createEnquiry(enquiry, idempotencyKey)`
- `getEnquiry(requestId)`
- `claimDueEnquiries(now, limit, leaseUntil)`
- `completeDelivery(requestId, deliveryResult)`
- `listPrivateEnquiries(cursor, limit)`

## Proposed YDB layout

1. `standby_enquiries`: one row per request, keyed by `request_id`; payload and delivery state are updated independently. Include `created_at`, `status`, `next_attempt_at`, `lock_until`, `attempts`, `delivered_admin_ids`, and the private enquiry payload.
2. `standby_idempotency`: one row per normalized idempotency-key digest, storing `request_id` and expiry. Enquiry creation and idempotency reservation must happen in the same serializable transaction; never rely on a read-then-write outside a transaction.
3. Due-work lookup: use an index/table keyed by a bounded time bucket plus `next_attempt_at` and `request_id`, or a YDB-supported secondary index after validating the exact SDK/API. Claiming work must atomically update a lease so concurrent schedulers cannot deliver the same request simultaneously.
4. Retention: define an explicit retention/archival policy for delivered enquiries and expired idempotency keys. Never silently delete undelivered requests.
5. Delivery: keep Telegram HTTP calls outside DB transactions. Preserve at-least-once semantics and per-admin delivery receipts; document the small crash window where Telegram accepted a message but the DB receipt was not committed.

## Migration safety requirements

- Add a versioned schema and idempotent migration command.
- Dual-read/compare old and new stores before cutover; do not dual-write without a reconciliation strategy.
- Copy old inbox rows with stable request IDs and idempotency keys; verify counts, IDs, status totals, and payload checksums.
- Keep the old singleton table read-only until a rollback window expires.
- Test concurrent creates with identical and different idempotency keys, competing claims, expired leases, partial admin delivery, transaction retry, and restart recovery against a real YDB test database.
- Do not enable the new store merely because mock tests pass.

## Scope and status

This is an architecture decision and migration plan, not an implemented schema migration. No YDB database has been provisioned or modified. The current single-row implementation remains in the prototype. A real YDB integration test is a merge gate.
