# Vehicle photo sharpness detection — implementation brief

Date: 2026-11-12
Repository: `sokfrut-tech/avtoy-korea-auto`
Branch: `fix/strict-published-photo-quality-2026-11-12`
Status: design/evidence only; no decoder dependency or production behavior added.

## Current verified behavior

- `catalogPhotoItems()` rejects Telegram PhotoSize renditions with known dimensions below the current threshold (longest edge 1280 px and total pixels 900,000).
- Entries without dimensions are not accepted as ordinary legacy PhotoSize records. They are accepted only through the explicit image-document path when MIME metadata is present and file size is at least 120,000 bytes.
- This is a resolution/metadata gate, not a sharpness test. A large, high-resolution blurred image can still pass.
- `carPhotoQualityNote()` warns about low-resolution or unknown-dimension media, but it does not measure blur.
- Existing deduplication uses stable Telegram identifiers and SHA-256 where the file can be inspected; verification failures intentionally fail open to avoid silently losing submitted photos.

## Runtime constraints discovered

- The Worker currently has no package manifest or image-decoder dependency; `worker.js` is a single Worker entry point with KV and Durable Object bindings.
- Cloudflare Workers support precompiled WebAssembly modules. Workers are single-threaded; WASM threading is unavailable. Binary size and startup time matter.
- Cloudflare documents a 10 ms CPU limit per HTTP request on Workers Free and up to 5 minutes on Workers Paid (default 30 seconds). The account plan is not established here, so the design must not assume the Paid limit.
- Image metadata APIs and resize/blur transforms are not equivalent to decoding pixels and measuring sharpness.

## Candidate approach

1. Keep the existing inexpensive metadata gate as the first stage.
2. Add an isolated, bounded pixel-analysis stage for candidates that pass the metadata gate. Decode only supported still-image formats (initial target JPEG; add PNG/WebP only after compatibility tests).
3. Downscale to a small grayscale sample (for example, longest edge 512 px) before computing sharpness metrics. Avoid full-resolution multi-megapixel convolution in the request path.
4. Compute at least two complementary signals:
   - Laplacian variance (edge/high-frequency energy).
   - Tenengrad/Sobel gradient energy.
5. Normalize or guard against low-texture scenes (plain sky, dark photos, close-up paint) so low detail is not automatically labelled as blur.
6. Return three outcomes rather than a binary verdict:
   - `pass`: sufficiently strong signal and supported decode.
   - `review`: borderline score, low-texture image, or unsupported/uncertain decode.
   - `reject`: clearly degraded image only after thresholds have been calibrated on a representative labeled set.
7. Do not discard uncertain images. Route them to the existing administrator moderation flow with the photo number and car title, and show a clear reason.
8. Cache the result by a content hash so repeated imports/retries do not pay the decode cost again.

## Candidate implementation choices

- Rust `image` crate compiled to WASM: broad codec coverage can be feature-trimmed, but default features should not be enabled blindly; disable multithreading for the single-threaded Worker target and include only required codecs.
- Photon (Rust/WASM): exposes convolution and Laplace/Sobel-style operations, but the exact decoder formats, bundle size, and Cloudflare Worker compatibility must be verified in a small prototype before adoption.
- `@napi-rs/image`: has a WASM/browser Worker build, but do not assume its browser Worker target is drop-in compatible with Cloudflare Workers; verify module loading, WASM asset handling, and runtime APIs first.

No dependency is selected yet. A candidate is acceptable only after a reproducible Worker compatibility test, measured WASM size/startup cost, and CPU measurements on representative images.

## Recommended safe rollout

- Prototype decoder + metric in a separate test module/branch first; do not change publication policy yet.
- Build a labeled test corpus containing sharp, mildly soft, strongly blurred, low-texture, dark, compressed, rotated, and varied-format car images. Keep original files and expected labels.
- Record metric distributions by class; choose conservative thresholds with a manual-review band. Do not pick a universal Laplacian threshold from internet examples.
- Add tests for malformed files, decompression bombs/huge dimensions, unsupported formats, memory bounds, timeouts, and deterministic scores.
- Only then integrate the analyzer into the admin moderation card. Public catalog publication should require explicit approval for `review` outcomes.
- Preserve fail-safe behavior: decoder failure must not crash the Worker or silently delete the only copy of a user's upload. Keep the media staged and mark it for manual review.
- Verify the CI deployment gate independently. A PR run may execute syntax/tests but must never deploy. A main-branch deployment must be tied to a successful test workflow for the exact tested commit.

## Evidence links

- Cloudflare Workers WebAssembly support and single-thread limitation: https://developers.cloudflare.com/workers/runtime-apis/webassembly/
- Cloudflare Workers CPU and memory limits: https://developers.cloudflare.com/workers/platform/limits/
- Rust image crate format features and warning about default multithreading for single-threaded WASM: https://github.com/image-rs/image
- Photon image processing operations including convolution, Laplace and edge detection: https://github.com/silvia-odwyer/photon
- `@napi-rs/image` WASM/browser Worker target and format caveats: https://image.napi.rs/docs

## Explicit non-actions

- No production deployment.
- No PR merge.
- No KV data deletion or rewrite.
- No Telegram webhook, bot token, Cloudflare secret, or binding changes.
