# AVTOY KOREA — Project Handoff
Updated: 2026-11-06. Repository: sokfrut-tech/avtoy-korea-auto.
Previously recorded Worker: https://avtoY-korea-auto.sokfrut.workers.dev/ (verify exact live URL before use).
Telegram channel: https://t.me/avtoYkorea.
PR #55 was historically noted as needing fixes; recheck current state.

## Product goal
Reliable mobile-first automotive website and Telegram inquiry/review workflow for importing vehicles from Korea. Support Russia and international users on phone, tablet and desktop.

## Website requirements
- Clean automotive identity; preserve approved menu wording.
- Logo wording: “автомобили из кореи”, with Kia Sportage visual direction discussed.
- Responsive layout.
- Vehicle content includes 2026+ Telegram posts where available.
- Show all reviews regardless of date.
- Reviews render as clean photo/video cards or carousel, not raw Telegram markup/reaction icons/forwarded debris.
- Hide personal phone/name from public website where requested.
- For group-origin posts remove source/contact footer that should not be public.

## Bot/inquiry requirements
- Bot name AvtoY Korea. /start and /contact previously reported working after Cloudflare secrets were configured.
- Website forms and bot replies route inquiries privately to administrators, never a public group.
- Stable sequential inquiry numbers, deduplication and private admin routing.
- Avoid requiring admins to use manual /reply CHAT_ID if feasible.
- Support phone-only customers; correlate phone/Telegram only with safe validation and consent.
- Re-read current config for administrator routing; do not put personal identifiers or credentials in public docs/logs.

## Historical implementation notes — recheck
- PR #12: numbered private-order workflow; 45/45 tests after a23aea7; retry dedupe noted in 887881f.
- PR #26 merged at 9cea109; reported 68/68 tests, album grouping and edit-before-publish.
- PR #55 later required fixes.
- Historical bug: frontend success toast appeared while admin delivery was broken. Test both ends, not just UI.
- Historical album issue: Telegram multi-photo albums/forwards duplicated images, included blurry thumbnails or lost originals. Preserve every album item in one coherent post; retry safely before moderation.
- Historical deployment issue: workflow deployed despite failed tests (947b1674/d3450434; fix candidate d3040cef). Re-audit deploy gates.

## P0 — private inquiry path
1. Recheck PR #55, branches, commits, tests and deployment workflows.
2. Trace form -> Worker validation -> durable numbered order -> private admin notification -> admin reply -> customer delivery.
3. Test phone-only and Telegram-linked customer cases.
4. Verify deduplication/idempotency on webhook retries and duplicate submits.
5. Success UI only after durable acceptance; distinguish queued from delivered.
6. Avoid logging full phone numbers, bot tokens or private message content.

## P0 — deployment safety
Required tests/security checks must pass before deploy. Failed/skipped required test blocks production. Verify Cloudflare environment and deployed version. Secrets remain in secret stores only.

## P1 — Telegram content pipeline
Group album media by media_group_id and preserve all original photos/videos. Avoid duplicate thumbnails and low-resolution copies when originals exist. Handle edited-before-publish, retries, moderation and partial delivery idempotently. Add tests for albums, forwards, edits, missing media, retries and privacy redaction.

## P1 — website QA
Check home, catalogue, reviews, inquiry form and Telegram links on mobile/desktop. Validate image quality, alt text, loading and broken links. Ensure older reviews are not hidden by date filters. Preserve approved copy/menu unless user approves changes.

## First resume action
Read docs/CONTINUATION.md and AGENTS.md, inspect Worker/tests and PR #55. Run full suite, audit deploy workflow, then test inquiry end-to-end in safe environment before production changes.
