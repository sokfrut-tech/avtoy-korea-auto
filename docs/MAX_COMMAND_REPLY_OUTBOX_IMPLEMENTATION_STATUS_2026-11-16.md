# MAX command reply outbox — implementation status (2026-11-16)

## Current implementation

PR #81 contains the first runtime implementation slice on branch:
feature/max-command-reply-outbox-implementation-2026-11-16

Implemented in source:
- YDB table standby_max_command_replies with due-work and expired-lease global indexes.
- Read-only verifySchema probes for the outbox table and both indexes.
- External migration at standby/migrations/2026-11-16-max-command-reply-outbox.sql.
- recordMaxWebhookEvent(event) accepts an optional validated reply and inserts webhook receipt, outbox row and allowlisted operator audit row in one serializable read-write transaction.
- Duplicate webhook receipt prevents a second reply row and second audit row.
- claimDueMaxCommandReplies() uses short transactions, lease tokens and expiry recovery.
- completeMaxCommandReply() and failMaxCommandReply() fence updates by lease token.
- Retry schedule is capped and bounded; terminal failures are marked dead.
- pruneMaxCommandReplies() only deletes old sent rows in bounded batches.
- MAX webhook now queues replies; it no longer performs the outbound API call inline.
- A 15-second background dispatcher sends to the fixed configured operator group and records completion/failure.
- Help/status reply content excludes customer PII; status command whitespace parsing was corrected.
- Added storage and server dispatcher tests, plus a dedicated GitHub Actions validation workflow.

## Verification status

- The YDB index declarations were checked against the official YDB YQL syntax and moved inside CREATE TABLE as GLOBAL SYNC INDEX definitions. References: https://ydb.tech/docs/en/yql/reference/syntax/create_table/secondary_index and https://ydb.tech/docs/en/yql/reference/syntax/create_table/.
- GitHub Actions created runs for PR #81, but the observed jobs finished before assigning a runner: job payloads show runner_id=0, empty runner name and steps=[]. The workflow log download was unavailable (BlobNotFound). These runs do NOT establish that tests executed or failed in the code. Do not report the suite as passed.
- Tests are authored but remain unverified. A local Node runner is available in the working environment, but the private repository source could not be mounted into that runner through the available GitHub connector path in this session.

## Remaining blockers

1. Obtain an actual GitHub Actions runner/job log or run the same node --test command in an authorized local/Factory runner.
2. Review YDB DDL/index syntax against the target YDB version and apply the migration only through a separately privileged schema-migration identity.
3. Run schema verification using the production runtime identity with least privilege.
4. Verify MAX outbound message API and webhook behavior with a dedicated test bot and private test group.
5. Test duplicate/timeout/crash boundaries, including the at-least-once duplicate-send window after MAX accepts a message but before YDB records completion.
6. Independent security review before merge.

## Safety boundary

PR #81 remains draft. PR #79 remains draft. PR #80 remains a documentation contract. No production Worker, YDB database, webhook, DNS, secrets, Telegram traffic or MAX customer traffic was changed. No client reply workflow is implemented. Do not merge or deploy until all blockers above are closed and explicit production approval is obtained.


## Follow-up review (2026-11-16 18:18 UTC)

- Corrected operator audit target classification: `!help` / invalid group commands are recorded with target_type=`group`; `!status` is recorded with target_type=`request` and the request UUID.
- Updated the outbox storage test fake to preserve all audit columns and added assertions for both group- and request-scoped audit targets.
- Latest source head after these review fixes: `20af5950f7350f416eeba2bc4ec1ca6b1114f8b6`.
- Validation rerun `43927408005` again terminated before a runner step was recorded; steps are empty. This remains infrastructure/runner unavailability, not a test result.

- Manually re-ran the failed validation job (job `133510416845`) using GitHub's job re-run action. Attempt 2 produced job `133512291578`, which again completed as failure with no step list and no downloadable logs (`BlobNotFound` on log retrieval). This confirms retrying the same hosted job does not restore a runner; no test process started.
- Reviewed the workflow definition: it uses standard `ubuntu-latest`, Node 22, syntax checks, then the full standby test glob. No workflow-level custom runner labels or external services are configured.

## Additional MAX adapter review (2026-11-16 18:23 UTC)

- Found a real source defect in the durable reply sender: its control-character sanitizer used an over-escaped regular-expression character class. Replaced it with the intended Unicode control ranges so ordinary reply text is preserved and control characters are replaced with spaces.
- Added a regression test that exercises `sendOperatorMessage`, asserts the configured operator chat is the only destination, and checks sanitization of control characters.
- Commits: `97449ca9a9d21f129ddeff0fbd33a246b5c80553` (fix), `4f56a0e2405670f74799d3eee2435fd6c5873e94` (test).
- Workflow for the latest head is queued as run `43928262889`; prior attempts still show runner startup failures. The new test has not yet executed; do not treat the source fix as validated until an actual test log is available.

