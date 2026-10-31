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
