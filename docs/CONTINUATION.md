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


## AVTOY KOREA repair continuation — 2026-11-10 19:45 UTC
- Active branch: `fix/avtoy-site-catalog-and-admin-ux-2026-11-10`.
- Base: `main` after warranty-removal PR #59 was squash-merged as `33615f1610843562424b02afdc1a6ba760c06495`.
- Changes under development:
  - `worker.js`: published items in `/site` now have separate edit-text and unpublish controls; admins can remove/replace/append an exact text fragment on an already-published car/review without altering its media or other listings.
  - `worker.js`: `/admin` opens a concise admin guide; `/catalog` points to the real live website catalogue instead of incorrectly claiming there is no catalogue.
  - `worker.js`: catalogue section copy is clarified; API errors now show a visible retry control and empty catalogues show an explicit empty state instead of silently leaving a placeholder.
  - `/api/cars` now returns HTTP 503 when the `REVIEWS` KV binding is missing instead of silently returning an empty list.
  - Vehicle photo galleries now appear before the description, with a clear per-car enquiry action.
  - `worker.test.mjs`: added tests for the live catalogue link, published car text editing/media preservation, and visible catalogue retry state.
  - `README.md`: update admin and catalogue operating instructions.
- Latest source commit: `889bb59fd44f99dde063e666275598022c0babbd`; latest tests commit: `dde5551a2fdc92b089bf1b9f3ac806c0030433c5`; workflow trigger commit: `8817d55538771681f81498ef70641619aad9dae1`.
- Verification: regression tests added, including a missing-KV 503 check and gallery order/CTA checks. The GitHub connector currently reports no PR-triggered workflow runs or commit status contexts for this head, so syntax/full-suite/Factory Review completion is not yet independently confirmed.
- Runtime status: live Cloudflare Worker response, live /api/cars payload, Telegram webhook registration, KV contents and real device rendering remain unverified. No production Worker deploy, webhook change, KV mutation, or secret change was performed by this branch.
- Known product gap: there is not yet a browser-based website admin console. Published text editing and unpublishing are safely available through the private Telegram admin `/site` workflow; a web console requires a separately designed admin authentication/session boundary before it can expose destructive actions.
- Next: obtain exact-head CI evidence and inspect exact diff, then present PR and clear admin steps. Do not deploy or merge without explicit confirmation.


## Additional catalogue diagnosis — 2026-11-10 20:05 UTC
- Confirmed silent failure mode: `GET /api/cars` previously returned HTTP 200 with an empty `cars` array when the `REVIEWS` KV binding was absent. The homepage then kept its generic placeholder and did not distinguish configuration failure from a genuinely empty catalogue.
- The repair branch now returns HTTP 503 when `REVIEWS` is missing; the catalogue frontend displays an explicit retry action on API errors and a separate empty state when the API succeeds with zero published cars.
- Vehicle card layout was reordered so the photo gallery is shown before the description, and every car card has a direct “Обсудить этот автомобиль” action leading to the enquiry form.
- Added regression tests for the missing-KV response and the photo-first card/CTA layout. Exact-head CI evidence is still pending/unavailable through the current GitHub workflow-run/status connector; do not treat source changes as fully verified until the workflow result is confirmed.


## CI diagnosis and correction — 2026-11-10 19:50 UTC
- First PR #60 validation on merge ref `add34f993fc98e0bd7c592358514c59b0843ce62` found a real syntax error: an actual newline had been inserted inside a quoted Telegram response string in `worker.js`.
- Corrected the source string to use escaped newlines in commit `3bed85b31b5f1791d4d6ba3943504ced752896f3`.
- Initial Worker syntax checks failed before the test suite could run. The Factory Review privacy job also failed at test-module import because the Worker module did not parse.
- Gitleaks scanned the PR commits and reported `no leaks found`, but the action failed while uploading its SARIF artifact because GitHub Actions artifact storage quota is full. This is an infrastructure failure, not a detected secret.
- Rerun of exact-head syntax/tests and Factory Review is still required. Do not merge while CI is red or unconfirmed.