- Cross-checked the MAX sender against the current official MAX API reference: the documented host is `platform-api2.max.ru`; `POST /messages` accepts `chat_id` as a query parameter, uses `Authorization: <access_token>`, and supports message text up to 4000 characters. This confirms the adapter's host, endpoint, destination parameter and auth header; it does not replace a live bot/group integration test. Source: https://dev.max.ru/docs-api/methods/POST/messages
- Latest validation run after the sanitizer test and status-doc update (`43928324080`) again completed as failure with no job steps and no logs. No test code ran.

## Per-chat rate limiting and Retry-After (2026-11-16)

- Official MAX `POST /messages` documentation states a maximum of two messages per second to one dialog/group/channel and explicitly recommends queueing or delaying sends when the limit is reached: https://dev.max.ru/docs-api/methods/POST/messages (checked 2026-11-16).
- `standby/channels/max-adapter.mjs` now serializes every outbound message path (operator replies and notifications) through one per-adapter queue, with a configurable minimum 550 ms between request starts (safe margin below the 500 ms platform minimum). Concurrent calls cannot race past the limiter.
- The adapter parses numeric or HTTP-date `Retry-After` on HTTP 429 and returns a bounded `retryAfterMs` without exposing response bodies or credentials.
- `standby/server.mjs` passes the server-provided delay into the durable outbox retry schedule, with a 5-second minimum and 15-minute maximum delay. Normal exponential retry remains bounded.
- Added adapter tests for concurrent mixed-path sends and Retry-After parsing, and dispatcher test asserting a 12-second Retry-After is persisted as the retry base.
- Changes are authored but not yet executed by a functioning test runner. GitHub Actions has repeatedly failed before runner startup; do not report these tests as passing.

- Latest head after the rate-limit implementation and handoff update: `0cde0def50b9a14f79504374db839bf56323f1fe`. Latest dedicated validation run `43928818934` failed before runner allocation: job `133515422755` has `runner_id=0`, empty runner name and `steps=[]`; no test process started. Related secret-scanning and CodeQL jobs in run `43928817062` also failed before steps. This is still a hosted-runner/infrastructure blocker, not a test failure or a pass.

## Idempotency boundary and latest runner evidence (2026-11-16)

- Reviewed the current MAX `POST /messages` contract and general API error documentation. The documented request schema exposes no idempotency-key parameter; a successful response returns a created message object. The documented HTTP error set includes 429 for rate limiting. Sources: https://dev.max.ru/docs-api/methods/POST/messages and https://dev.max.ru/docs-api.
- Therefore the outbox can guarantee idempotent webhook enqueue and lease-fenced state transitions, but cannot claim exactly-once external delivery. A crash after MAX accepted a message but before YDB stores `sent` can still result in a duplicate on retry. This remains explicitly at-least-once until MAX documents an idempotent send key or a safe reconciliation strategy is implemented.
- Latest dedicated validation run `43928918187` and security run `43928918716` both failed before runner allocation. Jobs `133515772767` (Secret scanning), `133515773104` (CodeQL), and the dedicated `validate` job all have `runner_id=0`, empty `steps=[]`; no commands ran. This is not evidence of source/test failure and is not a pass.
- Current branch head at this documentation update: `e7e008160bd48947556ef611cc3ee79488591a68`.

## Focused local adapter verification (2026-11-16)

- Because hosted GitHub Actions still fails before runner allocation, copied the exact current PR versions of `standby/channels/max-adapter.mjs` and `standby/channels/max-adapter.test.mjs` into an isolated temporary Node 22.16.0 directory and ran:
  - `node --check max-adapter.mjs` — passed.
  - `node --test max-adapter.test.mjs` — 8 tests passed, 0 failed.
- This directly verifies the MAX adapter module and its full adapter test file, including fixed-group delivery, privacy, sanitization, concurrent rate limiting and Retry-After parsing. It does NOT execute `standby/server.mjs`, YDB storage tests, the full standby suite, GitHub security scans, a live MAX API call, or a database migration.
- The isolated temporary directory is only a verification copy; no repository files outside the GitHub feature branch or production systems were changed.
- Current branch head at the time of this note: `e7e008160bd48947556ef611cc3ee79488591a68`.

- After the focused local adapter run, the dedicated hosted workflow for final head `3327871eb8fc5a7f18e047a36fcfb14778c843eb` again failed before runner allocation: run `43929159173`, job `133516625508`, `runner_id=0`, `steps=[]`. The local 8/8 adapter result is the only new executable evidence; dispatcher/YDB/full-suite/security jobs remain unverified.

## MAX webhook group-type fail-closed check (2026-11-16)

