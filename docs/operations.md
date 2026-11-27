# YAAPS Operations

This document covers operating a YAAPS instance: retention cleanup, backup, restore, upgrade, and incident response. The paths in the examples are illustrative; use the deployment's real data directory.

## Two instances during a rollout

YAAPS runs as one container. During a zero-downtime rollout, a second container with the new release starts beside it, and the two share one data directory until the old container has drained and stopped. Two instances on one data directory are safe because:

- every SQLite transaction takes the database write lock when it begins, so a write in one container waits for the other container's write (up to five seconds) instead of failing or overwriting it;
- an uploaded report becomes visible in `blobs/` only inside the transaction that records it, and blobs are removed only inside a transaction that first checks that no version references them, so neither container can remove a blob that the other is still uploading;
- the background cleanup runs on one container at a time: the container that holds the lock on `yaaps-leader.sqlite` in the data directory runs it, and the other skips that run;
- browser sessions, passkey challenges, invitations, and device connections are stored in SQLite, so either container serves them;
- only the new container runs migrations. A release's migrations are expand-only, so the old container keeps working on the new schema, or the release is marked as unable to run beside the previous one (see "Rollout labels").

These guarantees need both containers on one host with one data directory on a local filesystem, and the health check built into the image. Never run more than two instances, or instances on different hosts, against one data directory.

Accepted behaviour during a rollout:

- Rate limits are counted per container, so during the overlap a client can use each container's limit.
- A rollout takes about 30 seconds longer than a restart, because the old container drains first (see "Draining the old container").
- At startup each container copies its dashboard assets into `dashboard-assets/` and its skill package into `skill-downloads/` in the data directory, so a page or an installer from one release finds its files in either container. These directories grow by one build per release. Do not delete them: a deleted copy of the running release's files fails to load during the next rollout. They are not part of the backup unit; each container copies its own files again when it starts.
- Expiring a draft deletes all its versions in one transaction. For a draft with a very long version history, the other container's writes wait until that transaction completes.
- A public read records its view with a separate increment. If the increment fails, the failure is logged and the read still returns the report.

## Retention cleanup

The server checks for expired drafts every five minutes by default. Configure the interval with `YAAPS_CLEANUP_INTERVAL_SECONDS`; the minimum accepted value is 60 seconds.

Each cleanup run, on the container that holds the cleanup lock:

1. Selects drafts whose expiry is at or before the run timestamp.
2. Deletes them in batches of 20. Each batch is one transaction that checks the expiry again, so a draft whose expiry was extended meanwhile stays. A draft's versions are deleted with it.
3. Records one `draft.expired` audit event per deleted draft in the same transaction, without attributing a human or API-key actor.
4. Removes blobs that no version references, in batches of 100. Each batch checks the references and removes the files inside one transaction. A blob that cannot be removed is logged, and the next run tries again.
5. Removes temporary upload files that are older than one hour from `.blob-tmp/`. Younger files can belong to an upload in progress.

Deleting a draft removes its blobs right after the delete is committed. If that removal fails, the delete still succeeds, the failure is logged, and the next cleanup run removes the blobs. The server removes nothing at startup; leftovers from an interrupted run are removed by the next cleanup run.

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

An older image starts on a schema that a newer release changed only with
expand-only migrations, so going back to the previous release by its image
works after such an update. After a release with a breaking migration (see
"Rollout labels"), an older image refuses to start: restore the pre-upgrade
backup into a new data directory (see Restore above) and point the deployment
at it instead. Keep the pre-upgrade backup until the new version has been
verified in production.

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

The release workflow computes `yaaps.rollout-from` with `.github/tools/rollout-from.sh` from the Git history of the release tag. It considers only earlier stable releases whose tags are in the history of the release tag, so a later release or a release from another branch never changes the value, and a re-run computes the same value. The label is the newer of:

- the first release that supports rollouts: the oldest earlier release that contains `.github/tools/rollout-from.sh`;
- the release that added the newest breaking migration, a migration whose name ends in `.breaking`.

When the release itself is the first release that supports rollouts, or itself adds a breaking migration, the label is its own version. Such a release cannot run beside the running one and is updated with a short stop, using the commands in "Update a pinned deployment". The first release that supports rollouts is always deployed this way.

`docker rollout` does not read these labels. Check them before every rollout, whether a tool or a person runs it.

### Draining the old container