## Exact-head verification — 2026-11-10 19:52 UTC
- Code/test head verified: `6fb129554b135010fe42aa992b7a4593c3aae7b5`.
- Worker tests run #141 (`42889383089`): syntax check passed; full suite passed **129/129, 0 failed**.
- Cloudflare Worker checks run #246 (`42889383083`): syntax and private-admin routing passed; embedded regression suite passed **129/129, 0 failed**.
- Factory Review run #155 (`42889382954`):
  - Functional/regression tests passed **129/129**.
  - Security/privacy regression tests passed.
  - Director/release-evidence job failed only at artifact upload: GitHub Actions artifact storage quota is full.
- Deploy workflow run #108 (`42889383220`) completed successfully for the PR but correctly skipped both secret verification and the production deploy step because this was a pull_request event. **No production deployment occurred.**
- Gitleaks in the earlier security baseline reported `no leaks found`; its SARIF upload was blocked by the same GitHub Actions artifact quota.
- The initial failing test on this branch was a stale assertion that expected the delete button in the first keyboard column. The site list now intentionally has an edit button first and a remove button second; the test was corrected to inspect all buttons in each row. The latest exact-code run is green.
- Current PR #60 remains open and mergeable. Do not merge/deploy until owner approval and the separate live-runtime checks are complete.
- Browser-based admin console is implemented on this branch at `/admin`; it is not yet deployed to production. The private Telegram `/site` menu remains available. Live Worker HTTP, production `REVIEWS` binding, actual active vehicle records, webhook and real-device visual review are not verified from this environment.


