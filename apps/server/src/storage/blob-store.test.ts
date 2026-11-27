import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BlobIntegrityError, HtmlBlobStore } from "./blob-store.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-blobs-test-"));
  temporaryPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

describe("immutable HTML blob storage", () => {
  it("atomically deduplicates concurrent writes", async () => {
    const store = new HtmlBlobStore(await temporaryDirectory());
    const html = Buffer.from("<!doctype html><title>Stored</title>");

    const [first, second] = await Promise.all([
      store.store(html),
      store.store(html),
    ]);

    expect(first).toEqual(second);
    expect(await store.read(first.key)).toEqual(html);
  });

  it("rejects traversal keys and detects modified content", async () => {
    const directory = await temporaryDirectory();
    const store = new HtmlBlobStore(directory);
    await expect(store.read("../secret")).rejects.toBeInstanceOf(
      BlobIntegrityError,
    );

    const stored = await store.store(Buffer.from("<p>original</p>"));
    await writeFile(
      path.join(directory, ...stored.key.split("/")),
      "<p>modified</p>",
    );

    await expect(store.read(stored.key)).rejects.toBeInstanceOf(
      BlobIntegrityError,
    );
  });

  it("removes only temporary files older than one hour", async () => {
    const directory = await temporaryDirectory();
    const temporaryDirectoryPath = path.join(directory, ".blob-tmp");
    await mkdir(temporaryDirectoryPath, { recursive: true });
    const now = new Date("2026-08-24T12:00:00.000Z");
    const abandonedPath = path.join(temporaryDirectoryPath, "abandoned.tmp");
    const recentPath = path.join(temporaryDirectoryPath, "recent.tmp");
    await writeFile(abandonedPath, "x");
    await writeFile(recentPath, "x");
    await writeFile(path.join(temporaryDirectoryPath, "keep.txt"), "x");
    const abandonedAt = new Date(now.getTime() - 60 * 60 * 1_000 - 1_000);
    const recentAt = new Date(now.getTime() - 59 * 60 * 1_000);
    await utimes(abandonedPath, abandonedAt, abandonedAt);
    await utimes(recentPath, recentAt, recentAt);
    const store = new HtmlBlobStore(directory);
    const stored = await store.store(Buffer.from("<p>kept</p>"));

    expect(await store.cleanupTemporaryFiles(now)).toBe(1);
    expect((await readdir(temporaryDirectoryPath)).sort()).toEqual([
      "keep.txt",
      "recent.tmp",
    ]);
    expect(await store.read(stored.key)).toEqual(Buffer.from("<p>kept</p>"));
  });

  it("re-creates a content-addressed file that was deleted after it was prepared", async () => {
    const directory = await temporaryDirectory();
    const store = new HtmlBlobStore(directory);
    const html = Buffer.from("<p>twin</p>");
    const existing = await store.store(html);

    const prepared = await store.prepare(html);
    await store.remove(existing.key);
    await store.publish(prepared);
    await store.discard(prepared);

    expect(prepared.key).toBe(existing.key);
    expect(await store.read(existing.key)).toEqual(html);
    expect(await readdir(path.join(directory, ".blob-tmp"))).toEqual([]);
  });

  it("refuses to prepare content whose existing twin was modified", async () => {
    const directory = await temporaryDirectory();
    const store = new HtmlBlobStore(directory);
    const html = Buffer.from("<p>original twin</p>");
    const existing = await store.store(html);
    await writeFile(
      path.join(directory, ...existing.key.split("/")),
      "<p>tampered</p>",
    );

    await expect(store.prepare(html)).rejects.toBeInstanceOf(
      BlobIntegrityError,
    );
    expect(await readdir(path.join(directory, ".blob-tmp"))).toEqual([]);
  });
});
