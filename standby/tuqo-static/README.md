# AVTOY KOREA — Russian static mirror build target

This folder is a dedicated Tuqo Git-CD entry point. It does not alter the primary Worker, the primary AppDeploy app, DNS, or the existing backup app.

## Build

Tuqo's Git CD can connect to the private GitHub repository and build this folder on its own Node 24 runner. It does not require GitHub Actions or GitLab CI runners.

Configure:
- Repository: `sokfrut-tech/avtoy-korea-auto`
- Branch: `deploy/russian-tuqo-static-2026-11-15`
- Root directory: `standby/tuqo-static`
- Build command: `npm ci && npm run build`
- Output directory: `dist`

The build downloads only public catalogue records from the existing public Worker API, localizes media into the build output, generates the static site, and rejects external runtime origins. The final page/media requests must not depend on Cloudflare, AppDeploy, or Telegram.

## Hard stop conditions

- Any public API/schema/media error aborts the build.
- Mixed photo/video records without proven original ordering abort the build.
- Any media item above the exporter's 25 MB safety limit aborts the build.
- The output must stay below 140 MiB and 1,800 files. This is a safety margin under Tuqo Free's published 150 MB storage limit.
- No partial catalogue is published by this build.

## Important provider limitation

Tuqo Free currently advertises 150 MB static storage and explicitly says it does not provide video hosting/transcoding. This target is therefore a deployment/build path for a small static mirror only; it is **not yet approved as the final home for the complete video archive**. Do not enable deployment until the actual inventory proves the output fits and a Russia-hosted video origin has been selected for any videos Tuqo cannot serve.

The current build target is deliberately fail-closed: it never silently omits an approved media item. It is not a claim that the mirror is deployed or that Russian ISP reachability has been tested.

## Owner action required

Tuqo must be connected to the private repository from the account owner's browser. Use the provider's Git CD connection flow and authorize the repository there; never paste a GitHub token into ChatGPT. The provider documents GitHub OAuth.

Official provider documentation:
- https://tuqo.dev/git/
- https://tuqo.dev/pricing/
- https://tuqo.dev/
