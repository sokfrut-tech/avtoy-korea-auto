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

GitHub Actions created runs for PR #81, but the observed jobs finished with failure before assigning a runner: job payloads show runner_id=0, empty runner name and steps=[]. The workflow log download was unavailable (BlobNotFound). Therefore these runs do NOT establish that tests executed or failed in the code. Do not report the suite as passed.

No local test runner was available in this tool session. Tests are authored, not verified.

## Remaining blockers

1. Obtain an actual GitHub Actions runner/job log or run the same node --test command in an authorized local/Factory runner.
2. Review YDB DDL/index syntax against the target YDB version and apply the migration only through a separately privileged schema-migration identity.
3. Run schema verification using the production runtime identity with least privilege.
4. Verify MAX outbound message API and webhook behavior with a dedicated test bot and private test group.
5. Test duplicate/timeout/crash boundaries, including the at-least-once duplicate-send window after MAX accepts a message but before YDB records completion.
6. Independent security review before merge.

## Safety boundary

PR #81 remains draft. PR #79 remains draft. PR #80 remains a documentation contract. No production Worker, YDB database, webhook, DNS, secrets, Telegram traffic or MAX customer traffic was changed. No client reply workflow is implemented. Do not merge or deploy until all blockers above are closed and explicit production approval is obtained.
