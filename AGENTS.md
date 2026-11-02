# Agent instructions

Before making changes, read this file, `docs/CONTINUATION.md`, `README.md`, and the relevant source/tests. Confirm the current branch and commit.

## Safety and scope
- Work on feature branches. Do not merge into `main`, deploy Cloudflare, change production bindings, or modify live Telegram webhook configuration without explicit user approval.
- Never print, commit, or store secret values. Refer only to secret names and configuration status.
- Customer contact details must remain private to configured administrator user IDs. Never send customer details to groups or channels.
- Treat the configured review group as an input source only; route media to admins for private moderation before publishing.
- Do not claim that CI proves the live Worker, website, Telegram bot, webhook, KV binding, or WAF configuration works.

## Required verification
- Run Worker syntax checks and the complete test suite after code changes.
- Add regression tests for defects and verify the exact failing behavior is covered.
- Inspect the final diff for privacy leaks, duplicate delivery, webhook retry behavior, and accidental unrelated changes.
- Report commands, run IDs, pass/fail counts, and checks not performed.

## Continuity
After every substantial change, update `docs/CONTINUATION.md` on the active branch with UTC date/time, branch, commit SHA, changed files, tests and results, runtime checks, unresolved blockers, and next action. Keep it factual and never record secret values.


## Review media quality and duplicate-prevention rules

- Never choose a Telegram `PhotoSize` by array position. Select maximum `width * height`, then maximum `file_size`; use input order only as a final deterministic tie-breaker when metadata is missing.
- Preserve Telegram `file_id`, `file_unique_id`, `width`, `height`, and `file_size` where supplied. Serve the selected original rendition, not a thumbnail.
- Deduplicate redelivery only within the same review/album by `file_unique_id` (fallback `file_id`); preserve every distinct album image and its order.
- Never globally deduplicate media across different reviews. Reuse across posts may be intentional.
- Review gallery rendering must map one stored unique media item to one gallery item; do not add duplicate DOM nodes or CSS thumbnail copies. Keep photos uncropped.
- Do not cache indexed review-media URLs unless the URL is versioned by the actual media identity. Until then, return `Cache-Control: no-store`.
- Before marking the media pipeline fixed, add regression tests for shuffled PhotoSize arrays, resolution selection, album retries, unique-id deduplication within one review, preservation across separate reviews, and API/gallery mapping.

- Admin media from the configured review group must be aggregated by `media_group_id` into one staged import and one moderation card. Serialize album parts through the album Durable Object and deduplicate retry delivery within that album.
- Do not process an admin's group media a second time through the customer `/review` submission path; one Telegram update must create only one moderation record.
