# Changelog

All notable changes to YAAPS are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## [1.6.1] - 2026-09-01

### Changed

- Updated the React DOM development type definitions used to validate the dashboard.

## [1.6.0] - 2026-08-27

### Changed

- Connected publishing is now the default across the API, CLI, and Agent Skill helpers; choose isolated mode explicitly for reports that must block automatic external resource loading.

## [1.5.0] - 2026-08-27

### Added

- Show total public views for each report and immutable version in owner APIs and the dashboard.

### Changed

- The YAAPS Agent Skill now selects connected publishing whenever a report automatically loads external HTTPS presentation resources, including web fonts, and reserves isolated publishing for fully embedded reports.

## [1.4.0] - 2026-08-27

### Added

- Publishers can choose an isolated or connected resource policy for each immutable report version. Isolated remains the default, while connected reports may load HTTPS images, fonts, and stylesheets; HTTPS hyperlinks work in both modes, and active content and programmatic network access remain blocked.

## [1.3.1] - 2026-08-27

### Changed

- The landing publishing chat now uses a locally hosted bilingual Rubik typeface for conversational text while keeping command and report-link fragments monospace.

## [1.3.0] - 2026-08-26

### Added

- Reports can be grouped under a category. The dashboard shows each report's category, filters the list by it, and lets it be set, changed, or cleared; the agent API accepts a category when publishing, updating, and listing drafts and reports the categories in use; the CLI adds `publish --category`, `list --category`, and `categorize`; and the Agent Skill helpers expose the same commands.

## [1.2.0] - 2026-08-26

### Added

- A monthly GitHub Actions check now raises the deferred upgrades for discussion when Node.js 26 reaches LTS or the latest typescript-eslint release supports TypeScript 7, without changing dependencies or creating duplicate issues.

### Changed

- The public landing page now explains publishing through a localized chat illustration that shows a natural-language request, YAAPS processing, and a temporary report link with its live expiry time.
- Merges to main no longer rerun the full verification matrix, and a release pull request that only bumps the version files now runs the light quality checks alone; pull requests, the weekly scheduled run, and the release tag remain the verification gates, and the release tag reruns full verification before anything is published.

## [1.1.0] - 2026-08-26

### Added

- API keys can be renamed from the dashboard, so a key's name can stay meaningful without revoking and recreating it.
- A report's expiry can be extended from the dashboard with one-day, one-week, or 30-day presets counted from the moment of the change, within the instance retention limits. The agent API accepts the same `ttlSeconds` field when updating a draft.

### Changed

- A report's title in the dashboard now opens the shared report directly, and the open-report link looks like the other row actions instead of a plain text link.
- The report list shows the expiry date in the device's regional date format, with the remaining time in parentheses.

### Fixed

- Share-preview images are now served with a relaxed cross-origin resource policy, so browser-based link-preview checkers can display the social card image instead of a broken placeholder.
- The Windows skill helper no longer crashes while waiting for connection approval when PowerShell 7 runs with a non en-US regional format, which previously lost the approval and left the device unconnected.
- The CLI now accepts draft IDs that start with `-` for `inspect`, `disable`, `enable`, and `delete` instead of failing with an unknown option error, and newly generated draft IDs avoid a leading dash.

## [1.0.1] - 2026-08-26

### Fixed

- Added the repository metadata that npm provenance verification requires to the published `yaaps-ai` package.

## [1.0.0] - 2026-08-26

Initial release.

### Added

- Passkey (WebAuthn) authentication with invitations, optional open self-registration, recovery codes, revocable sessions, roles, and audit events.
- Owner-scoped report drafts with immutable versions, configurable expiry, scheduled retention cleanup, and public capability URLs under `/d/`.
- Strict server-side HTML validation and sandboxed report serving that blocks scripts, forms, frames, plugins, and network access.
- Bearer API keys and a browser-approved agent connection flow that keeps the full key out of chat, shell history, and the server.
- The `yaaps-ai` CLI for connecting, publishing self-contained HTML with local bitmap embedding, and managing draft lifecycle.
- A provider-neutral Agent Skill with Windows, macOS, and Linux helpers, origin-bound installers, and Codex and Claude packaging.
- A localized English and Hebrew dashboard with RTL and LTR layouts, light and dark themes, and responsive desktop and mobile support.
- An OpenAPI 3.1 contract with self-hosted Swagger UI and ReDoc documentation.
- SQLite metadata with content-addressed immutable HTML storage, coordinated backup and restore, and startup orphan recovery.
- A hardened Docker image and Compose deployment, full local verification tooling, and tag-driven publication of the container image and npm package.
