import type * as FileSystem from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Fastify from "fastify";
import { sql, type KyselyPlugin } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerPublicReportRoutes } from "../reports/routes.js";
import { HtmlBlobStore, type PreparedBlob } from "./blob-store.js";
import { openDatabase, type YaapsDatabase } from "./database.js";
import { DraftNotFoundError, DraftStorage } from "./draft-storage.js";

interface Gate {
  reached: Promise<void>;
  release: () => void;
  wait: () => Promise<void>;
}

function createGate(): Gate {
  let markReached: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    markReached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    wait: async () => {
      markReached();
      await released;
    },
  };
}

const linkGate = vi.hoisted(() => ({ current: null as Gate | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FileSystem>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      const gate = linkGate.current;
      if (gate) {
        linkGate.current = null;
        await gate.wait();
      }
      return actual.link(...args);
    },
  };
});

class GatedPublishBlobStore extends HtmlBlobStore {
  gate: Gate | null = null;

  override async store(content: Uint8Array) {
    const stored = await super.store(content);
    await this.#passGate();
    return stored;
  }

  override async publish(prepared: PreparedBlob): Promise<void> {
    await super.publish(prepared);
    await this.#passGate();
  }

  async #passGate(): Promise<void> {
    const gate = this.gate;
    this.gate = null;
    await gate?.wait();
  }
}

function onFirstResult(
  columns: string[],
  action: () => Promise<void>,
): KyselyPlugin {
  let fired = false;
  const expected = [...columns].sort().join(",");
  return {
    transformQuery: (args) => args.node,
    async transformResult(args) {
      const first = args.result.rows[0];
      if (
        !fired &&
        typeof first === "object" &&
        first !== null &&
        Object.keys(first).sort().join(",") === expected
      ) {
        fired = true;
        await action();
      }
      return args.result;
    },
  };
}

const temporaryPaths: string[] = [];
const logger = { error: () => undefined };
let directory: string;
let first: YaapsDatabase;
let second: YaapsDatabase;

function html(body: string): Buffer {
  return Buffer.from(
    `<!doctype html><html><head><title>Report</title></head><body>${body}</body></html>`,
  );
}

function hoursFromNow(hours: number): string {
  return new Date(Date.now() + hours * 60 * 60 * 1_000).toISOString();
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "yaaps-two-instances-"));
  temporaryPaths.push(directory);
  first = await openDatabase(directory);
  second = await openDatabase(directory);
  await sql`pragma busy_timeout = 50`.execute(second.connection);
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
  linkGate.current = null;
  await first.connection.destroy();
  await second.connection.destroy();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