- Official MAX Update/Recipient schema defines `message.recipient.chat_type` with explicit values `chat`, `channel`, and `dialog`; group events should carry `chat_type: chat`. Source: https://dev.max.ru/docs-api/objects/Update/.
- Removed a permissive fallback that treated a top-level `update.chat_id` as proof of group type when `message.recipient.chat_type` was absent. The webhook now requires the explicit recipient chat type to equal `chat`, in addition to the configured chat ID and operator allowlist.
- Added a regression test: a payload with the configured top-level chat_id but no recipient.chat_type is rejected with HTTP 403 and is not persisted.
- This is a source/test change only; hosted runner remains unavailable, so the new server regression test has not executed.

- Follow-up test-fixture review caught and corrected a declaration-order mistake in the new strict-chat-type regression test: `writes`, request headers and the baseline payload are now initialized before use. Commit: `3cf8d86cea9a9df566048acb612a5d4d3ff44010`. The corrected server test remains unexecuted because the hosted runner still fails before steps.


## Follow-up test correction and retention review (2026-11-16)

- Corrected the MAX webhook metadata test: it now sends an ordinary non-command message and asserts the current response contract (`command: ignored`, `queuedReply: false`) instead of sending malformed `!status 12345678` and expecting the obsolete minimal response. Commit: `bce4a70c89f219a443d30a45e5972838484b5572`.
- Updated `docs/CONTINUATION.md` with the change and verification boundary.
- Fresh exact-head validation run: `43933216572`, head `38aba1051a7c251fa108294002e102cd86b03d6c`. Attempt 1 failed before steps; retry attempt 2 also failed before runner allocation (job `133531207668`, empty steps; previous attempt job likewise had no steps). No tests executed. The focused adapter result 8/8 remains the only executable test evidence.
- Static retention finding: `recordMaxWebhookEvent` uses the webhook receipt as its primary deduplication fence and the reply outbox primary key as a second fence while that row exists. `pruneMaxWebhookEvents` and `pruneMaxCommandReplies` can eventually remove both records for the same digest (the outbox pruner removes old `sent` rows). A very old replay after both records are pruned can therefore be accepted again. This is a finite deduplication horizon, not permanent replay protection. Before enabling automated pruning, align the two retention periods and decide whether to retain compact deduplication tombstones for a longer, explicitly defined replay horizon.
- No YDB migration, live MAX test, merge, or production deployment performed.


## Exact-head CI and retention decision (2026-11-16 19:36 UTC)

- Exact reviewed head: `fff0ce32c32d259c817dc03c5ee891ced2de0515`.
- Dedicated validation run `43940568229` and Factory Security Baseline run `43940568369` both concluded `failure`; the returned jobs (`133556665115`, `133556665222`, `133556665727`) have empty step lists. Fetching the job logs returned `BlobNotFound`. No test, CodeQL or secret-scanning command is evidenced as having run. This is a runner/log infrastructure failure, not a code-test result and not a pass.
- Reconfirmed `pruneMaxCommandReplies()` and `pruneMaxWebhookEvents()` have no runtime callers. The 15-second timer only dispatches enquiry notifications and MAX command replies. Retention is therefore manual-only; the presence of bounded prune functions does not mean the service performs automatic cleanup.
- No retention duration or replay horizon has been approved. Do not invent a default or add a destructive scheduled delete. Before enabling automatic cleanup, the owner must choose the retention and replay horizon, and engineering must preserve replay deduplication (potentially with compact tombstones) across receipt/outbox pruning. Keep queued/dead outbox rows and never prune them as part of routine retention.
- Decision for this PR: leave runtime behavior unchanged; explicitly document retention as manual-only and remove any implication that it runs automatically. This avoids silently deleting audit/deduplication evidence without an approved policy.
- MAX callback payload review remains static: current test uses `callback.user.user_id` and `message.recipient.chat_id/chat_type`; no live test-bot webhook exchange has been performed. Keep callback acceptance behind the configured webhook secret, fixed group check and operator allowlist.
- PR #81 remains draft. No migration, merge, production deployment, webhook registration or customer traffic was changed.


## MAX callback schema regression coverage (2026-11-16)

- Rechecked the current official MAX Update schema. For `message_callback`, the actor is `callback.user.user_id`; the original `message` is nullable and, when present, contains the recipient (`chat_id`, `chat_type`). The callback event is delivered through Webhook. Source: https://dev.max.ru/docs-api/objects/Update/.
- Added two server regression tests in commit `09fc97c06d21e6bcdcdb9cebd71dacbc5c0371ab`: (1) callback with `message: null` / no recipient context must return 403 and persist nothing; (2) allowlisted operator callback addressed to `chat_type: channel` must return 403 and persist nothing. This supplements the existing valid callback test and strict group-type checks.
- The tests are authored but not executed. A commit-associated workflow run was not yet visible when checked. Do not report these tests as passing until a runner executes the full standby test command.
- PR #81 remains open/draft. No live webhook or MAX group was contacted.
