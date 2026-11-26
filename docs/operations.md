# YAAPS Operations

This document covers operating a YAAPS instance: retention cleanup, backup, restore, upgrade, and incident response. The paths in the examples are illustrative; use the deployment's real data directory.

## Single-instance boundary

YAAPS supports one server process against one data directory. Do not run multiple replicas against the same SQLite database or blob directory. Browser sessions, cleanup locking, SQLite writes, and immutable blob reclamation have not been designed for a multi-instance deployment.

## Retention cleanup

The server checks for expired drafts every five minutes by default. Configure the interval with `YAAPS_CLEANUP_INTERVAL_SECONDS`; the minimum accepted value is 60 seconds.

Each cleanup run:

1. Selects drafts whose expiry is at or before the run timestamp.
2. Deletes their metadata and versions transactionally.
3. Records one `draft.expired` audit event per draft without attributing a human or API-key actor.
4. Removes blobs that are no longer referenced by any version.

Runs are serialized with report writes and cannot overlap within the supported single process. If the process stops after metadata deletion but before blob removal, startup orphan recovery or the next cleanup completes reclamation.

## Development smoke test

Build the workspace and create a disposable API key for the development environment. Supply the key only through the process environment, then run:

```powershell
$env:YAAPS_SMOKE_ORIGIN = "http://localhost:9099"
$env:YAAPS_SMOKE_API_KEY = "<disposable-api-key>"
npm run smoke
Remove-Item Env:YAAPS_SMOKE_API_KEY
```

The workflow verifies health and readiness through the CLI, publishes a temporary self-contained report, checks its public body and sandbox CSP, disables and re-enables it, deletes it, and confirms that it is unavailable. Its `finally` path attempts exact-draft cleanup after a failure. The full API key is never printed or accepted as a command-line argument.

Run `npm run test:load` locally for the bounded single-instance concurrency drill. The unit-test command schedules this drill as a separate phase so unrelated test workers cannot distort its timing. It publishes 16 drafts and 64 immutable versions, performs 320 concurrent public reads while cleanup runs between write rounds, and finishes with SQLite integrity and metadata-count checks. This is a repeatable safety drill, not a capacity claim for the deployment host.

## Backup

Build the server operation first:

```powershell
npm run build --workspace @yaaps/server
```

Create a backup directory outside the data directory:

```powershell
npm run data -- backup C:\yaaps\data D:\yaaps-backups\2026-08-24T120000Z
```

The operation uses SQLite's online backup API to produce a consistent database snapshot. It then copies exactly the immutable blobs referenced by that snapshot, validates their content addresses and byte lengths, writes a checksummed manifest, and atomically publishes the backup directory. A concurrent cleanup can cause the operation to fail safely; retry a failed backup after inspecting the error.

A backup contains report content, hashed credentials, session state, audit data, and other sensitive metadata. Move it off the application host and encrypt it using the operator's approved backup system. YAAPS does not invent or store an application-managed backup encryption key.

## Restore

Stop the YAAPS service before selecting a restored directory for runtime use. Restore always requires a destination that does not exist and an exact absolute-path confirmation:

```powershell
npm run data -- restore D:\yaaps-backups\2026-08-24T120000Z C:\yaaps\restored --confirm C:\yaaps\restored
```

Restore validates the manifest, SQLite integrity and checksum, the exact database-referenced blob set, and every blob's content address before atomically publishing the restored data directory. It never merges into or overwrites an existing directory.

After restore, start one disposable YAAPS instance against the restored directory and verify `/readyz`, authenticated draft metadata, and at least one public report before changing the production data reference. Keep the previous data directory untouched until that verification and rollback window are complete.

## Upgrade and rollback

Upgrades replace the running image and rely on the forward-only startup
migrations in the server image.

1. Take a fresh backup and verify it (see Backup above) before touching the
   deployment.
2. Pull the new image and restart: `docker compose pull && docker compose up -d`.
   To control exactly which version runs, pin the `image:` reference in
   `docker-compose.yml` to a version tag or digest instead of `latest`.
