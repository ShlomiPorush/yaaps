# YAAPS Project Instructions

YAAPS turns HTML reports created by AI agents into temporary, shareable links. The npm workspace contains the Fastify server (`apps/server`), the localized React dashboard (`apps/dashboard`), shared Zod contracts (`packages/contracts`), the `yaaps-ai` CLI (`packages/cli`), and the portable Agent Skill with its OS helpers (`plugins/yaaps`).

## Product boundary

YAAPS publishes temporary, self-contained HTML reports from authenticated agents. Public readers use high-entropy capability URLs. The dashboard supports passkeys, drafts, immutable versions, API keys, and administration. Registration is invitation-based, with optional open self-registration through `YAAPS_OPEN_REGISTRATION`.

Do not expand the product into arbitrary file hosting, organizations, collaboration, billing, permanent archival storage, executable reports, or a generic rendering platform without an explicit product decision.

## Repository policy

- Use English for repository documentation, code, comments, fixtures, tests, commits, Issues, pull requests, reviews, and GitHub discussion.
- Keep user-facing strings in the localization files. The Hebrew exception is exactly `apps/dashboard/src/locales/he.json`. Tests must load Hebrew samples from that file instead of duplicating Hebrew literals.
- The root `VERSION` file is the single version source. Run `npm run version:sync` after changing it; never edit package versions by hand.
- Add substantive user-visible or operational changes under `Unreleased` in `docs/CHANGELOG.md`. Do not bump versions in ordinary pull requests.
- Commit the standard `package-lock.json` and install from the lockfile in Docker and CI.
- Never commit credentials, passkeys, recovery codes, API keys, session secrets, bootstrap secrets, server identifiers, generated production configuration, or report content created during live verification.

## Security invariants

These are non-negotiable boundaries unless the repository owner explicitly approves a product change:

- Every user-owned query is scoped by owner, with negative cross-user authorization tests.
- Browser sessions and agent API keys use separate authentication middleware.
- API keys and recovery codes are displayed once and stored only as hashes plus non-secret identifying metadata.
- Public report routes reveal no owner, local-path, credential, or private audit metadata.
- HTML is parsed and validated on the server even when the CLI already validated it.
- Reports cannot execute scripts, submit forms, embed frames/plugins, or make network requests.
- Every `/d/*` HTML response receives a server-controlled CSP `sandbox` without `allow-same-origin` or `allow-scripts`, plus the supporting isolation headers asserted by the report route tests.
- Uploaded filenames never become filesystem paths. Immutable blobs are written atomically.
- SQLite metadata and the HTML blob directory are one logical backup unit.
- The service remains single-instance until storage, cleanup locking, sessions, and shared files are deliberately redesigned and verified.
- Passkeys are bound to the deployment hostname. Do not register production credentials against a provisional hostname.

## Docker and data safety

- `docker-compose.yml` is the tracked production definition. `docker-compose.dev.yml` is the local development definition and must remain ignored by Git.
- Neither Compose file may contain `build:`. Workflow tooling builds images explicitly before changing the running environment.
- The data directory is bind-mounted and survives ordinary shutdown. Destructive volume operations must resolve and display the exact target and require explicit confirmation.
- Startup verification must check meaningful health and the identity of the image actually running.

## Verification

`npm run verify` is the authoritative full local verification command. Use `npm run verify -- --skip-docker` only when Docker execution is intentionally out of scope, and report that omission. Changed-area mode is available as `npm run verify -- --changed` once Git has a comparison base.

For implementation changes:

- Add evidence that fails without each security boundary and passes with it.
- Exercise report sandboxing in a real supported browser, not only by matching header text.
- Test supported locales, directions, themes, keyboard interaction, and relevant viewport sizes for dashboard changes.
- Run production-shaped Docker verification and inspect health and running image identity.
- Verify backups with an actual restore drill before claiming production readiness.
- Clean up any live verification data and confirm the original state is restored.

Never claim a test, screenshot, browser flow, backup, deployment, cleanup, or release succeeded unless it was performed and inspected.

## Delegation model

When the assistant leading a session can spawn subagents, it works as a supervisor rather than an implementer:

- Delegate implementation, research, and test-writing work to subagents with clear, self-contained briefs.
- Review every subagent result against this file's requirements and independently verify it (run the checks, inspect the diff) before committing, pushing, or merging.
- The lead performs directly only what delegation handles poorly: small glue fixes, conflict resolution, Git and GitHub state changes, and final verification.
- Parallel subagents must not share one working tree; give concurrent work isolated worktrees or serialize it.

## Release procedure

Releases require explicit owner authorization and happen in a dedicated release pull request, never mixed into feature work.

1. Start from a clean, up-to-date `main` and set the new SemVer in the root `VERSION` file.
2. Run `npm run version:sync` (updates every workspace `package.json` and `FOUNDATION_VERSION` in `packages/contracts/src/index.ts`), then `npm install` to refresh the workspace entries in `package-lock.json`. Skipping the install breaks `npm ci` in CI before any version check runs.
3. In `docs/CHANGELOG.md`, insert `## [X.Y.Z] - YYYY-MM-DD` directly beneath an emptied `## Unreleased` heading and move the accumulated bullets into it, keeping the `### Added` / `### Changed` / `### Fixed` order. The GitHub release notes are extracted from exactly this section; a missing heading silently degrades them to a placeholder.
4. Verify, open the release PR, and merge it with CI green.
5. Tag the merge commit `vX.Y.Z` and push the tag. The tag workflow rejects the release unless the tag version equals `VERSION`, the root and CLI `package.json` versions, and `FOUNDATION_VERSION`; it then reruns full verification, publishes the container image to `ghcr.io/shlomiporush/yaaps` (`X.Y.Z`, `sha-*`, and `latest` for stable versions), publishes `yaaps-ai` to npm through the OIDC trusted publisher (fails if the version already exists on npm), and creates the GitHub release from the changelog section.

## Git and external boundaries

The repository owner controls merges, releases, deployments, production changes, DNS, GitHub configuration, and registry publication. Do not perform them without explicit authorization in the current request.