describe("two instances on one data directory", () => {
  it("does not reclaim a blob whose upload has not committed yet", async () => {
    const uploaderBlobs = new GatedPublishBlobStore(directory);
    const uploader = new DraftStorage(first.connection, uploaderBlobs, logger);
    const reclaimer = new DraftStorage(
      second.connection,
      new HtmlBlobStore(directory),
      logger,
    );
    const gate = createGate();
    uploaderBlobs.gate = gate;

    const upload = uploader.createDraft({
      expiresAt: hoursFromNow(1),
      html: html("<p>uploading</p>"),
      ownerId: "owner",
    });
    await gate.reached;
    const reclaimWhileUploading = await reclaimer.cleanupOrphanedBlobs().then(
      (removed) => ({ removed }),
      (error: unknown) => ({ error }),
    );
    gate.release();
    const created = await upload;
    const reclaimAfterCommit = await reclaimer.cleanupOrphanedBlobs();

    await expect(
      reclaimer.resolvePublic(created.draftId),
    ).resolves.toMatchObject({ status: "available", versionNumber: 1 });
    expect(reclaimWhileUploading).toMatchObject({
      error: expect.objectContaining({ code: "SQLITE_BUSY" }),
    });
    expect(reclaimAfterCommit).toBe(0);
  });

  it("keeps the temporary file of an upload that is still in progress", async () => {
    const uploader = new DraftStorage(
      first.connection,
      new HtmlBlobStore(directory),
      logger,
    );
    const otherInstanceBlobs = new HtmlBlobStore(directory);
    const gate = createGate();
    linkGate.current = gate;

    const upload = uploader.createDraft({
      expiresAt: hoursFromNow(1),
      html: html("<p>prepared upload</p>"),
      ownerId: "owner",
    });
    await gate.reached;
    await otherInstanceBlobs.cleanupTemporaryFiles();
    gate.release();

    const created = await upload;
    await expect(
      uploader.resolvePublic(created.draftId),
    ).resolves.toMatchObject({ status: "available" });
  });

  it("answers 404 for a report deleted and reclaimed while it was being read", async () => {
    const owner = new DraftStorage(
      first.connection,
      new HtmlBlobStore(directory),
      logger,
    );
    const created = await owner.createDraft({
      expiresAt: hoursFromNow(1),
      html: html("<p>read during delete</p>"),
      ownerId: "owner",
    });
    const otherInstance = new DraftStorage(
      second.connection,
      new HtmlBlobStore(directory),
      logger,
    );
    const reader = new DraftStorage(
      first.connection.withPlugin(
        onFirstResult(["blob_key", "resource_policy"], () =>
          otherInstance.deleteForOwner({
            apiKeyId: null,
            draftId: created.draftId,
            ownerId: "owner",
          }),
        ),
      ),
      new HtmlBlobStore(directory),
      logger,
    );
    const application = Fastify();
    await registerPublicReportRoutes(application, {
      drafts: reader,
      publicOrigin: "http://localhost:3000",
    });

    const response = await application.inject({
      method: "GET",
      url: `/d/${created.draftId}`,
    });
    await application.close();

    expect(response.statusCode).toBe(404);
  });

  it("keeps an expired draft that the other instance extended during cleanup", async () => {
    const owner = new DraftStorage(
      first.connection,
      new HtmlBlobStore(directory),
      logger,
    );
    const now = new Date();
    const created = await owner.createDraft({
      expiresAt: new Date(now.getTime() - 1_000).toISOString(),
      html: html("<p>about to expire</p>"),
      ownerId: "owner",
    });
    const otherInstance = new DraftStorage(
      second.connection,
      new HtmlBlobStore(directory),
      logger,
    );
    const cleaner = new DraftStorage(
      first.connection.withPlugin(
        onFirstResult(["id"], async () => {
          await otherInstance.addVersion({
            draftId: created.draftId,
            expiresAt: hoursFromNow(1),
            html: html("<p>extended</p>"),
            ownerId: "owner",
          });
        }),
      ),
      new HtmlBlobStore(directory),
      logger,
    );

    const result = await cleaner.cleanupExpired(now);

    await expect(
      owner.findForOwner("owner", created.draftId),
    ).resolves.toMatchObject({ latest_version_number: 2 });
    expect(result.deletedDrafts).toBe(0);
    await expect(
      first.connection
        .selectFrom("versions")
        .select("version_number")
        .where("draft_id", "=", created.draftId)
        .orderBy("version_number")
        .execute(),
    ).resolves.toEqual([{ version_number: 1 }, { version_number: 2 }]);
    await expect(
      first.connection
        .selectFrom("audit_events")
        .select("action")
        .where("action", "=", "draft.expired")
        .execute(),
    ).resolves.toEqual([]);
  });

  it("refuses a new version for a draft that expiry cleanup deleted meanwhile", async () => {
    const owner = new DraftStorage(
      first.connection,
      new HtmlBlobStore(directory),
      logger,
    );
    const now = new Date();
    const created = await owner.createDraft({
      expiresAt: new Date(now.getTime() - 1_000).toISOString(),
      html: html("<p>expiring</p>"),
      ownerId: "owner",
    });
    const writer = new DraftStorage(
      second.connection.withPlugin(
        onFirstResult(
          [
            "category",
            "created_at",
            "expires_at",
            "id",
            "latest_version_number",
            "owner_id",
            "resourcePolicy",
            "status",
            "title",
            "updated_at",
            "view_count",
          ],
          async () => {
            await owner.cleanupExpired(now);
          },
        ),
      ),
      new HtmlBlobStore(directory),
      logger,
    );

    await expect(
      writer.addVersion({
        draftId: created.draftId,
        expiresAt: hoursFromNow(1),
        html: html("<p>too late</p>"),
        ownerId: "owner",
      }),
    ).rejects.toBeInstanceOf(DraftNotFoundError);
    await expect(
      first.connection.selectFrom("versions").selectAll().execute(),
    ).resolves.toEqual([]);
  });

  it("adds a version while the other instance tries to write in between", async () => {
    const owner = new DraftStorage(
      first.connection,
      new HtmlBlobStore(directory),
      logger,
    );
    const created = await owner.createDraft({
      expiresAt: hoursFromNow(1),
      html: html("<p>first</p>"),
      ownerId: "owner",
    });
    let interleavedWrite: { error: unknown } | { written: true } | undefined;
    const writer = new DraftStorage(
      first.connection.withPlugin(
        onFirstResult(["latest_version_number"], async () => {
          interleavedWrite = await second.connection
            .updateTable("drafts")
            .set({ title: "written by the other instance" })
            .where("id", "=", created.draftId)
            .execute()
            .then(
              () => ({ written: true as const }),
              (error: unknown) => ({ error }),
            );
        }),
      ),
      new HtmlBlobStore(directory),
      logger,
    );

    await expect(
      writer.addVersion({
        draftId: created.draftId,
        expiresAt: hoursFromNow(1),
        html: html("<p>second</p>"),
        ownerId: "owner",
      }),
    ).resolves.toMatchObject({ versionNumber: 2 });
    expect(interleavedWrite).toMatchObject({
      error: expect.objectContaining({ code: "SQLITE_BUSY" }),
    });
  });
});
