import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { InsertQueryNode, sql, type KyselyPlugin, type QueryId } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HtmlBlobStore, type PreparedBlob } from "./blob-store.js";
import { openDatabase, type YaapsDatabase } from "./database.js";
import {
  DraftNotFoundError,
  DraftStorage,
  type StorageLogger,
} from "./draft-storage.js";

const temporaryPaths: string[] = [];
let directory: string;
let first: YaapsDatabase;
let second: YaapsDatabase;
let logger: { error: ReturnType<typeof vi.fn<StorageLogger["error"]>> };

function html(body: string): Buffer {
  return Buffer.from(
    `<!doctype html><html><head><title>Report</title></head><body>${body}</body></html>`,
  );
}

function inOneHour(): string {
  return new Date(Date.now() + 60 * 60 * 1_000).toISOString();
}

function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`Simulated ${code}.`), { code });
}

function writeLockIsHeldElsewhere(databasePath: string): boolean {
  const probe = new BetterSqlite3(databasePath, { timeout: 0 });
  try {
    probe.exec("begin immediate");
    probe.exec("rollback");
    return false;
  } catch (error) {
    if ((error as { code?: string }).code === "SQLITE_BUSY") {
      return true;
    }
    throw error;
  } finally {
    probe.close();
  }
}

async function count(
  table: "audit_events" | "drafts" | "versions",
): Promise<number> {
  const row = await first.connection
    .selectFrom(table)
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "yaaps-reclamation-"));
  temporaryPaths.push(directory);
  first = await openDatabase(directory);
  second = await openDatabase(directory);
  await sql`pragma busy_timeout = 50`.execute(second.connection);
  logger = { error: vi.fn<StorageLogger["error"]>() };
  await first.connection
    .insertInto("users")
    .values({
      created_at: new Date().toISOString(),
      disabled_at: null,
      display_name: "Owner",
      id: "owner",
      role: "user",
      status: "active",
      webauthn_user_id: null,
    })
    .execute();
});

