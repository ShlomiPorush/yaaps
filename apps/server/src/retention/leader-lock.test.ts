import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { HtmlBlobStore } from "../storage/blob-store.js";
import { openDatabase } from "../storage/database.js";
import { DraftStorage } from "../storage/draft-storage.js";

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const moduleUrl = (relative: string) => new URL(relative, import.meta.url).href;

const childScript = `
import { createInterface } from "node:readline";

const [dataDirectory] = process.argv.slice(1);
const { openDatabase } = await import(${JSON.stringify(moduleUrl("../storage/database.ts"))});
const { HtmlBlobStore } = await import(${JSON.stringify(moduleUrl("../storage/blob-store.ts"))});
const { DraftStorage } = await import(${JSON.stringify(moduleUrl("../storage/draft-storage.ts"))});
const { RetentionLeaderLock } = await import(${JSON.stringify(moduleUrl("./leader-lock.ts"))});
const { RetentionCleanupWorker } = await import(${JSON.stringify(moduleUrl("./cleanup-worker.ts"))});

const logger = { error: () => undefined, info: () => undefined };
const database = await openDatabase(dataDirectory);
const drafts = new DraftStorage(database.connection, new HtmlBlobStore(dataDirectory), logger);
const leadingRun = {
  async cleanupExpired(now) {
    const result = await drafts.cleanupExpired(now);
    process.stdout.write("leading " + JSON.stringify(result) + "\\n");
    await new Promise(() => undefined);
    return result;
  },
};
const worker = new RetentionCleanupWorker(leadingRun, 0, logger, new RetentionLeaderLock(dataDirectory));
createInterface({ input: process.stdin }).on("line", () => {
  void worker.runOnce().then((result) => {
    if (result === null) process.stdout.write("skipped\\n");
  });
});
process.stdout.write("ready\\n");
`;

const children: ChildProcessWithoutNullStreams[] = [];
const temporaryPaths: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

function startInstance(dataDirectory: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      childScript,
      dataDirectory,
    ],
    { cwd: repositoryRoot },
  );
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  let errors = "";
  child.stderr.on("data", (chunk: Buffer) => {
    errors += chunk.toString("utf8");
  });
  const nextLine = (from: number) =>
    new Promise<string>((resolve, reject) => {
      const check = () => {
        const newline = output.indexOf("\n", from);
        if (newline >= 0) {
          child.stdout.off("data", check);
          child.off("exit", exited);
          resolve(output.slice(from, newline));
        }
      };
      const exited = () =>
        reject(new Error(`Child exited: ${output}${errors}`));
      child.stdout.on("data", check);
      child.once("exit", exited);
      check();
    });
  let consumed = 0;
  return {
    child,
    async readLine(): Promise<string> {
      const line = await nextLine(consumed);
      consumed += line.length + 1;
      return line;
    },
    run() {
      child.stdin.write("run\n");
    },
  };
}

describe("retention leader across processes", () => {
  it("lets one process lead a run, keeps report writes going, and hands over when the leader dies", async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), "yaaps-leader-"));
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
      const instances = [
        startInstance(dataDirectory),
        startInstance(dataDirectory),
      ];
      for (const instance of instances) {
        expect(await instance.readLine()).toBe("ready");
      }

      for (const instance of instances) instance.run();
      const outcomes = await Promise.all(
        instances.map((instance) => instance.readLine()),
      );
      expect(outcomes.filter((line) => line === "skipped")).toHaveLength(1);
      expect(
        outcomes.filter((line) => line.startsWith("leading ")),
      ).toHaveLength(1);

      const storage = new DraftStorage(
        database.connection,
        new HtmlBlobStore(dataDirectory),
        { error: () => undefined },
      );
      await expect(
        storage.createDraft({
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          html: Buffer.from(
            "<!doctype html><html><head><title>Report</title></head><body><p>written meanwhile</p></body></html>",
          ),
          ownerId: "owner",
        }),
      ).resolves.toMatchObject({ versionNumber: 1 });

      const leaderIndex = outcomes.findIndex((line) =>
        line.startsWith("leading "),
      );
      const leader = instances[leaderIndex]!;
      const follower = instances[1 - leaderIndex]!;
      const leaderExited = new Promise((resolve) =>
        leader.child.once("exit", resolve),
      );
      leader.child.kill("SIGKILL");
      await leaderExited;

      follower.run();
      expect(await follower.readLine()).toMatch(/^leading /);
    } finally {
      await database.connection.destroy();
    }
  }, 30_000);
});
