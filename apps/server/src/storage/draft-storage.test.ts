import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HtmlBlobStore } from "./blob-store.js";
import { openDatabase, type YaapsDatabase } from "./database.js";
import { DraftNotFoundError, DraftStorage } from "./draft-storage.js";

const temporaryPaths: string[] = [];
let database: YaapsDatabase;
let storage: DraftStorage;
let blobs: HtmlBlobStore;

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-drafts-test-"));
  temporaryPaths.push(directory);
  return directory;
}

function html(body: string): Buffer {
  return Buffer.from(
    `<!doctype html><html><head><title>Report</title></head><body>${body}</body></html>`,
  );
}

beforeEach(async () => {
  const directory = await temporaryDirectory();
  database = await openDatabase(directory);
  blobs = new HtmlBlobStore(directory);
  storage = new DraftStorage(database.connection, blobs);
  await database.connection
    .insertInto("users")
    .values([
      {
        created_at: new Date().toISOString(),
        disabled_at: null,
        display_name: "First user",
        id: "user-first",
        role: "user",
        status: "active",
        webauthn_user_id: null,
      },
      {
        created_at: new Date().toISOString(),
        disabled_at: null,
        display_name: "Second user",
        id: "user-second",
        role: "user",
        status: "active",
        webauthn_user_id: null,
      },
    ])
    .execute();
});

afterEach(async () => {
  await database.connection.destroy();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

describe("owner-scoped draft storage", () => {
  it("creates immutable versions and resolves only the latest one", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const created = await storage.createDraft({
      expiresAt,
      html: html("<p>first</p>"),
      ownerId: "user-first",
    });
    const updated = await storage.addVersion({
      draftId: created.draftId,
      expiresAt,
      html: html("<p>second</p>"),
      ownerId: "user-first",
    });

    expect(updated.versionNumber).toBe(2);
    const resolution = await storage.resolvePublic(created.draftId);
    expect(resolution.status).toBe("available");
    expect(resolution.status === "available" && resolution.html).toEqual(
      html("<p>second</p>"),
    );
    expect(
      await database.connection
        .selectFrom("versions")
        .selectAll()
        .where("draft_id", "=", created.draftId)
        .execute(),
    ).toHaveLength(2);
  });

  it("does not reveal or update another owner's draft", async () => {
    const created = await storage.createDraft({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      html: html("<p>private metadata</p>"),
      ownerId: "user-first",
    });

    expect(await storage.findForOwner("user-second", created.draftId)).toBe(
      undefined,
    );
    await expect(
      storage.addVersion({
        draftId: created.draftId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        html: html("<p>unauthorized</p>"),
        ownerId: "user-second",
      }),
    ).rejects.toBeInstanceOf(DraftNotFoundError);
  });

  it("removes unreferenced blobs left by an interrupted metadata write", async () => {
    const blobs = new HtmlBlobStore(path.dirname(database.path));
    const orphan = await blobs.store(html("<p>orphan</p>"));
    const kept = await storage.createDraft({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      html: html("<p>kept</p>"),
      ownerId: "user-first",
    });

    expect(await storage.cleanupOrphanedBlobs()).toBe(1);
    await expect(blobs.read(orphan.key)).rejects.toThrow();
    expect(await blobs.read(kept.blobKey)).toEqual(html("<p>kept</p>"));
  });

  it("rejects unsafe HTML before creating durable blob or metadata state", async () => {
    await expect(
      storage.createDraft({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        html: html("<script>alert(1)</script>"),
        ownerId: "user-first",
      }),
    ).rejects.toMatchObject({ code: "ELEMENT_BLOCKED" });

    expect(
      await database.connection.selectFrom("drafts").selectAll().execute(),
    ).toEqual([]);
    const blobs = new HtmlBlobStore(path.dirname(database.path));
    expect(await blobs.listKeys()).toEqual([]);
  });

  it("deletes expired metadata, audits it, and reclaims only orphaned blobs", async () => {
    const now = new Date("2026-08-24T12:00:00.000Z");
    const expired = await storage.createDraft({
      expiresAt: new Date(now.getTime() - 1_000).toISOString(),
      html: html("<p>expired</p>"),
      ownerId: "user-first",
    });
    const live = await storage.createDraft({
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      html: html("<p>live</p>"),
      ownerId: "user-first",
    });

    await expect(storage.cleanupExpired(now)).resolves.toEqual({
      deletedDrafts: 1,
      reclaimedBlobs: 1,
    });
    await expect(blobs.read(expired.blobKey)).rejects.toThrow();
    await expect(blobs.read(live.blobKey)).resolves.toEqual(
      html("<p>live</p>"),
    );
    await expect(
      database.connection
        .selectFrom("audit_events")
        .select(["action", "actor_api_key_id", "actor_user_id", "target_id"])
        .where("target_id", "=", expired.draftId)
        .where("action", "=", "draft.expired")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      action: "draft.expired",
      actor_api_key_id: null,
      actor_user_id: null,
      target_id: expired.draftId,
    });
  });

  it("recovers orphaned blobs after an interrupted expiry cleanup", async () => {
    const now = new Date("2026-08-24T12:00:00.000Z");
    const expired = await storage.createDraft({
      expiresAt: new Date(now.getTime() - 1_000).toISOString(),
      html: html("<p>interrupted cleanup</p>"),
      ownerId: "user-first",
    });
    const removal = vi
      .spyOn(blobs, "remove")
      .mockRejectedValueOnce(new Error("Simulated interruption"));

    await expect(storage.cleanupExpired(now)).rejects.toThrow(
      "Simulated interruption",
    );
    await expect(
      storage.findForOwner("user-first", expired.draftId),
    ).resolves.toBeUndefined();
    await expect(blobs.read(expired.blobKey)).resolves.toBeDefined();

    removal.mockRestore();
    await expect(storage.cleanupOrphanedBlobs()).resolves.toBe(1);
    await expect(blobs.read(expired.blobKey)).rejects.toThrow();
  });
});
