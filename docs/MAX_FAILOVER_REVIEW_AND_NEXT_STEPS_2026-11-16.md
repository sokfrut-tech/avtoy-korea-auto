# AVTOY KOREA — MAX failover review and continuation
Date: 2026-11-16
Branch reviewed: `factory/max-failover-test-2026-11-15`

## Scope and safety
This is a source review of the isolated Russian standby/MAX failover prototype. No production Worker, DNS, Telegram webhook, Cloudflare resource, YDB production database, MAX bot, or operator group was changed or provisioned. Do not merge or deploy from this review.

## Confirmed implementation in this branch
- `standby/server.mjs`: request intake, Telegram-first delivery with MAX fallback, authenticated MAX webhook, durable YDB request-store startup guards, operator inbox/audit routes, retry loop.
- `standby/channels/max-adapter.mjs`: sends only to the configured operator chat; message contains short request ID and model only, not customer name/contact/comment.
- `standby/security/operator-auth.mjs`: token-hash authentication and viewer/operator/supervisor/owner permission map.
- `standby/storage/ydb-request-store.mjs`: durable enquiry queue, leases, webhook event deduplication, audit/rate-limit tables, and bounded prune methods.
- `standby/public/ops.html`: private inbox UI, contact display, call/SMS links, manual retry and audit view.

## Blocking gaps found in source review
1. **MAX inbound events are recorded but not acted on.** `receiveMaxWebhook` validates the group and sender allowlist, stores a digest, and returns duplicate status. It does not yet parse an operator command/reply, associate it with an enquiry, or send a client response.
2. **The operator panel cannot reply to clients.** UI explicitly says automatic Telegram/MAX replies and conversation history are not connected. No authenticated reply endpoint is present in the inspected server routes.
3. **Operator management is not implemented.** Roles include `operators:manage` and `retention:manage`, but no routes/UI for adding, disabling, rotating, or assigning operators were found in the inspected server and panel.
4. **Retention is not scheduled or exposed.** The YDB store has bounded `pruneMaxWebhookEvents`, `pruneOperatorAuthRateLimits`, and `pruneOperatorAuditEvents` methods, but the server's periodic timer only calls `retryDue()`. No retention policy, retention endpoint, or scheduled cleanup is wired in.
5. **Privacy boundary needs end-to-end tests.** The MAX notification text is intentionally minimal; tests must prove customer contact/name/comment never appear in outbound group messages, and that unauthorized group members/events cannot retrieve or mutate enquiries.
6. **Delivery semantics need review.** The delivery function marks the operator notification complete after Telegram admin delivery or MAX notification. MAX webhook receipt currently has no workflow to mark operator actions as handled or notify a client. Add tests for partial Telegram delivery followed by MAX fallback and duplicate retries.
7. **Production schema process remains external.** Production startup requires `INBOX_STORE=v2`, YDB connection, externally managed schema, and read-only verification. A reviewed migration and least-privilege runtime identity are still required.

## Next implementation sequence
1. Add an explicit, privacy-safe MAX command/reply protocol with strict operator allowlist, request ID lookup, permission checks, idempotency, and audit records. Do not allow arbitrary chat IDs or arbitrary client destinations.
2. Add authenticated panel reply endpoint and UI. Route client replies only through a verified client channel/identity; never infer a Telegram/MAX destination from free-form contact text. If a client has only a phone number, keep manual call/SMS actions until a compliant outbound provider and consent flow are configured.
3. Add operator assignment and lifecycle management with owner-only permission, token rotation/disable, and audit logging. Do not store raw operator tokens.
4. Wire bounded retention jobs for webhook receipts, auth rate limits, and audit events with explicit configurable retention periods; protect audit records and customer enquiries under separate retention policies.
5. Add tests for authorization matrix, webhook signature/secret, wrong group, unauthorized sender, duplicate webhook, replay, message-size limits, privacy-safe notifications, assignment, replies, retention cutoffs, and delivery partial failures.
6. Run the complete exact-branch test suite and independent security review. Require green executable CI evidence, not merely a workflow object with no runner/steps.
7. Only after user approval: provision Russian HTTPS host and YDB, register MAX bot and closed operator group, configure secrets outside Git, run controlled end-to-end tests, and separately approve DNS/webhook/production cutover.

## Existing constraints retained
- Telegram remains primary; MAX is a reserve channel.
- MAX operator group is closed.
- Customer personal data must not be posted in the group.
- Russian administrators need a durable private queue.
- No production change without explicit approval.