3. Confirm `/readyz` returns `ready` and that an existing public report and the
   dashboard both load.

Rolling back the image after a migration has run is not supported: restore the
pre-upgrade backup into a new data directory (see Restore above) and point the
deployment at it instead. Keep the pre-upgrade backup until the new version has
been verified in production.

A deployment that pins the version in `.env` updates with the commands in
"Update a pinned deployment" below.

## Release images and rollouts

### Image tags

Each release `vX.Y.Z` publishes `ghcr.io/shlomiporush/yaaps` with these tags:

| Tag            | Meaning                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `X.Y.Z`        | The release. It is pushed only after the release passed full verification, and it never moves. |
| `sha-<commit>` | The same image, by the commit it was built from.                                               |
| `latest`       | The latest stable release. Pre-releases do not move it.                                        |

The release workflow refuses to run for a version whose `X.Y.Z` tag already exists, so a re-run cannot replace a published image.

### Rollout labels

Each release image carries two labels for deployment tools that replace a running container with a zero-downtime rollout with docker rollout:

| Label                  | Value                                                                       |
| ---------------------- | --------------------------------------------------------------------------- |
| `yaaps.compose-sha256` | The SHA-256 of the tracked `docker-compose.yml` of that release.            |
| `yaaps.rollout-from`   | The oldest running release that this image may run beside during a rollout. |

Such a tool compares the labels of the running image and the new image, and updates without downtime only when both images have the same `compose-sha256` and the running release is not older than `rollout-from`.

YAAPS is single-instance (see "Single-instance boundary"), so `yaaps.rollout-from` is the release's own version: every update replaces the running container with a short stop. Do not run `docker rollout` on YAAPS directly. It does not read these labels and would start a second instance on the same data directory.

### What the host's Compose file needs

The tracked `docker-compose.yml` is an example. A host that pins the version and is updated by such a tool needs, in its own Compose file and `.env`:

- `name: yaaps` at the top of `docker-compose.yml`;
- the service `app` with `image: ghcr.io/shlomiporush/yaaps:${VERSION}`;
- no `container_name`, no published host port, no `network_mode: host`, no `build`, and one replica: route traffic through a reverse proxy, as the example does;
- exactly one `VERSION=X.Y.Z` line in `.env`. The server ignores this variable when `env_file` passes it to the container.

### Update a pinned deployment

Take and verify a backup first (see Backup). Run these commands in the directory that holds the host's `docker-compose.yml` and `.env`, with the new version in `NEW`:

```bash
NEW=X.Y.Z
IMAGE=ghcr.io/shlomiporush/yaaps
compose() { env -u VERSION COMPOSE_REMOVE_ORPHANS=false docker compose -p yaaps -f docker-compose.yml --env-file .env "$@"; }
[ "$(grep -c '^VERSION=' .env)" = 1 ] &&
  RUNNING="$(compose ps --quiet app)" && [ -n "$RUNNING" ] &&
  docker inspect --format 'Running before the update: {{.Config.Image}}' "$RUNNING" &&
  docker pull "$IMAGE:$NEW" &&
  NEW_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE:$NEW")" &&
  [ "$(env VERSION="$NEW" docker compose -p yaaps -f docker-compose.yml --env-file .env config --images app)" = "$IMAGE:$NEW" ] &&
  sed -i "s/^VERSION=.*/VERSION=$NEW/" .env &&
  compose up -d --no-deps --pull never --wait --wait-timeout 300 app &&
  [ "$(docker inspect --format '{{.Image}}' "$(compose ps --quiet app)")" = "$NEW_ID" ] &&
  echo "Updated to $NEW."
```

The commands stop at the first step that fails, and nothing after it runs. They:

1. require one `VERSION` line in `.env` and a running `app` container in the `yaaps` project;
2. print the image that runs before the update. Write it down with the backup;
3. pull the new image and check that the Compose file resolves `app` to it before `.env` changes;
4. replace the container in one step from the image that was pulled, and wait until it is healthy;
5. check that the running container uses that image.

