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
