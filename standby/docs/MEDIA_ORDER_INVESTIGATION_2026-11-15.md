# AVTOY KOREA Russian mirror — media-order investigation (2026-11-15)

## Verified findings

- The live application source stores approved car media as separate `photos` and `videos` arrays. Its public `/api/cars` builder concatenates photos first and videos second. That is not proof of original mixed-album order.
- Imported channel album parts are merged into those separate arrays in `mergeChannelPartMedia`; the source message ID for each media item is not retained.
- Review records are also persisted with separate `photos` and `videos` arrays. The public `/api/reviews` builder emits the photo list (or a single video), not a verified cross-type source sequence.
- The standby approved-KV inventory/export scripts already fail closed on legacy mixed photo/video records without an explicit `mediaItems` array. This is correct: silently guessing an order would corrupt the catalogue.
- The Tuqo static build currently uses a public-API exporter that expects `caption`, `text`, and ordered `mediaItems`; the current Worker source does not provide an explicit source-order proof field. Therefore this build target must not be treated as ready for a complete archive.

## Consequence for existing records

For an old record that contains both `photos` and `videos` but no per-item source message ID or ordered `mediaItems`, the original interleaving cannot be reconstructed from the stored arrays alone. Do not invent an order. Such records must be flagged for manual review or re-imported from the original Telegram album if the source is still available.

## Required forward fix (separate, tested branch only)

1. On receipt of every channel/group album message, capture each media item together with its Telegram `message_id` and normalized type.
2. Merge items idempotently by `file_unique_id` (fallback `file_id`), preserving the source message ID.
3. Sort by numeric source `message_id` and persist one canonical ordered `mediaItems` array alongside legacy `photos`/`videos` fields during the compatibility period.
4. On approval, copy the canonical ordered array into the approved record. On subsequent album-part retries, update the same array without duplication.
5. Build public `mediaItems` from that canonical array, and expose `mediaOrderKnown: true` only when every item has valid source-order evidence. Legacy records without evidence must remain flagged.
6. Add regression tests for photo→video→photo albums, out-of-order webhook delivery, duplicate retries, separate albums, all-photo legacy compatibility, and ambiguous legacy mixed albums.
7. Run the complete test suite and inspect the exact diff. Do not deploy or merge this branch without explicit approval.

## Inventory and deployment gate

A real media inventory has not yet been run: it requires the user's Cloudflare KV read token and Telegram bot token in a trusted execution environment. Do not request either secret in chat. GitHub Actions attempts currently fail before runner steps; GitLab CI is blocked by its identity-verification gate. No export, media download, Russian storage upload, or mirror deployment has occurred.

After a trusted inventory run, compare unique media bytes and file counts against Cloud.ru's current free limits, check every Telegram file's retrievability and size, then generate the private export and mirror. Keep all internal keys, file IDs, maps, tokens, and private moderation data out of the public snapshot.

## Safety

This is a research/implementation note on a non-production branch. It does not change the production Worker, DNS, primary site, webhook, KV contents, or hosting resources.