afterEach(async () => {
  await first.connection.destroy();
  await second.connection.destroy();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

describe("blob reclamation", () => {
  it("logs a failed removal, keeps the write lock for the batch, and continues with later orphans", async () => {
    const blobs = new HtmlBlobStore(directory);
    const orphans = (
      await Promise.all(
        Array.from({ length: 150 }, (_, index) =>
          blobs.store(html(`<p>orphan ${index}</p>`)),
        ),
      )
    )
      .map((blob) => blob.key)
      .sort();
    const failingKey = orphans[10]!;
    let active = 0;
    let maximumActive = 0;
    let lockHeldDuringRemoval = false;

    class FailingRemovalBlobStore extends HtmlBlobStore {
      override async remove(key: string): Promise<void> {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await new Promise((resolve) => setImmediate(resolve));
          if (key === failingKey) {
            lockHeldDuringRemoval = writeLockIsHeldElsewhere(first.path);
            throw systemError("EACCES");
          }
          await super.remove(key);
        } finally {
          active -= 1;
        }
      }
    }

    const storage = new DraftStorage(
      first.connection,
      new FailingRemovalBlobStore(directory),
      logger,
    );
    const kept = await storage.createDraft({
      expiresAt: inOneHour(),
      html: html("<p>referenced</p>"),
      ownerId: "owner",
    });

    await expect(storage.cleanupOrphanedBlobs()).resolves.toBe(149);

    expect((await blobs.listKeys()).sort()).toEqual(
      [failingKey, kept.blobKey].sort(),
    );
    expect(lockHeldDuringRemoval).toBe(true);
    expect(writeLockIsHeldElsewhere(first.path)).toBe(false);
    expect(maximumActive).toBe(1);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]?.[0]).toMatchObject({
      blobKey: failingKey,
    });
  });

  it("returns a committed upload when its temporary file cannot be removed", async () => {
    class FailingDiscardBlobStore extends HtmlBlobStore {
      override async discard(prepared: PreparedBlob): Promise<void> {
        void prepared;
        throw systemError("EIO");
      }
    }
    const storage = new DraftStorage(
      first.connection,
      new FailingDiscardBlobStore(directory),
      logger,
    );

    const created = await storage.createDraft({
      expiresAt: inOneHour(),
      html: html("<p>committed</p>"),
      ownerId: "owner",
    });

    expect(created.versionNumber).toBe(1);
    expect(await count("drafts")).toBe(1);
    expect(await count("versions")).toBe(1);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(await readdir(path.join(directory, ".blob-tmp"))).toHaveLength(1);
  });

  it("returns a committed delete when reclaiming its blobs fails", async () => {
    const blobs = new HtmlBlobStore(directory);
    const owner = new DraftStorage(first.connection, blobs, logger);
    const created = await owner.createDraft({
      expiresAt: inOneHour(),
      html: html("<p>deleted</p>"),
      ownerId: "owner",
    });
    let auditQuery: QueryId | undefined;
    let deletionWritten = false;
    const failAfterDeletion: KyselyPlugin = {
      transformQuery(args) {
        if (deletionWritten) {
          throw systemError("EIO");
        }
        if (
          InsertQueryNode.is(args.node) &&
          args.node.into?.table.identifier.name === "audit_events"
        ) {
          auditQuery = args.queryId;
        }
        return args.node;
      },
      async transformResult(args) {
        if (args.queryId === auditQuery) {
          deletionWritten = true;
        }
        return args.result;
      },
    };
    const deleter = new DraftStorage(
      first.connection.withPlugin(failAfterDeletion),
      blobs,
      logger,
    );

    await expect(
      deleter.deleteForOwner({
        apiKeyId: null,
        draftId: created.draftId,
        ownerId: "owner",
      }),
    ).resolves.toBeUndefined();

    expect(await count("drafts")).toBe(0);
    expect(await count("versions")).toBe(0);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]?.[0]).toMatchObject({
      draftId: created.draftId,
    });
    expect(await blobs.listKeys()).toEqual([created.blobKey]);
    await expect(owner.cleanupOrphanedBlobs()).resolves.toBe(1);
    expect(await blobs.listKeys()).toEqual([]);
  });
});

describe("transaction failure paths", () => {
  it("leaves no transaction open after operations that fail inside one", async () => {
    const storage = new DraftStorage(
      first.connection,
      new HtmlBlobStore(directory),
      logger,
    );
    const otherInstance = new DraftStorage(
      second.connection,
      new HtmlBlobStore(directory),
      logger,
    );

    await expect(
      storage.updateForOwner({
        apiKeyId: null,
        draftId: "missing-draft",
        ownerId: "owner",
        title: "never written",
      }),
    ).rejects.toBeInstanceOf(DraftNotFoundError);
    await expect(
      storage.deleteForOwner({
        apiKeyId: null,
        draftId: "missing-draft",
        ownerId: "owner",
      }),
    ).rejects.toBeInstanceOf(DraftNotFoundError);
    await expect(
      storage.createDraft({
        expiresAt: inOneHour(),
        html: html("<p>unknown owner</p>"),
        ownerId: "missing-owner",
      }),
    ).rejects.toThrow();

    await expect(
      otherInstance.createDraft({
        expiresAt: inOneHour(),
        html: html("<p>other instance</p>"),
        ownerId: "owner",
      }),
    ).resolves.toMatchObject({ versionNumber: 1 });
    await expect(
      storage.createDraft({
        expiresAt: inOneHour(),
        html: html("<p>same instance</p>"),
        ownerId: "owner",
      }),
    ).resolves.toMatchObject({ versionNumber: 1 });
    expect(await count("drafts")).toBe(2);
    expect(await readdir(path.join(directory, ".blob-tmp"))).toEqual([]);
  });
});
