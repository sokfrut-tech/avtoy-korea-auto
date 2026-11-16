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
