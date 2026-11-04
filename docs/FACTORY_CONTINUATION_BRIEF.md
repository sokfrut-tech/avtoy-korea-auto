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


## Documentation handoff PR
- Continuation brief PR: [#58](https://github.com/sokfrut-tech/avtoy-korea-auto/pull/58) (draft; not merged).
- Review this brief against current main before code changes.
## Refreshed verification — 2026-11-04 19:35 UTC

- Current main deployment source commit observed: 8b505475d2745bb7d24d5675b32ee0f85266b81f.
- Main-branch Cloudflare Worker deployment run [41521125734](https://github.com/sokfrut-tech/avtoy-korea-auto/actions/runs/41521125734) succeeded on 2026-11-02.
- Main-branch Worker tests [41521081679](https://github.com/sokfrut-tech/avtoy-korea-auto/actions/runs/41521081679) passed.
- Main-branch Factory Security Baseline [41521080933](https://github.com/sokfrut-tech/avtoy-korea-auto/actions/runs/41521080933) failed because CodeQL upload was attempted while GitHub code scanning is unavailable for this repository.
- PR #56 corrects SARIF handling by keeping CodeQL analysis as a downloadable artifact (upload=false); exact-head CodeQL/Security, Worker and Factory review runs [41696829149](https://github.com/sokfrut-tech/avtoy-korea-auto/actions/runs/41696829149), [41696829152](https://github.com/sokfrut-tech/avtoy-korea-auto/actions/runs/41696829152), [41696829214](https://github.com/sokfrut-tech/avtoy-korea-auto/actions/runs/41696829214) all passed.
- PR #57 shared security toolchain onboarding is open and mergeable. PR #56 is open, ready for review and mergeable. Neither was merged in this session.
- The current Worker source contains /telegram/webhook, /api/request, /api/reviews, /api/cars and media routes. Automated tests cover private admin-only enquiry routing, group silence, Telegram ok:false, admin moderation and album/media paths.
- The live website response and Telegram webhook registration were NOT independently verified in this session. A web fetch of the Cloudflare Worker hostname was inaccessible to the available web viewer; this is not evidence that the site is down. Telegram getWebhookInfo cannot be checked without a secure bot-token path. Do not ask the owner to paste tokens into chat.
- Production secrets, KV bindings, webhook configuration and deployment were not changed.

## Immediate next actions

1. Review and reconcile PR #56 and #57 with PR #58's documented state; do not merge automatically.
2. Add a non-secret Cloudflare runtime health endpoint or use an authenticated Cloudflare dashboard check to verify current Worker version and KV binding presence.
3. Verify Telegram webhook URL and last_error_message using the Cloudflare/Telegram deployment environment without exposing the bot token.
4. Run a controlled /start and one private test enquiry using a test administrator account; confirm private admin delivery and group silence.
5. Verify a full review album: import → one moderation card per album → admin publish → website shows exactly the selected unique photos/videos.
6. Only after those checks, prepare a production change plan and request explicit owner approval.