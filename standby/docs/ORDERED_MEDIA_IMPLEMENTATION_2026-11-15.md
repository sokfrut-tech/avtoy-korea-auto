# Ordered Telegram media implementation — 2026-11-15

## Scope

This is an isolated implementation branch. It does not deploy the Worker, change production KV, change DNS, or modify the production branch.

## Implemented

- Added `media-order.js` with pure helpers for Telegram media identity, de-duplication, source-message ordering, and fail-closed handling of legacy records.
- Captures each channel/group album item with `sourceMessageId` and normalized `type` (`photo`, `video`, `document`).
- Merges retries idempotently and sorts by Telegram source message ID, not webhook arrival order.
- Persists canonical `mediaItems` and `mediaOrderKnown` through channel import, car/review moderation, and approved records.
- Uses verified order for admin previews and for public `/api/cars` and `/api/reviews` responses.
- Adds typed review-media routes (`photo/<index>`, `video/<index>`) so mixed review albums can be served in the original sequence.
- Legacy mixed photo/video records without source IDs are not assigned an invented order and are withheld from the public media list (`mediaOrderKnown:false`).
- Photo deletion updates canonical media metadata rather than leaving stale references.

## Regression coverage added

- Photo → video → photo through channel import, moderation, approval, and public car API.
- Mixed photo/video review through moderation, approval, and public review API.
- Out-of-order webhook delivery.
- Duplicate retry idempotency.
- Missing source IDs and ambiguous legacy mixed media fail closed.
- Photo-only compatibility, album isolation, and image documents.

## Verification status

- GitHub file writes were read back and their content SHAs confirmed.
- Static review of changed call paths completed.
- The Node regression suite has **not yet been executed** in this branch. The repository's prior GitHub Actions runs were unable to provision a runner (runner ID 0, no steps/logs); no claim of passing integration tests is made.
- No deployment or production data migration has been performed.

## Remaining gates

1. Run `node --check worker.js`.
2. Run `node --test worker.test.mjs media-order.test.mjs`.
3. Inspect test results and correct any regressions.
4. Review real approved-record inventory before any migration. Mixed legacy records without source message IDs require re-import from Telegram or manual review.
5. Deploy only after explicit approval and a verified rollback plan.
