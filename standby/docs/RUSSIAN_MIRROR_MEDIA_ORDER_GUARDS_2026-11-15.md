# Russian mirror — media-order safety handoff
Date: 2026-11-15

## Current state
- The independent Russian mirror is not deployed.
- No approved KV export, Telegram media download, storage bucket creation, DNS change, or production Worker change has been performed.
- Cloud.ru balance is not confirmed funded; no paid resource may be provisioned without a separate explicit approval.
- The GitLab implementation branch is `sokfrut/avtoy-korea-auto:deploy/russian-tuqo-static-2026-11-15`.
- The GitHub application-code PR #78 remains draft and unmerged: https://github.com/sokfrut-tech/avtoy-korea-auto/pull/78

## Newly closed safety gaps
1. Inventory no longer treats the mere presence of `mediaItems` as proof of original ordering. A mixed photo/video record is structurally complete only when `mediaItems` exists and `mediaOrderKnown === true`.
2. The media mirror refuses mixed photo/video records without that explicit proof. It does not synthesize order by concatenating photo and video arrays.
3. Public parity verification independently rejects a mixed record whose source order is not verified, even if an explicit list exists.
4. Image documents with a supported image MIME type are normalized to public photos; unsupported document types remain rejected.
5. Video output extensions are selected from Telegram's file extension and declared MIME type. Conflicts and unsupported containers are rejected instead of silently renaming arbitrary video bytes to .mp4.
6. The application PR includes a regression test that deleting one photo from a mixed album leaves the remaining video/photo sequence intact.

## Verification limits
- GitHub Actions for PR #78 have failed before test steps started; no runner logs were available. The tests have not been executed.
- GitLab CI previously failed at the account identity-verification gate before jobs ran. Do not attempt to bypass that gate.
- The current GitLab deployment branch has not had a successful test run after these changes. Treat the changes as reviewed source only, not verified runtime behavior.

## Safe next sequence
1. Obtain a legitimate Node.js test runtime with no paid resource and no identity-gate bypass.
2. Run syntax checks and the complete tests for inventory, mirror, and parity scripts.
3. Re-read the latest approved-only export script and validate its allowlist and private output permissions.
4. Only after tests pass, perform a read-only approved-key inventory in a trusted environment; do not download media during inventory.
5. Review the private inventory for record counts, unknown-order albums, Telegram lookup failures, and total bytes.
6. Only after the user confirms the Russian storage provider and any required funding, prepare the isolated mirror. Keep private maps, exports, and reports outside the public directory.
7. Verify exact record/media parity and test access from real Russian mobile and fixed-line networks before calling the mirror operational.

## Privacy boundaries
- Only `car_approved:` and `approved:` records are eligible for public transfer.
- Never export pending moderation, private enquiries, administrator data, Telegram bot tokens, or other secrets to the public snapshot.
- Private exports, Telegram file identifiers, and media maps must remain private and be deleted securely after the mirror is verified.
- Never claim VPN-free availability in Russia until a real Russian-network check succeeds.
