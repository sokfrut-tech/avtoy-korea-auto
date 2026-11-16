# MAX command-reply outbox — implementation contract (2026-11-16)

## Purpose

Close the reliability gap in PR #79: a MAX webhook receipt is currently persisted before the command response is sent. If MAX accepts the webhook but the outbound API call fails, a redelivery is classified as a duplicate and the operator never receives the response.

This document defines the next implementation slice. It does not claim that the outbox is implemented or that MAX delivery is production-ready.

## Required invariants

1. **Atomic acceptance:** the webhook receipt and command-reply outbox row must be committed in the same YDB serializable read-write transaction. A receipt must never exist without either a durable reply row or an explicit no-reply classification.
2. **Idempotency:** one reply row per SHA-256 webhook event digest. Use the digest as the outbox primary key; never persist raw webhook JSON or customer PII in the outbox.
3. **No network in a transaction:** enqueue/claim/complete operations are short YDB transactions. MAX HTTP calls happen only after a lease is acquired and outside the transaction.
4. **Lease fencing:** every claim receives a fresh random lease token and lock_until. Completion/failure updates must match both reply key and lease token. Stale workers cannot complete a newer lease.
5. **At-least-once delivery:** if MAX accepted a message but the process crashed before recording completion, a retry can send it again. Do not promise exactly-once delivery unless MAX provides and confirms a supported idempotency mechanism.
6. **Bounded retry:** exponential backoff, capped delay, and a finite attempt ceiling. Terminal failures remain inspectable and must not be silently deleted.
7. **Privacy:** outbox payload is limited to a short, pre-rendered operator response (help text or status-only text), command kind, actor ID, event digest, timestamps, attempts and safe error code. Never put enquiry name, phone, vehicle description, comment, raw body or access token in outbox/audit metadata.
8. **Fixed destination:** delivery continues to use only the server-configured MAX_OPERATOR_CHAT_ID. No request or outbox field may override the destination.

## YDB table contract

Table: standby_max_command_replies

| Column | Type | Purpose |
|---|---|---|
| event_digest | Utf8, primary key | SHA-256 idempotency key, same as webhook receipt digest |
| command_kind | Utf8 | help, status, or invalid |
| actor_id | Utf8 | allowlisted MAX operator ID |
| reply_text | Utf8 | sanitized, pre-rendered response, max 4,000 chars |
| status | Utf8 | queued, sending, sent, dead |
| created_at | Utf8 | ISO timestamp |
| next_attempt_at | Utf8 | due-time queue key |
| lock_until | Utf8 | empty unless leased |
| lease_token | Utf8 | random fencing token |
| attempts | Uint32 | completed delivery attempts |
| last_error | Utf8 | bounded safe error code, never raw response/body |

Required global secondary indexes:
- idx_max_reply_due on (status, next_attempt_at)
- idx_max_reply_lease on (status, lock_until)

Keep the MAX webhook receipt table separate. Both tables are retention-controlled; do not delete queued, sending, or dead outbox records as part of webhook receipt cleanup.

## Store API

Implement on the YDB request store:

- ensureMaxCommandReplySchema() — development-only DDL; no schema creation from production identity.
- enqueueMaxCommandReply({ eventDigest, commandKind, actorId, replyText, now }) — insert-if-absent, return { duplicate }.
- claimDueMaxCommandReplies({ now, limit, leaseMs }) — claim due queued rows and expired leases; limit 1–100; lease 1–900 seconds.
- completeMaxCommandReply({ eventDigest, leaseToken, now }) — mark sent only if the current lease token matches.
- failMaxCommandReply({ eventDigest, leaseToken, retryable, errorCode, now, retryBaseMs, retryMaxMs, maxAttempts }) — retry with capped exponential backoff or mark dead; reject stale lease tokens.
- listMaxCommandReplies({ status, limit }) — metadata-only operator diagnostics; never expose reply text outside the authorized audit path.
- pruneMaxCommandReplies({ before, limit }) — delete only sent/old terminal rows in bounded batches; never delete queued or currently leased rows.

Production verifySchema() must read-probe the table and both indexes. Runtime identity needs only the minimum SELECT/INSERT/UPDATE/DELETE permissions required by the application; schema migration uses a separate privileged identity.

## Webhook processing order

1. Validate webhook secret, configured group, update type, sender allowlist and message shape.
2. Parse the command and build a privacy-safe response. For !status, load only the enquiry status and short ID; do not serialize the enquiry object.
3. In one serializable YDB transaction: insert webhook receipt if absent; if it is a command, insert the outbox row keyed by the same event digest; if receipt already exists, return duplicate without creating another reply.
4. Return HTTP 200 only after the receipt and reply (if applicable) are durably committed.
5. A dispatcher claims due replies, sends through the fixed MAX adapter, then records success/failure with the lease token.
6. The periodic dispatcher runs independently of webhook redelivery. It also reclaims expired leases after process restarts.

The current recordMaxWebhookEvent() API cannot satisfy step 3 because it records only the receipt. Replace it with a combined transactional method (or extend it to accept a validated reply object) rather than doing two independent writes.

## Dispatcher and observability

- Run an immediate bounded dispatch pass after enqueue as a latency optimization, but correctness must depend on the periodic dispatcher.
- Run every 10–30 seconds with a small batch (for example 20); never let a slow MAX API call hold a YDB transaction open.
- Persist only normalized error codes such as max_rate_limited, max_server_error, max_network_error, max_request_rejected.
- Emit counters for claimed, sent, retried, dead-lettered and stale-lease completions. Logs must not include response text, token, raw webhook JSON or customer details.
- Add an authenticated operator-only view/action for dead replies in a later UI slice; do not add a public endpoint.

## Required tests before PR is mergeable

1. New webhook event + command creates exactly one receipt and one outbox row atomically.
2. Duplicate webhook creates no second outbox row.
3. A crash/failure after enqueue leaves a row claimable by the periodic dispatcher.
4. MAX network/5xx/429 failure schedules a retry; non-retryable 4xx becomes terminal according to policy.
5. Expired lease can be reclaimed; old lease token cannot complete or fail the new lease.
6. Successful send marks sent; repeated webhook cannot resend a completed command.
7. Attempt ceiling moves the row to dead; retention never removes queued/sending rows.
8. Unauthorized sender, wrong group, bot-origin message and malformed command create no reply.
9. Help/status reply and audit data contain no customer name, phone, vehicle or comment.
10. Schema verification fails closed when table or either index is absent.

## Acceptance boundary

This is an implementation contract only. Do not merge PR #79, deploy the standby service, create production YDB tables, change webhooks/secrets, or switch customer traffic until the implementation, complete test suite, CI evidence, MAX API contract verification with a test bot/group, and independent security review are all complete.
