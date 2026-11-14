# AVTOY KOREA — Russian standby prototype

Standalone Node.js 20.19+ proof-of-concept. It does not import or execute the Cloudflare Worker and does not call Cloudflare for pages, APIs, or media.

## Run locally

- Install Node.js 20.19+.
- Run `npm install`.
- Run `npm start` (default port 8080).
- Open `http://localhost:8080`.
- `npm test` runs the local regression suite; `npm run check` checks syntax.

## Data

The app reads `data/public-snapshot.json` with this shape:

```json
{
  "updatedAt": "2026-11-14T00:00:00.000Z",
  "cars": [
    {
      "id": "car_100555_1001",
      "caption": "Kia Sportage 2023",
      "description": "Public description without private contacts",
      "mediaItems": [{ "type": "photo", "url": "/media/car-photo.jpg" }]
    }
  ],
  "reviews": []
}
```

Put mirrored public media under `public/media/`; image URLs must be local paths. Do not put Telegram file IDs, private contacts, pending listings, customer data, admin sessions, or credentials in the public snapshot.

## Public snapshot integrity manifest

After mirroring approved public media and building `data/public-snapshot.json`, generate a verification manifest:

```sh
node scripts/create-public-manifest.mjs data/public-snapshot.json public/media data/public-manifest.json
```

The manifest records the snapshot SHA-256 and byte size, public car/review counts, unique referenced media count, total media bytes, and SHA-256/byte size for each referenced media file. Generation fails if a referenced file is missing, empty, or has an unsafe URL. It includes only media referenced by the public snapshot; unrelated files in the media directory are not listed.

Use the manifest before and after transfer to compare snapshot and media hashes. This local check does not prove a remote provider retained the files; read back remote objects and recompute hashes before declaring the mirror complete.

## Environment

- `PORT` — listen port (default 8080).
- `TELEGRAM_BOT_TOKEN` — Telegram bot token, only as an environment secret.
- `TELEGRAM_ADMIN_IDS` — comma/space-separated positive personal admin IDs; group IDs are rejected.
- `STANDBY_ADMIN_TOKEN` — long random bearer token for private operations; use at least 32 random bytes.
- `PUBLIC_BASE_URL` — absolute HTTPS origin for sitemap URLs after deployment.
- `TRUST_PROXY=true` — only when the app is behind a trusted proxy that overwrites forwarding headers.
- `YDB_CONNECTION_STRING` — YDB connection string; keep it in the deployment secret store.

## Durable inbox and delivery

`storage/ydb-inbox-store.mjs` provides a YDB-backed transactional inbox store using the official `@ydbjs/core`, `@ydbjs/query`, and `@ydbjs/auth` SDK packages. It creates a single-row table with a JSON-text payload and monotonically increasing revision. A 3.5 MB payload guard protects the database row-size budget; this is a compact prototype store, not a high-volume normalized inbox schema. Read/modify/write operations run inside a serializable YDB transaction so concurrent application instances do not overwrite each other's inbox updates.

When `YDB_CONNECTION_STRING` is set, the server initializes the YDB driver at startup, creates the table, and passes the store into the HTTP request flow. Without that variable it retains the local JSON fallback for development. Enqueue/idempotency and delivery state changes use `transactInbox`. Telegram HTTP calls run **outside** database transactions: the server claims a request with a short lease, sends messages, then commits delivery results. Expired `sending` leases are eligible for retry after a process crash.

The transaction callback is deterministic and has no network side effects. YDB's serializable transaction retry option is enabled. Telegram delivery is at-least-once: if the process crashes after Telegram accepts a message but before the delivery result is committed, a retry may send it again. Successful per-admin delivery IDs are persisted to reduce duplicate messages.

For Yandex Cloud, provide `YDB_CONNECTION_STRING` and attach a service account to the runtime with the minimum required YDB database permissions. The server uses `MetadataCredentialsProvider` to obtain/refresh credentials from the cloud metadata service, awaits `driver.ready()`, calls `ensureSchema()`, and closes the driver on shutdown. Never commit connection strings or credentials.

## Independent retry scheduler

The Node process includes a best-effort in-process retry timer, but that timer is not sufficient for a runtime that sleeps, restarts, or scales to zero. The protected `POST /ops/retry` endpoint is the durable integration point for an external scheduler.

A Cloudflare Cron Worker is provided in `scheduler/retry-worker.mjs`; its Wrangler config runs every five minutes. Deploy it only after the standby service is reachable over HTTPS:

1. Set `STANDBY_RETRY_URL` as a Worker variable to the standby service base URL (origin/base path only, no query string).
2. Set `STANDBY_ADMIN_TOKEN` as an encrypted Worker secret. It must be the same strong token configured on the standby service; never commit or paste it into source control.
3. From this directory run `npx wrangler deploy --config scheduler/wrangler.toml`.
4. Check Worker logs and confirm the standby endpoint returns `200` with a JSON `processed` count.

