# AVTOY KOREA — website and Telegram bot handoff

Last updated: 2026-10-31

## Repository and deployment
- Repository: https://github.com/sokfrut-tech/avtoy-korea-auto
- Worker: https://avtoy-korea-auto.sokfrut.workers.dev/
- Telegram webhook route: `/telegram/webhook`
- Main implementation files include `worker.js`, `worker.test.mjs`, and `README.md`.
- Work branch previously identified: `feature/reviews-moderation`; latest known commit: `7d99139` (verify current branch head before editing).
- A notes commit `223b909` was previously recorded on `memory/project-notes-30-10`.
- This handoff is being saved on `docs/continuity-2026-10-31`, based on the feature branch.

## User requirements
- Website is an auto-import / “автомобиль под заказ” service for Korea. Wording should use “автомобиль”, not generic “авто”; consultation option should not show a price.
- Include contact/back-contact, including advertising inquiries; use car pictograms and photos; keep typography aligned and professional.
- Website form submissions and user messages must go only to configured administrators’ personal Telegram IDs. The group itself must not receive customers’ submitted personal information.
- Bot should reply to users and pass inquiries to admins.
- Buyer photo/video reviews should be published through an admin-controlled flow. Do not require public instructions such as “post with #отзыв”; admins should be able to select media from the group or upload it.
- User reported that the site did not open and the bot was silent. A prior symptom was `/start` not receiving a reply / messages stuck with one check mark.

## Deployment/configuration notes
- Cloudflare Worker URL: `https://avtoy-korea-auto.sokfrut.workers.dev/`
- Telegram webhook URL: `https://avtoy-korea-auto.sokfrut.workers.dev/telegram/webhook`
- Previously missing GitHub Actions secrets were `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; user later reported adding both. Verify deployment workflow status rather than assuming it is fixed.
- Runtime configuration previously identified: `REVIEWS` KV, `TELEGRAM_REVIEW_GROUP_ID`, `TELEGRAM_BOT_USERNAME`. Confirm current code requirements before configuration.
- Telegram secrets must remain outside Git: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`; admin personal numeric IDs are private configuration and must not be committed.
- Do not publish a Worker or merge to `main` without explicit owner approval. Do not expose or paste secret values.

## Current known status / unverified items
- User has completed the Cloudflare/GitHub secret-entry steps, but a fresh deployment and live test were not confirmed in the last recorded status.
- Website availability, Worker deployment, Telegram webhook registration and bot response remain unverified.
- A fresh full test run (previously 14 tests were expected) was not available in the last recorded status.
- Reviews moderation work was on `feature/reviews-moderation`, not merged to `main`; no open PR was known at that point. Recheck current GitHub state.

## Immediate next steps
1. Inspect current branch head, tests, GitHub Actions run and deployment result.
2. Run `worker.test.mjs`; fix any failing tests on the feature branch.
3. Verify Cloudflare Worker health and site routes.
4. Verify Telegram webhook status and test `/start` with a private user chat.
5. Submit a test website inquiry and confirm that only configured admins receive it individually.
6. Verify group messages do not leak customer submissions.
7. Test admin-controlled review media selection/upload and publication.
8. Ask owner before any production publish or merge to `main`.

## Change record
- 2026-10-31: Added this continuation handoff on a documentation-only branch. No production deployment or merge performed.
