# AVTOY KOREA — Layero migration technical audit
Date: 2026-10-31
Status: research only; no production changes, no secrets copied, no webhook/DNS changes.

## 1. Current production architecture (verified from main)

Repository: `sokfrut-tech/avtoy-korea-auto`
Production entry: `worker.js` (Cloudflare Worker), `wrangler.toml` binds KV namespace `REVIEWS`.
The current worker file contains 1,187 lines and combines the HTML frontend with server routes.

Routes found in `worker.js`:
- `GET /` and fallback HTML page — site frontend.
- `POST /telegram/webhook` — Telegram bot updates; validates `X-Telegram-Bot-Api-Secret-Token`.
- `POST /api/request` — validates and stores customer request, sends private admin notifications, supports idempotency.
- `GET /api/cars` — approved car cards.
- `GET /api/car-media/:carId/:index` — retrieves Telegram media and streams it to the browser.
- `GET /api/reviews` — approved reviews.
- `GET /api/review-media/:reviewId` — retrieves Telegram media and streams it to the browser.
- `GET /favicon.ico`.

Environment variables referenced by the worker:
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_IDS`, `TELEGRAM_ADMIN_USER_ID`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_CHAT_ID`, `TELEGRAM_REVIEW_GROUP_ID`, `TELEGRAM_WEBHOOK_SECRET`, and binding `REVIEWS`.

The KV binding is not a minor cache. It stores business-critical state:
- orders: `order:`, `order_no:`, `bind_token:`, `request_idem:`;
- webhook delivery retry/deduplication: `webhook_delivery:`;
- reviews: `pending:`, `approved:`, `admin_upload:`, `review_delivery:`;
- car imports and albums: `car_pending:`, `car_approved:`, `import_pending:`, `import_album:`.

KV operations used: `get`, `put`, `delete`, `list`. The current app relies on Cloudflare KV consistency/semantics and expiry options; migration must preserve those semantics or deliberately test and document differences.

The worker calls Telegram Bot API via outbound HTTPS (`fetch`), including `getFile`, `sendMessage`, `sendPhoto`, `sendVideo`, `sendMediaGroup`, and callback-query methods. Telegram file downloads are proxied server-side so the bot token is never sent to the browser.

## 2. Layero fit — official documentation review

Potential target: Layero, https://layero.ru/ and https://docs.layero.ru/.
Official docs describe Russian hosting/edge, project subdomains `*.layero.app`, automatic HTTPS, GitHub deploy integration, Node/Python runtime containers, and environment variables injected into `process.env`.
The Free plan is listed as 0 ₽, up to 5 projects, 100 webhook builds/month, HTTPS platform hostname and runtime apps. Custom domains, indexing, analytics/logs and some other features are Pro-only. The Free plan adds `X-Robots-Tag: noindex`; this means initial discovery must be link-driven (e.g. Telegram), not organic search.

Important runtime caveat: Layero runtime containers sleep when idle. Official docs describe cold starts and explicitly state that background work such as Telegram long-polling pauses while the container is frozen. This project uses Telegram webhooks, not long polling, so webhook requests can wake the HTTP app; nevertheless this must be tested end-to-end, including cold start, retries, callbacks and delivery latency. Do not replace webhooks with long polling.

Official docs also state that the runtime filesystem is ephemeral. Do not store orders, moderation state or media metadata in local files/SQLite without persistent storage.

Layero's shared PostgreSQL database is documented as Pro-only; dedicated database starts at a paid monthly price. Therefore a genuinely free migration cannot assume Layero PostgreSQL is available.

Sources reviewed:
- https://layero.ru/pricing
- https://docs.layero.ru/deploys/github/
- https://docs.layero.ru/deploys/env-vars/
- https://docs.layero.ru/deploys/layero-json/
- https://docs.layero.ru/runtime/overview
- https://docs.layero.ru/runtime/lifecycle
- https://docs.layero.ru/database/
- https://docs.layero.ru/database/limits/

## 3. Migration blockers / design decision

A static-only deploy is NOT sufficient: it would lose the form endpoint, Telegram webhook, admin moderation, catalog/review APIs and media proxy.

A Node HTTP adapter is feasible in principle because the worker logic already uses Web-standard `Request`, `Response`, `fetch`, `URL`, `TextEncoder`, `crypto` APIs, but Cloudflare's `env.REVIEWS` KV binding and Worker entry signature must be adapted. This audit has not yet proven full Node compatibility.

Persistent storage is the largest blocker for a zero-cost Layero runtime: Free Layero does not document a free PostgreSQL database. A migration must first select and validate an external persistent KV/database/storage service with a free tier and adequate terms, or retain Cloudflare KV only if Russian reachability and data access from the new origin are independently verified. No storage provider is selected yet.

Telegram webhooks are synchronous HTTP handlers and should be compatible with a sleeping runtime only after testing. The app must return a successful webhook response within Telegram's retry/timeout expectations; cold-start latency and duplicate delivery need testing. Layero docs say the app can take several seconds to cold-start and that a request may be held while it wakes, but do not guarantee Telegram-specific delivery success.

## 4. Safe implementation sequence

1. Keep the current Cloudflare Worker, KV and Telegram webhook untouched.
2. Build a separate Node adapter on a dedicated migration branch; do not edit `main`.
3. Implement a KV-compatible storage interface and test TTL, list pagination, delete, retry/idempotency and consistency before copying any production data.
4. Add tests for every route, admin-only routing, private order notifications, Telegram webhook secret validation, album grouping, moderation, and media streaming.
5. Deploy only a non-production preview to Layero after the owner connects the GitHub repository and supplies secrets directly in the Layero dashboard. Never commit secrets.
6. Verify the preview from multiple Russian mobile/fixed networks, plus a control network outside Russia.
7. Verify cold-start Telegram webhook, customer messages, admin replies, site forms, catalog, review media, retries and rollback.
8. Only after explicit owner approval: export/import production data, set Telegram webhook to the new URL, and switch traffic. Keep old Worker and KV as rollback until the new site is stable.

## 5. Factory gates

Required before production:
- functional regression tests pass;
- security/privacy tests pass;
- Node adapter tests pass;
- storage compatibility and backup/restore are demonstrated;
- Russian-network reachability is independently tested;
- Telegram webhook cold-start/retry and media proxy are verified;
- rollback procedure is rehearsed.

This report is research only. It authorizes no deployment, data migration, DNS change, webhook change, or purchase.
