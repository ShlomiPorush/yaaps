import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

  it("removes only abandoned temporary files", async () => {
    const directory = await temporaryDirectory();
    const temporaryDirectoryPath = path.join(directory, ".blob-tmp");
    await mkdir(temporaryDirectoryPath, { recursive: true });
    await writeFile(path.join(temporaryDirectoryPath, "abandoned.tmp"), "x");
    await writeFile(path.join(temporaryDirectoryPath, "keep.txt"), "x");
    const store = new HtmlBlobStore(directory);
    const stored = await store.store(Buffer.from("<p>kept</p>"));

    expect(await store.cleanupTemporaryFiles()).toBe(1);
    expect(await store.read(stored.key)).toEqual(Buffer.from("<p>kept</p>"));
  });
});
