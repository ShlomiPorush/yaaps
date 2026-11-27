import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { HtmlBlobStore } from "./blob-store.js";
import { openDatabase } from "./database.js";
import { DraftStorage } from "./draft-storage.js";

const serverDirectory = fileURLToPath(new URL("../../", import.meta.url));
const temporaryPaths: string[] = [];

const holdWriteLock = `
const Database = require("better-sqlite3");
const database = new Database(process.argv[1], { timeout: 5000 });
database.exec("begin immediate");
database.prepare("update users set display_name = ? where id = ?").run("Held by the other process", "owner");
process.stdout.write("locked");
setTimeout(() => {
  database.exec("commit");
  database.close();
}, 300);
`;

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

describe("two processes on one database", () => {
  it("waits for the other process's write transaction and then succeeds", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "yaaps-cross-process-"),
    );
    temporaryPaths.push(dataDirectory);
    const database = await openDatabase(dataDirectory);
    try {
      await database.connection
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
      const storage = new DraftStorage(
        database.connection,
        new HtmlBlobStore(dataDirectory),
        { error: () => undefined },
      );
      const child = spawn(
        process.execPath,
        ["-e", holdWriteLock, database.path],
        { cwd: serverDirectory, stdio: ["ignore", "pipe", "inherit"] },
      );
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      );
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          if (chunk.toString("utf8").includes("locked")) resolve();
        });
        child.once("exit", () => reject(new Error("The child exited early.")));
      });

      const startedAt = performance.now();
      const created = await storage.createDraft({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        html: Buffer.from(
          "<!doctype html><html><head><title>Report</title></head><body><p>after the wait</p></body></html>",
        ),
        ownerId: "owner",
      });
      const waited = performance.now() - startedAt;

      expect(created.versionNumber).toBe(1);
      expect(waited).toBeGreaterThan(150);
      expect(await exited).toBe(0);
      await expect(
        database.connection
          .selectFrom("users")
          .select("display_name")
          .where("id", "=", "owner")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ display_name: "Held by the other process" });
    } finally {
      await database.connection.destroy();
    }
  }, 30_000);
});