The Worker rejects non-HTTPS endpoints, sends the bearer token only to the configured HTTPS host, and does not log credentials or request bodies. The scheduler is an optional separately deployed component; adding its source here does not mean it has been deployed or that retry automation is active.

## Important boundaries

- Prototype only: no live cloud resources, custom domain, DNS, Telegram webhook, or production data migration.
- Local JSON fallback is suitable only for a single-instance prototype. Set up YDB and `YDB_CONNECTION_STRING` for multi-instance durable request storage. Public media still needs durable object storage; the current local media directory is not shared between ephemeral instances.
- Public snapshot/media export must be explicitly approved and generated privately; no live data or bot token is included in this repository.

## Read-only export of approved Cloudflare KV records

The optional `scripts/export-approved-kv.mjs` helper reads only the two public-approval prefixes confirmed in the Worker source: `car_approved:` and `approved:`. It does not list or fetch pending submissions, admin sessions, moderation state, logs, bot configuration, or other KV keys. It does not write to Cloudflare KV.

For an owner-approved export, use a Cloudflare API token restricted to **read** access for this one KV namespace. Set `CF_ACCOUNT_ID`, `CF_KV_NAMESPACE_ID`, and `CLOUDFLARE_API_TOKEN` in a private shell environment, then run:

```sh
node scripts/export-approved-kv.mjs data/private-approved-export.json --confirm-approved-public-export
```

The explicit confirmation flag is mandatory. The output contains approved record values and Telegram media identifiers needed for a later private media-mirroring step; treat it as sensitive, keep it outside `public/`, and delete it securely after the public mirror is verified. The helper never prints record contents or the token. Do not paste credentials into chat or commit the export. This helper has not been run against production KV.

## Build a public snapshot from an approved export

`node scripts/build-public-snapshot.mjs <private-export.json> [data/public-snapshot.json]` accepts a private JSON export with `records: [{ key, value }]` and `mediaMap: { "Telegram file_unique_id": "/media/local-file.jpg" }`. It includes only approved complete vehicles and approved reviews, strips contact/phone/channel data, and never writes Telegram file IDs to the public snapshot.

## Mirror approved Telegram media

Use a private approved-record export and a Telegram bot token supplied only through the environment:

`TELEGRAM_BOT_TOKEN=... node scripts/mirror-approved-media.mjs <private-export.json> [data/media-map.json] [public/media]`

The script reads approved vehicle and review records, downloads referenced media through Telegram's Bot API, writes content-hash filenames, and keeps the Telegram-ID-to-local-URL map private under `data/`. Files larger than 20 MB are skipped. Normal Telegram photos must meet the minimum dimensions. Image files uploaded as Telegram documents are also supported: the mirror reads PNG/JPEG/WebP/GIF dimensions from the downloaded original bytes, then applies the same minimum quality threshold. Unsupported, malformed, or undersized image documents are skipped rather than published. Pass the private map as its fourth argument; the default path is the map path used above:

`node scripts/build-public-snapshot.mjs <private-export.json> [data/public-snapshot.json] [data/media-map.json]`

If a record has an ordered `mediaItems` array, its album order is retained (including mixed photo/video items). Legacy separate `photos` and `videos` arrays are supported, but their original cross-type order cannot be reconstructed. The private map is read separately and is never copied into the public snapshot.

**Album-order compatibility:** production records created before the Worker schema update contain separate `photos` and `videos` arrays only; their original mixed-album interleaving cannot be reconstructed, so legacy fallback is photos-then-videos. This branch now adds an ordered `mediaItems` array to newly staged/imported cars and reviews, appends subsequent Telegram album parts in arrival order, deduplicates by Telegram stable media ID, and retains the legacy arrays for existing site/API compatibility. A regression test covers photo → video order and duplicate delivery. This Worker change exists only on the unmerged research branch; it has not been deployed, and it does not retroactively repair old KV records.

## Concurrency and delivery guarantees

- The YDB adapter serializes inbox mutations through a YDB serializable transaction on the singleton row. This is the cross-instance claim boundary in the current prototype; it must be verified with the real YDB SDK/database before production use.
- The local JSON fallback uses an in-process write queue only. It is for one process on one instance and is **not safe for multiple server processes or multiple hosts**. Do not horizontally scale the file-store mode.
- Delivery is at-least-once, not exactly-once. If Telegram accepts a message but the response is lost or the request times out before the success receipt is committed, a retry may send a duplicate. Telegram's sendMessage API does not provide an idempotency key for this workflow.
- A 120-second database lease prevents another worker from claiming an in-flight request while the normal Telegram HTTP timeout is 15 seconds. A lease only protects the database claim; it cannot eliminate the ambiguous Telegram-accepted/receipt-lost crash window.
- Every successful administrator delivery is recorded individually. A retry targets only admins without a recorded receipt. Delivered requests are terminal and are not eligible for retry.
- Before production, run integration tests with two independent processes against a real YDB test database: concurrent duplicate enqueue, competing claims, expired lease takeover, simultaneous completion, and crash/timeout after Telegram acceptance. Never infer distributed locking correctness from an in-memory mock.
