# Russian mirror host decision — 2026-11-15

## Decision

Preferred next target: **GitVerse Pages**, not Tuqo, for a complete static mirror containing video files.

Official documentation:
- Pages supports static assets and custom CI/CD workflows: https://gitverse.ru/docs/pages/docs/from-workflow
- Maximum Pages build artifact: 500 MB: https://gitverse.ru/docs/pages/overview/
- GitVerse Free includes 2,000 CI/CD minutes/month: https://gitverse.ru/home/pricing/
- Free Pages publication requires a public repository; private Pages requires Pro: https://gitverse.ru/docs/pages/docs/requirements/

GitVerse is a Russian platform, but Russian mobile-operator reachability still must be tested from actual MTS, MegaFon, Beeline, T2 and fixed-line networks. Do not claim no-VPN compatibility until tested.

## Why Tuqo is not the final media host

Tuqo Free advertises 150 MB storage and static hosting, and its own FAQ says it does not provide video hosting/transcoding:
- https://tuqo.dev/pricing/
- https://tuqo.dev/

The Tuqo build target in this branch is retained as a guarded small-static-site path, not as the final home for the complete media archive.

## Safe public-repository design

The existing sokfrut-tech/avtoy-korea-auto repository is private and must remain private. Do not publish or mirror the entire repository.

Create a separate, dedicated public GitVerse repository containing only:
- the minimal public-catalogue exporter;
- static-site builder and origin verifier;
- GitVerse Pages workflow;
- generated approved public HTML/CSS/JS and media assets after a successful build.

Never include:
- Worker source or private project documentation;
- Cloudflare or Telegram credentials;
- private exports, Telegram file IDs or media maps;
- moderation queue, private enquiries, admin IDs, customer phone numbers or private contact records.

The build should fetch only the public approved /api/cars and /api/reviews endpoints, copy every eligible photo/video into the output, verify original order when source metadata proves it, and fail closed on any missing/ambiguous media. It must not silently omit oversized files or publish a partial archive.

## Capacity gate

GitVerse Pages has a 500 MB maximum artifact. Use a conservative 450 MiB output gate (including HTML, CSS, media and manifests). If the archive exceeds this, stop and report the exact shortfall; do not split content across foreign hosts or hotlink the primary Worker.

## CI/CD

GitVerse Pages supports .gitverse/workflows and official gitverse/upload-pages-artifact@v1.0.0 plus gitverse/deploy-pages@v1.0.0. This uses GitVerse-hosted runners and is independent of the blocked GitHub Actions and GitLab CI runner paths.

## Current state

- The private GitHub deployment branch deploy/russian-tuqo-static-2026-11-15 contains a guarded static exporter/build target.
- A matching research branch exists in GitLab.
- No media inventory has run; actual archive size is unknown.
- No Russian mirror has been deployed.
- The next owner-only step is to create a separate public GitVerse repository for the sanitized mirror. Do not change visibility of the existing private repository.
