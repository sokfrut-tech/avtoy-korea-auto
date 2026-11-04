# Factory continuation brief — AVTOY KOREA

**Updated:** 2026-11-04 | **Status:** active web/Worker/Telegram integration; production changes require owner approval  
**Canonical portfolio:** Universal-AI-Factory/docs/PROJECT_PORTFOLIO_AND_CONTINUATION_PLAN_2026-11-04.md  
**Branch:** factory/continuation-brief-2026-11-04  
**Open PRs:** #57 security, #56 CodeQL, #50 warranty wording, #42/#40 logo, #17 accessibility, #13 KV binding, #2 Telegram catalogue/moderation  
**Correlation:** avtoy-korea-continuation-20261104

## Mission and owner requirements
Professional AVTOY KOREA vehicle-import / vehicle-order website with working Telegram bot, enquiries, administrator handling and moderated buyer photo/video reviews. User prefers natural professional copy/design, clear vehicle imagery and no AI-generated-looking domain/branding.

## Hard requirements
- Web enquiries go only to administrators' personal Telegram IDs. Do NOT post private customer enquiries into the Telegram group.
- Review media may originate from buyer photos/videos; admins should manually choose or upload media rather than exposing public posting instructions.
- Rejected/failed review submissions must be retryable; all selected photos/videos must remain attached, not collapse to one image.
- Do not change main/live website, webhook, production Worker, secrets or DNS without explicit owner approval.
- Never expose bot tokens or secret values.

## Known unresolved symptoms / configuration
- User reported bot silent on /start and ordinary messages, messages with one check mark; webhook test path showed blank screen.
- Historical branch note: main had old code; feature/reviews-moderation had newer code.
- CI deployment had been blocked by missing CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID; verify current secret presence by workflow result only, never print values.
- Relevant config names include REVIEWS KV, TELEGRAM_REVIEW_GROUP_ID, TELEGRAM_BOT_USERNAME and distinct admin/group IDs. Verify bindings and actual deployment version.
- Previous code claims of webhook/review fixes were not a substitute for live end-to-end verification.

## Next actions
1. Refresh main and feature branches, inspect PRs #57/#56/#50/#42/#40/#17/#13/#2 and exact CI results.
2. Check static Worker routes, webhook handler, bot command routing, Telegram API response/error handling and logs.
3. Add tests for /start, enquiry delivery to admin IDs only, admin reply, review submit/reject/retry, multi-photo/video retention and duplicate prevention.
4. Check Cloudflare bindings and secret names; do not reveal values.
5. Test site and bot on a safe non-production target; obtain owner approval before production deployment/webhook change.
6. Preserve original logo and correct car silhouette; do not reuse blurred/duplicate post photos.

## Resume
Read this brief and README/AGENTS; inspect latest feature branch and PRs before changing anything. If Claude/Gemini are unavailable, ChatGPT performs code and CI investigation directly, recording exact evidence.