## Secure browser admin panel — 2026-11-10 20:00 UTC
- Added a mobile-responsive browser admin page at \`/admin\` on the same Cloudflare Worker origin.
- Private Telegram command \`/adminlink\` sends the configured admin a one-time 8-digit code and the direct panel URL. Codes expire in 5 minutes, are hashed in KV, and only the most recent code per admin is valid.
- Successful login creates an 8-hour KV-backed session; the browser receives only an HttpOnly, Secure, SameSite=Strict cookie. Session token is stored as SHA-256 hash. The configured admin ID is checked again on every request.
- Mutating API calls require a matching Origin header; login attempts are limited to 10 per source IP per 5-minute window. Admin API responses are no-store and do not return Telegram source URLs or media file IDs.
- Panel supports full-text replacement, exact-fragment removal/replacement, unpublishing one selected item back to moderation while preserving media, and listing published cars/reviews.
- Latest exact-code verification: Worker regression suite **131/131**; Cloudflare Worker checks **131/131**; Factory Review functional **131/131**, security/privacy subset **13/13**, Director/release-evidence job succeeded with handoff preserved in the job summary.
- Factory Security Baseline run #45 was still running at this handoff; Gitleaks v3 and CodeQL result must be confirmed before merge.
- The PR deploy workflow passed but skipped Cloudflare secret verification and production deployment because the event was a pull request. Production has not yet been changed.
- Live admin login, production KV binding, active vehicle records, Telegram webhook delivery, and real-device rendering still require post-merge runtime verification.


## Production release — 2026-11-10 20:06 UTC
- PR #60 merged to \`main\` by squash merge. Merge commit: \`9ef10803cbcfce5c628d5c150bfc7c99fdc9fdba\`.
- Production Cloudflare Worker deployment run \`42891751875\` completed successfully.
- Wrangler confirmed the \`REVIEWS\` KV binding is present on the deployed Worker; deployment output included the configured namespace binding.
- Deployed Worker URL: https://avtoy-korea-auto.sokfrut.workers.dev
- Production Worker version ID: \`59783368-e6fc-49de-8ed4-ef5aa666e1b9\`.
- On the merge commit, Worker regression tests and Cloudflare Worker checks completed successfully; deployment re-ran syntax and the full regression suite, verified deployment secrets, restored and SHA-256-verified both binary assets, then deployed successfully.
- Gitleaks on the merge commit completed successfully and reported \`no leaks found\`.
- CodeQL static analysis on the merge commit was still running at the time of this note; check run \`42891714597\` before declaring the security baseline fully complete.
- Live HTTP rendering, actual current catalogue entries/media, and a real Telegram admin login/command round-trip were not independently exercised by this environment. Deployment success and KV binding presence are confirmed, but these are still required acceptance checks on a phone.
- Admin quick start for the owner:
  1. Open the bot's private chat (not a group).
  2. Send \`/adminlink\`.
  3. Open the panel URL returned by the bot.
  4. Enter the one-time 8-digit code from that same private chat within 5 minutes.
  5. In the panel, choose the specific vehicle/review. Edit all text or remove/replace a precise fragment; to hide one listing use unpublish/return-to-moderation. Photos are retained.
  6. Telegram fallback remains \`/site\` for the list and item-level edit/unpublish actions.
- Never paste the one-time code into a group or share it. The panel session expires after 8 hours.


## Homepage hero vehicle refresh — 2026-11-11
- Active branch: `feat/homepage-car-hero-carousel-standalone-2026-11-11`, based directly on `main`; this change is independent of open PR #64 and does not include or merge it.
- Code/test commit before this handoff note: `b6d92aa8733b5fd99d406ed14b738a0e37740568`.
- Replaced the three generic/irrelevant hero backgrounds with current vehicle imagery for Kia Sportage 2026 (facelift / refreshed design), Kia K5 2026 GT-Line, and Toyota RAV4 2026 (new generation).
- Hero now exposes the active model name, accessible image labels and model-specific dot labels. Images are preloaded after script initialization; manual arrows/dots remain available.
- Autoplay advances every 5 seconds. Manual navigation restarts the interval; the timer pauses when the tab is hidden or the carousel receives keyboard focus, and respects `prefers-reduced-motion`.
- Added a regression test asserting the three model names, model metadata, 5-second autoplay, and removal of the previous Unsplash placeholder cars.
- Image sources currently use external image CDNs (CarExpert for Sportage, CarsCommerce dealer image for K5, WhichCar for RAV4); no image binaries were added to the repository. External-host availability, commercial image-use terms, and final browser rendering still require review before production.
- Verification status at handoff: source-level diff and assertions inspected; exact-head CI and real browser/phone visual checks are pending. Do not merge or deploy without owner approval.
- Next action: run PR checks, inspect their exact-head results, and report the evidence plus outstanding image-host/legal checks.


## CI correction — 2026-11-11
- First exact-head CI on PR #66 found the new test's regular-expression literal was over-escaped, causing a JavaScript parse failure in `worker.test.mjs`; Worker source syntax itself passed.
- Replaced those two assertions with literal `String.includes` checks in commit `fe74d8b36a5e14f52032bac3af1553c0b78cb83b`. New exact-head Worker tests, Cloudflare checks and Factory Review must complete before this change is considered verified.
- The PR deployment workflow correctly skipped both production-secret verification and deployment because the event was a pull request. No production deployment occurred.


## Existing homepage asset regression update — 2026-11-11
- Second CI pass parsed successfully and ran 134 tests; 133 passed and one pre-existing homepage asset assertion failed because it still required the old `/assets/kia-sportage.jpg` background.
- Updated that assertion to retain the logo check while verifying the three new model identifiers and ensuring the obsolete Sportage asset path is no longer used. Change commit: `8127f79f2d981683a505d2a15e90b82a1bfff159`.
- This was a stale expectation caused by the intentional hero-image replacement, not a runtime syntax or carousel failure. New exact-head CI is pending.


## Latest verification evidence — 2026-11-11
- Current PR #66 head: `33ed2209dc4300bcf095d197ff119708c79e4f52`.
- Worker tests run `42999992309`: success, **134/134 passed**.
- Cloudflare Worker checks run `42999992338`: success.
- Factory Review run `42999992778`: Functional / regression tests, Security / privacy regression tests, and Director / release evidence all success.
- Factory Security Baseline run `42999992348`: Secret scanning success; CodeQL static analysis was still in progress at the time of this handoff.
- PR deployment workflow run `42999992398`: job succeeded, but both Cloudflare secret verification and actual production deployment steps were skipped because this is a pull request. Production remains unchanged.
- Still outstanding: CodeQL final result, real browser/phone visual smoke test, and review of external image-host stability and image-use permissions. Do not describe the production site as updated until a separately approved merge and successful Cloudflare production deployment.
