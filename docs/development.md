# Development

## Requirements

- Node.js 24
- npm 11
- Bash 5 in WSL or Linux
- Docker with Compose

## Setup

Install the workspace and browser dependency:

```sh
npm ci
npx playwright install chromium
```

Build the workspace:

```sh
npm run build
```

Run the server locally after a build:

```sh
YAAPS_DATA_DIR=.local-data YAAPS_HOST=127.0.0.1 YAAPS_PORT=9099 \
YAAPS_BOOTSTRAP_SECRET=<any-random-value-of-at-least-32-characters> \
node apps/server/dist/index.js
```

The dashboard is served from the same process at `http://127.0.0.1:9099`. On first run, open `/login` and use the bootstrap secret to register the first administrator passkey; remove `YAAPS_BOOTSTRAP_SECRET` from the environment afterwards. All configuration is read from `YAAPS_*` variables with localhost defaults (see `apps/server/src/config.ts`).

When YAAPS is running, the HTTP API is documented at `/docs`, `/docs/swagger`, `/docs/redoc`, and `/openapi.json`.

## Verification

Run the complete repository verification, including formatting, linting, type checks, tests, browser flows, builds, packaging checks, Compose validation, and an isolated Docker execution:

```sh
npm run verify
```

## Releases

The root `VERSION` file is the single version source. After changing it, run `npm run version:sync` and `npm install` to propagate the version and refresh the lockfile. Pushing a `v*` tag runs full verification and then publishes the server image to `ghcr.io/shlomiporush/yaaps` and the `yaaps-ai` CLI to npm.
