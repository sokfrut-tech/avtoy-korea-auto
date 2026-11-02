# AVTOY KOREA — continuation handoff

Updated: 2026-10-31 15:20 UTC
Repository: `sokfrut-tech/avtoy-korea-auto`
Active work branch: `feature/numbered-private-order-workflow`
Current change commit: `17487a188ec0f0f3c662f0df80f8b0d909c2f353`
Pull request: [#12 — Add numbered order cards and admin-only client details](https://github.com/sokfrut-tech/avtoy-korea-auto/pull/12)

## Current state
- The PR is open and has not been merged.
- Production Cloudflare Worker deployment was not performed.
- The separate AppDeploy AVTOY deployment is a different runtime and must not be treated as proof that the Cloudflare Worker or Telegram bot is healthy.
- The PR adds numbered website orders, private admin details, admin accept/complete states, and group-media review moderation.
- Customer contact details are omitted from the initial admin order card and are returned only after an authorized admin presses the private-details control in a private bot chat.
- Review media from the configured group is staged for private admin moderation; it is not published automatically.

## Defect found and fixed
The order callback parser used a double-escaped digit pattern in both `ord:` and `ordinfo:` callbacks. Numeric order IDs therefore did not match; the private-details action failed.
- Fixed both patterns in `worker.js` to use a single digit matcher.
- Regression test already existed: `only an admin can request private order details; admin can accept and finish`.
- Before fix: 49/50 tests passed; that test failed when the admin could not retrieve the stored contact.
- After fix: all 50/50 tests passed.

## Verification evidence
- GitHub Actions run [Cloudflare Worker checks #90](https://github.com/sokfrut-tech/avtoy-korea-auto/actions/runs/41214339908): completed successfully; syntax and private-admin routing test step passed.
- GitHub Actions run [AVTOY Korea — Factory Review #9](https://github.com/sokfrut-tech/avtoy-korea-auto/actions/runs/41214340234): completed successfully.
  - Functional/regression suite: passed (50 tests, 50 passed, 0 failed).
  - Security/privacy job: only confirms required source files exist; it is not a comprehensive security audit.
  - Director/release evidence job: uploaded the factory handoff artifact.
- Push-triggered Factory Review run [#8](https://github.com/sokfrut-tech/avtoy-korea-auto/actions/runs/41214334111): completed successfully.

## Not yet verified
- Live Worker HTTP response and homepage rendering.
- Live Telegram `/start`, message routing, callback buttons, and admin delivery.
- Actual webhook URL and `X-Telegram-Bot-Api-Secret-Token` registration.
- Cloudflare `REVIEWS` KV binding and persistence.
- Cloudflare WAF/rate-limit rules.
- End-to-end website form submission against the live Worker.
- Mobile browser rendering and review media retrieval.

## Required configuration checks before release
- Cloudflare Worker secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_IDS`, `TELEGRAM_WEBHOOK_SECRET`; values must remain private.
- Cloudflare KV binding named `REVIEWS` must point to a persistent namespace. The code intentionally rejects website requests if the required store is unavailable.
- Telegram webhook must target the production Worker endpoint `/telegram/webhook` and use the configured webhook secret.
- Confirm admin IDs are positive personal Telegram user IDs, never a group ID.
- Configure rate limiting carefully for `POST /api/request` and avoid blocking Telegram webhook retries.

## Next actions
1. Wait for all checks on PR #12 and inspect the final combined diff.
2. Verify the live Cloudflare Worker, KV binding, secrets, and webhook without exposing secret values.
3. Test `/start`, ordinary customer messages, website requests, private admin details, accept/complete callbacks, and review moderation.
4. Only after the user approves, merge PR #12 and deploy the Worker; then repeat live smoke tests.


## Production baseline and webhook notes
- The latest observed Cloudflare deploy workflow on `main` was run [#17](https://github.com/sokfrut-tech/avtoy-korea-auto/actions/runs/41164162865), successful at 2026-10-31 03:23 UTC, for production commit `cfae5aaa4b3a00e3c11060467973cd224ccd0721`.
- The deployment workflow runs only on pushes to `main`; this feature branch and PR #12 have not been deployed.
- The production `main` Worker requires the `X-Telegram-Bot-Api-Secret-Token` header to equal `TELEGRAM_WEBHOOK_SECRET` and returns 503 if bot configuration is missing.
- The README documents manual Telegram webhook registration to `https://avtoy-korea-auto.sokfrut.workers.dev/telegram/webhook` with the matching `secret_token`. The Worker code does not self-register the webhook.
- The production Worker and PR code require the persistent `REVIEWS` KV binding for order persistence. Its actual Cloudflare binding is not confirmed from repository CI.


## Independent static audit — 2026-10-31 15:25 UTC
- Current `main` SHA observed: `cfae5aaa4b3a00e3c11060467973cd224ccd0721`; PR #12 base SHA is the same. The PR metadata reports `mergeable=true`. A direct compare endpoint was unavailable, so an exact ahead/behind count has not been independently confirmed.
- Production Cloudflare deployment workflow #17 completed successfully for main SHA `cfae5aaa4b3a00e3c11060467973cd224ccd0721`; the job confirmed GitHub Actions deployment secrets were present and the Wrangler deploy step succeeded. This does not confirm Cloudflare Worker runtime secrets, KV binding, Telegram webhook state, or end-to-end operation.
- AppDeploy AVTOY app `avtoy-korea-e55k1k` separately reports `ready`; QA snapshot shows no frontend/network/backend errors. This is a different origin/runtime from the Cloudflare Worker and must not be used as proof of Worker/Telegram health. AppDeploy secret-name inventory shows the Telegram variable names exist there, but values are intentionally hidden and are not Cloudflare Worker secrets.
- Direct HTTP GET verification of both public origins could not be completed from this execution environment (DNS/network resolution unavailable); this is an environment limitation, not evidence that the sites are down.
- The Cloudflare Worker README documents a manually registered Telegram webhook at `/telegram/webhook`. No safe read-only webhook diagnostic route was found in the Worker source. Do not use a route that calls Telegram `setWebhook` or sends admin test messages without explicit approval.
- Confirmed code-level reliability risk: `stageGroupMedia()` stores `import_pending` before notifying admins and silently returns on retry if that key exists; if notification fails, the item can remain staged without admin notification. `handleImportChoice()` deletes `import_pending` before the review conversion/notification completes, so a later failure can lose the retry path. Add stateful delivery/retry handling and failure-injection tests.
- Confirmed feature gap: private admin photo/video uploads to the bot are not handled by the private-message path; media intake currently relies on the configured review group. Decide/implement a private admin upload + preview + publish/cancel flow if direct upload remains required.
- Factory security lane currently only checks that source/test files exist; it is not a security/privacy audit. Functional suite includes 50 regression tests, but needs failure-injection coverage for review notification retry, import-choice failure, concurrent callbacks, and bind-token write/Telegram failure ordering.
- Independent Claude review requested in PR conversation; no Claude response observed yet at this timestamp.

## Outstanding release blockers
1. Confirm Cloudflare runtime bindings/secrets (`REVIEWS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_IDS`, `TELEGRAM_WEBHOOK_SECRET`) without revealing values.
2. Safely verify Telegram webhook URL and secret configuration through Cloudflare/Telegram account access; do not mutate webhook during diagnosis.
3. Perform live smoke tests for homepage, `/api/cars`, one controlled test order, private admin delivery, and `/start`; do not use real customer data.
4. Fix and test review-media retry loss; decide whether direct private admin media upload is required and implement it if so.
5. Replace the placeholder security job with meaningful privacy/security regression tests.
6. Keep PR #12 open until these checks and the independent review are complete. No merge or new production deploy has been performed.


## Follow-up fixes and verification — 2026-10-31 15:28 UTC
- Source branch changes through commit `b5cab88d5b88db985f04ea0cf7af1fcfa404b6ee`:
  - Group review-media notifications now persist per-admin media/card delivery state and retry missing sends.
  - Import choice keeps the staged source until moderation conversion and admin notifications complete.
  - Imported review moderation stores per-admin delivery progress and resumes missing sends after failure.
  - Admins can send photo/video directly to the bot in a private chat; the bot creates a private moderation card. Forwarded channel posts continue through the separate channel-import flow.
  - One-time Telegram bind token is deleted only after both order indexes are saved and the confirmation message succeeds, allowing Telegram retries after partial failures.
- Added regression tests for group media retry, import retry, direct admin upload, non-admin upload rejection, and binding retry after partial KV failure.
- Latest Worker checks [#105](https://github.com/sokfrut-tech/avtoy-korea-auto/actions/runs/41215004691): syntax passed; full suite reports 56 tests, 56 passed, 0 failed.
- Factory Review workflow has been upgraded: the security/privacy job now runs targeted regression tests for private delivery, admin-only callbacks, review media boundaries and retry behavior rather than only checking source file presence. Factory Review [#40](https://github.com/sokfrut-tech/avtoy-korea-auto/actions/runs/41215035516) completed successfully; Worker checks [#107](https://github.com/sokfrut-tech/avtoy-korea-auto/actions/runs/41215035583) completed successfully, with 56/56 tests passing.
- Transient CI failures during development were corrected: forwarded channel media is explicitly excluded from the direct-upload handler; the bind-token regression test now creates the initial order under Telegram API mocks. The latest full suite is green.
- Claude was tagged in PR #12 for an independent review; no Claude reply was visible as of this update.

## Remaining release checks
- Live HTTP verification of the Worker/AppDeploy origins was blocked by DNS/network resolution from this execution environment; no conclusion about user-side availability can be drawn from that failure.
- Cloudflare runtime Worker secrets and the `REVIEWS` KV binding are not visible through GitHub Actions. The deploy workflow confirmed only that its GitHub Cloudflare deploy credentials were present.
- Telegram webhook URL/secret registration, actual `/start` delivery, controlled form submission and admin inbox delivery remain unverified. Do not change webhook or send admin test notifications without explicit user approval.
- PR #12 remains open. No merge, production deployment, secret change, or webhook mutation has been performed.

- Final PR head at 2026-10-31 15:29 UTC: `643b110e187ad764c2cd02e8c0be4b75e6ee84a9`; current main/base SHA remains `cfae5aaa4b3a00e3c11060467973cd224ccd0721`. PR #12 remains open and mergeable, not merged. No production deployment, webhook change, or secret mutation was performed.

## 2026-10-31 — responsive tile-based website refresh
- User confirmed the Cloudflare Worker site opens on their phone and requested a more attractive mobile layout, with compatibility across phones, tablets, and desktop.
- Updated the embedded homepage CSS in `worker.js` on `feature/numbered-private-order-workflow` (commit `4c9d2750dd4e14bea3f37dd635825d5d67b1f05c`).
- Added responsive breakpoints for compact phones (<=340px), phones (<=420px), mobile/tablet (<=780px), tablet/small desktop (781–1100px), and wide desktop.
- Improved tile/card surfaces, spacing, typography, touch target sizing, focus-visible state, image aspect ratio and mobile hero sizing; kept existing content, forms, Telegram actions, and API routes unchanged.
- Mobile catalogue/review cards now retain readable text rather than hiding car details; form fields use two columns on most phones and one column on narrow screens.
- No live Worker deployment, merge, webhook change, or secret mutation performed. User approval is needed before publishing the branch to production.
- Verification: Cloudflare Worker checks #109 succeeded (`41215441345`); Factory Review #44 succeeded (`41215441332`) with functional/regression, security/privacy and director/release-evidence jobs all green. Automated tests do not replace visual checks on real phone/tablet/desktop browsers.
- Next: inspect workflow results, review CSS for regressions, then request explicit approval before production deployment. After deployment, ask user to refresh the site and inspect mobile layout.

## Production release — 2026-10-31 15:36 UTC
- User explicitly approved publishing the responsive tile-based site update.
- PR #12 was squash-merged into `main`: https://github.com/sokfrut-tech/avtoy-korea-auto/pull/12
- Merge commit: `00e1a00ab55cf20256706f90dbfd9991849610e2`.
- `main/worker.js` now contains the responsive CSS update (content SHA `1028177c914b130e722f9440ce6336c22deaa271`).
- Pre-merge validation on the exact PR head `34d4d5567cb8453b0187a52d0c8b443b92b20841`: Cloudflare Worker checks #111 succeeded; Factory Review #48 succeeded (functional/regression, security/privacy, and release-evidence jobs).
- The repository deploy workflow is configured to deploy `worker.js` automatically on pushes to `main`, using GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The merge should trigger that workflow; however, this environment's GitHub connector does not expose push-triggered workflow-run listing, so the actual deployment run/result is not yet independently confirmed here.
- Live Worker URL open check through the available web fetch was inaccessible; this is not evidence of a site outage and does not prove the new version is live.
- No Telegram webhook or secret values were changed. Live Telegram `/start`, website form submission, KV binding, and device/browser visual checks remain unverified.
- Next: confirm the GitHub Actions deploy workflow completed successfully, then refresh the live site on phone and test tablet/desktop layouts; run a controlled Telegram smoke test only after the live deployment is confirmed.


## Review-photo quality guard — 2026-11-02
- Branch: `fix/review-photo-quality-guard-2026-11-02`
- Base: `main` at `ca4ea5cdee27fd6b1ace1c3018d4437af75a5ddf`
- Implemented: Telegram photo rendition selection now ranks by pixel area, then `file_size`, rather than assuming the last PhotoSize is largest; selected rendition metadata is preserved.
- Implemented: review-media responses use `Cache-Control: no-store` to prevent stale content being served under an unchanged album index URL.
- Added regression tests for reversed PhotoSize ordering and file-size fallback.
- Added permanent review-media quality/duplicate-prevention rules to README and AGENTS.md.
- Verification passed on PR commit `2ac992027600133c7e8a1a5b66bd7a0bf6610e59`: syntax check, full Worker regression suite, privacy regression suite, Cloudflare Worker checks, and Worker tests all succeeded. Factory Review run `41469701274` completed green; it is CI evidence, not an independent AI audit.
- No production KV, secrets, webhook, merge, or deployment changes.
- Deployment workflow run `41469701365` completed with `Deploy website Worker` skipped (pull_request event); no production deployment occurred.
- Independent Claude review was requested in PR #46; no Claude response was present at the last check.
- Still unverified: production KV contents, real browser screenshots, CDN behavior outside the Worker response headers, actual production Telegram rendition quality, and whether historic duplicate records already exist.
- Next: obtain independent review if available; inspect live website and production KV through authorized read-only access; only then decide whether any historic records need manual correction. No global cross-review deduplication is permitted without owner approval.


## Group-review duplicate path found and fixed — 2026-11-02
- Additional confirmed code defect: admin media from the configured review group passed through both `stageGroupMedia()` and `handleReviewSubmission()`; an admin message with `/review` could create a staged import and a separate pending review. Also, group album parts were keyed by individual `message_id`, not shared `media_group_id`, so one album could create multiple moderation entries.
- Fix in current branch: route admin group media through one staged-import path only; group admin albums use the shared media_group_id, are serialized by the existing AlbumSerializer Durable Object, and merge unique photos into one import record/card. Preserve separate customer `/review` handling.
- Added regression tests for concurrent admin group album parts, repeated media within the same album, one moderation card per admin, and prevention of the duplicate admin `/review` path.
- The additional group-album changes have been committed to the PR branch; CI rerun is pending.


## Final CI evidence for group album fix — 2026-11-02
- Latest source/docs commit before this handoff: `738fa6616fffc9bddf323da72ba01c9f7c286cbe`.
- Worker tests run `41470370392`: success.
- Cloudflare Worker checks run `41470370052`: success.
- AVTOY Korea — Factory Review run `41470370452`: success (functional/regression and selected privacy test jobs passed).
- Deploy workflow run `41470370405`: success with deployment-secret check and `Deploy website Worker` skipped for the pull_request event; production unchanged.
- PR #46 remains open; no merge or production deploy.
- No independent Claude comment was present at final review; request remains in PR conversation.