Every Compose command names the project, the file and `.env`, ignores a `VERSION` exported in the shell, and leaves containers of other Compose files alone, so the shell environment cannot point it at another project or release. If the commands stop before step 4, nothing was replaced: the old release keeps serving, or, when the first check found no running `app`, nothing changed and the cause is unrelated to the update. Fix the cause and run them again. If `app` does not become healthy in step 4, restore the backup (see Restore) and set `VERSION` back to the release you wrote down. Rolling back the image alone is not supported once the new release has run its migrations.

### When a release run fails

The release workflow has four jobs: the image (`sha-<commit>`, then `X.Y.Z`), `latest`, the npm package, and the GitHub release. `latest` and npm run after the image, and the GitHub release after both. For a pre-release, the `latest` job leaves the tag as it is.

- Re-run a failed `latest`, npm or GitHub release job with "Re-run failed jobs". `latest` points the tag at the published `X.Y.Z` without a rebuild, and none of them publishes the image again. Re-run a failed `latest` job only while no newer stable release is published; otherwise it would move `latest` back to an older release.
- Re-run a failed image job when it stopped before `X.Y.Z` was pushed. Once `X.Y.Z` is published, the image job refuses to run again.
- If the image job failed although `X.Y.Z` is published, for example because the connection broke at the end of the push, the later jobs did not run. Check that the published image was built from the release tag, from a checkout of the repository:

  ```bash
  TAG=vX.Y.Z
  IMAGE=ghcr.io/shlomiporush/yaaps
  [ "$(docker buildx imagetools inspect "$IMAGE:${TAG#v}" --format '{{index .Image.Config.Labels "org.opencontainers.image.revision"}}')" = "$(git rev-parse "$TAG^{commit}")" ] &&
    echo "$IMAGE:${TAG#v} was built from $TAG."
  ```

  When it prints that line, finish the release by hand from the tagged commit: point `latest` at the version as shown below (stable releases only), publish the CLI with `npm ci`, `npm run build --workspace yaaps-ai` and `npm publish --workspace yaaps-ai --access public` (a package published by hand has no provenance), and create the GitHub release with `gh release create "$TAG" --verify-tag --title "$TAG"` and the changelog section as notes. When it does not print that line, do not finish the release: the published image was not built from this tag, or the check could not read it.

- The check that refuses published versions requires `latest` to exist. If `latest` was deleted, point it at the latest stable release before publishing. The same command points `latest` at a version by hand:

  ```bash
  docker buildx imagetools create -t ghcr.io/shlomiporush/yaaps:latest ghcr.io/shlomiporush/yaaps:X.Y.Z
  ```

- Do not re-run release runs that started before this check existed. They use the earlier workflow, which pushes the version tag again.

## Observability baseline

The server writes structured pino logs to stdout only; there is no metrics
endpoint. The tracked Compose file bounds container logs (json-file driver,
10 MB x 3 files) so the host disk cannot fill from logging alone.

At minimum, watch for these log signals:

- `Retention cleanup failed.` - expired reports are not being reclaimed.
- `YAAPS data initialization failed` - the process exits non-zero so the
  restart policy can retry; repeated restarts indicate a corrupt volume or a
  permissions problem.
- Sustained `RATE_LIMITED` responses on `/auth/*` routes - possible
  credential-stuffing or a misbehaving client.

`/healthz` reports process liveness and `/readyz` verifies that the data
directory is writable; alert on `/readyz` failures, not on container liveness.

## Rotation and incidents

- Revoke a compromised API key in the dashboard and create a replacement. Existing keys cannot be recovered from storage.
- Disable a compromised user to revoke sessions and API keys and disable every currently enabled report owned by that user. Re-enabling the user does not automatically republish those reports.
- Rotate `YAAPS_BOOTSTRAP_SECRET` after initial bootstrap; bootstrap remains unusable once any user exists.
- Treat lost recovery codes and passkeys as an account recovery incident. YAAPS does not provide email recovery or administrator impersonation.
- Preserve audit events and relevant redacted server logs during investigation. Never copy report bodies, full keys, session cookies, recovery codes, invitation tokens, or passkey challenges into tickets or chat.