The image carries the `docker-rollout.pre-stop-hook` label. docker rollout runs that hook in the old container before it stops it. The hook creates the marker `/tmp/drain` and waits 30 seconds. While the marker exists, the image's health check fails, so the container turns unhealthy within about 20 seconds, and Traefik stops routing to it, because Traefik's Docker provider leaves out unhealthy containers. When docker rollout then stops the container, the server finishes the requests it still holds within the stop grace period. A container removes the marker when it starts, so a restarted container serves again.

Limits:

- A request that is still open when the container stops is cut. Uploads take seconds, so this is rare.
- docker rollout 0.14 stops the old container even when the hook fails, for example when `/tmp` is not writable.
- docker rollout 0.14 can remove the old container when the new container exits right after it starts ([wowu/docker-rollout#75](https://github.com/wowu/docker-rollout/issues/75)). YAAPS avoids exiting at startup where it can: when it cannot copy its dashboard assets or skill package into the data directory, it logs the error and stays not ready, so the rollout times out and keeps the old container.

### What the host's Compose file needs

The tracked `docker-compose.yml` is an example. A host that pins the version and is updated by such a tool needs, in its own Compose file and `.env`:

- `name: yaaps` at the top of `docker-compose.yml`;
- the service `app` with `image: ghcr.io/shlomiporush/yaaps:${VERSION}`;
- no `container_name`, no published host port, no `network_mode: host`, no `build`, and one replica: route traffic through a reverse proxy, as the example does;
- no `healthcheck:` for `app`, so the image's health check, which reports the drain, applies. The tracked example defines one; remove it in the host's file;
- a writable `/tmp`. With `read_only: true`, mount a `tmpfs` on `/tmp`, as the example does. Without it, the hook cannot create the drain marker, and docker rollout stops the old container without draining it;
- `stop_grace_period` of at least 10 seconds;
- the data directory on the same host for both containers, as a bind mount or a local volume;
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

Every Compose command names the project, the file and `.env`, ignores a `VERSION` exported in the shell, and leaves containers of other Compose files alone, so the shell environment cannot point it at another project or release. If the commands stop before step 4, nothing was replaced: the old release keeps serving, or, when the first check found no running `app`, nothing changed and the cause is unrelated to the update. Fix the cause and run them again. If `app` does not become healthy in step 4, set `VERSION` back to the release you wrote down. If that release refuses to start because the new release ran a breaking migration, restore the backup (see Restore) first.

### When a release run fails

The release workflow has four jobs: the image (`sha-<commit>`, then `X.Y.Z`), `latest`, the npm package, and the GitHub release. `latest` and npm run after the image, and the GitHub release after both. For a pre-release, the `latest` job leaves the tag as it is.

- Re-run a failed `latest`, npm or GitHub release job with "Re-run failed jobs". `latest` points the tag at the published `X.Y.Z` without a rebuild, and none of them publishes the image again. Re-run a failed `latest` job only while no newer stable release is published; otherwise it would move `latest` back to an older release.
- Re-run a failed image job when it stopped before `X.Y.Z` was pushed. Once `X.Y.Z` is published, the image job refuses to run again.
- If the image job of a stable release failed although `X.Y.Z` is published, for example because the connection broke at the end of the push, the later jobs did not run. Finish the release by hand in a fresh clone of the repository, signed in to npm and to the GitHub CLI. The commands stop unless the published image was built from the release tag, and stop at the first step that fails. A package published by hand has no provenance.

  ```bash
  TAG=vX.Y.Z
  IMAGE=ghcr.io/shlomiporush/yaaps
  VERSION="${TAG#v}"
  git checkout --detach "$TAG" &&
    REVISION="$(docker buildx imagetools inspect "$IMAGE:$VERSION" --format '{{index .Image.Config.Labels "org.opencontainers.image.revision"}}')" &&
    COMMIT="$(git rev-parse HEAD)" &&
    [ -n "$REVISION" ] && [ "$REVISION" = "$COMMIT" ] &&
    echo "$IMAGE:$VERSION was built from $TAG." &&
    npm ci &&
    npm run build --workspace yaaps-ai &&
    npm publish --workspace yaaps-ai --access public &&
    awk -v v="$VERSION" '$0 ~ "^## \\[" v "\\]" {found=1; next} found && /^## / {exit} found {print}' docs/CHANGELOG.md |
    gh release create "$TAG" --verify-tag --title "$TAG" --notes-file -
  ```

  Then, only while no newer stable release is published, point `latest` at `X.Y.Z` with the command below.

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
