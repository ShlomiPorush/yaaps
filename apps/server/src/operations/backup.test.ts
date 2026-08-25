import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createBackup, restoreBackup } from "./backup.js";
import { HtmlBlobStore } from "../storage/blob-store.js";
import { openDatabase, type YaapsDatabase } from "../storage/database.js";
import { DraftStorage } from "../storage/draft-storage.js";

const temporaryPaths: string[] = [];
const databases: YaapsDatabase[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-backup-test-"));
  temporaryPaths.push(directory);
  return directory;
}

function html(body: string): Buffer {
  return Buffer.from(
    `<!doctype html><html><head><title>Backup</title></head><body>${body}</body></html>`,
  );
}

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map((entry) => entry.connection.destroy()),
  );
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

describe("coordinated data backup and restore", () => {
  it("restores a live SQLite snapshot and its exact referenced blob set", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "source");
    const backup = path.join(root, "backup");
    const restored = path.join(root, "restored");
    const sourceDatabase = await openDatabase(source);
    databases.push(sourceDatabase);
    await sourceDatabase.connection
      .insertInto("users")
      .values({
        created_at: "2026-08-24T08:00:00.000Z",
        disabled_at: null,
        display_name: "Backup owner",
        id: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
        role: "user",
        status: "active",
        webauthn_user_id: null,
      })
      .executeTakeFirstOrThrow();
    const sourceDrafts = new DraftStorage(
      sourceDatabase.connection,
      new HtmlBlobStore(source),
    );
    const draft = await sourceDrafts.createDraft({
      expiresAt: "2026-08-31T08:00:00.000Z",
      html: html("<p>snapshot version</p>"),
      ownerId: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
      title: "Backup report",
      uploadedByApiKeyId: null,
    });

    const manifest = await createBackup(
      source,
      backup,
      new Date("2026-08-24T12:00:00.000Z"),
    );
    expect(manifest).toMatchObject({
      blobs: [{ key: draft.blobKey }],
      createdAt: "2026-08-24T12:00:00.000Z",
      formatVersion: 1,
    });

    await sourceDrafts.addVersion({
      draftId: draft.draftId,
      expiresAt: "2026-08-31T08:00:00.000Z",
      html: html("<p>created after backup</p>"),
      ownerId: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
      uploadedByApiKeyId: null,
    });
    await restoreBackup(backup, restored);
    const restoredDatabase = await openDatabase(restored);
    databases.push(restoredDatabase);
    const restoredDrafts = new DraftStorage(
      restoredDatabase.connection,
      new HtmlBlobStore(restored),
    );
    await expect(
      restoredDrafts.resolvePublic(
        draft.draftId,
        undefined,
        new Date("2026-08-24T12:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      html: html("<p>snapshot version</p>"),
      status: "available",
      versionNumber: 1,
    });
  });

  it("refuses overwrite and removes partial restore state after corruption", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "source");
    const backup = path.join(root, "backup");
    const restored = path.join(root, "restored");
    const sourceDatabase = await openDatabase(source);
    databases.push(sourceDatabase);
    await sourceDatabase.connection
      .insertInto("users")
      .values({
        created_at: "2026-08-24T08:00:00.000Z",
        disabled_at: null,
        display_name: "Backup owner",
        id: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
        role: "user",
        status: "active",
        webauthn_user_id: null,
      })
      .executeTakeFirstOrThrow();
    const drafts = new DraftStorage(
      sourceDatabase.connection,
      new HtmlBlobStore(source),
    );
    await drafts.createDraft({
      expiresAt: "2026-08-31T08:00:00.000Z",
      html: html("<p>corrupt me</p>"),
      ownerId: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
      uploadedByApiKeyId: null,
    });
    const manifest = await createBackup(source, backup);
    await writeFile(
      path.join(backup, ...manifest.blobs[0]!.key.split("/")),
      "corrupt",
    );

    await expect(restoreBackup(backup, restored)).rejects.toThrow();
    expect(
      (await readdir(root)).some((entry) => entry.startsWith("restored")),
    ).toBe(false);
    await expect(createBackup(source, backup)).rejects.toThrow(
      "destination already exists",
    );
  });

  it("does not publish a partial backup when a referenced blob is missing", async () => {
    const root = await temporaryDirectory();
    const source = path.join(root, "source");
    const backup = path.join(root, "backup");
    const sourceDatabase = await openDatabase(source);
    databases.push(sourceDatabase);
    await sourceDatabase.connection
      .insertInto("users")
      .values({
        created_at: "2026-08-24T08:00:00.000Z",
        disabled_at: null,
        display_name: "Backup owner",
        id: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
        role: "user",
        status: "active",
        webauthn_user_id: null,
      })
      .executeTakeFirstOrThrow();
    const blobs = new HtmlBlobStore(source);
    const drafts = new DraftStorage(sourceDatabase.connection, blobs);
    const draft = await drafts.createDraft({
      expiresAt: "2026-08-31T08:00:00.000Z",
      html: html("<p>missing during backup</p>"),
      ownerId: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
      uploadedByApiKeyId: null,
    });
    await blobs.remove(draft.blobKey);

    await expect(createBackup(source, backup)).rejects.toThrow();
    expect(
      (await readdir(root)).some((entry) => entry.startsWith("backup")),
    ).toBe(false);
  });
});
