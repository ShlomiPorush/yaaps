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
