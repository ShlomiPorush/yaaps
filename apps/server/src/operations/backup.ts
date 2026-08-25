import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { z } from "zod";

import { HtmlBlobStore } from "../storage/blob-store.js";

const manifestSchema = z.object({
  blobs: z.array(
    z.object({
      byteLength: z.number().int().positive(),
      key: z.string().min(1),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  ),
  createdAt: z.iso.datetime(),
  formatVersion: z.literal(1),
  sqliteSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export type BackupManifest = z.infer<typeof manifestSchema>;

interface VersionBlobRow {
  blob_key: string;
  byte_length: number;
  sha256: string;
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function mustNotExist(target: string): Promise<void> {
  try {
    await lstat(target);
    throw new Error(`The destination already exists: ${target}`);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

function validateDistinctDirectories(
  source: string,
  destination: string,
): void {
  const relative = path.relative(source, destination);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  ) {
    throw new Error(
      "The backup destination must be outside the data directory.",
    );
  }
}

function readVersionBlobs(databasePath: string): VersionBlobRow[] {
  const database = new BetterSqlite3(databasePath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    const quickCheck = database.pragma("quick_check") as Array<{
      quick_check: string;
    }>;
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
      throw new Error("The SQLite snapshot failed its integrity check.");
    }
    return database
      .prepare(
        "select blob_key, max(byte_length) as byte_length, sha256 from versions group by blob_key, sha256 order by blob_key",
      )
      .all() as VersionBlobRow[];
  } finally {
    database.close();
  }
}

async function readManifest(backupDirectory: string): Promise<BackupManifest> {
  return manifestSchema.parse(
    JSON.parse(
      await readFile(path.join(backupDirectory, "manifest.json"), "utf8"),
    ),
  );
}

export async function createBackup(
  dataDirectory: string,
  destinationDirectory: string,
  now = new Date(),
): Promise<BackupManifest> {
  const source = path.resolve(dataDirectory);
  const destination = path.resolve(destinationDirectory);
  validateDistinctDirectories(source, destination);
  await mustNotExist(destination);
  const temporary = `${destination}.tmp-${randomUUID()}`;
  await mustNotExist(temporary);
  await mkdir(temporary, { recursive: true, mode: 0o700 });

  try {
    const sourceDatabasePath = path.join(source, "yaaps.sqlite");
    const snapshotPath = path.join(temporary, "yaaps.sqlite");
    const sourceDatabase = new BetterSqlite3(sourceDatabasePath, {
      fileMustExist: true,
      readonly: true,
    });
    try {
      await sourceDatabase.backup(snapshotPath);
    } finally {
      sourceDatabase.close();
    }

    const rows = readVersionBlobs(snapshotPath);
    const sourceBlobs = new HtmlBlobStore(source);
    const backupBlobs = new HtmlBlobStore(temporary);
    const blobs: BackupManifest["blobs"] = [];
    for (const row of rows) {
      const content = await sourceBlobs.read(row.blob_key);
      if (
        content.byteLength !== row.byte_length ||
        digest(content) !== row.sha256
      ) {
        throw new Error(`Blob metadata mismatch: ${row.blob_key}`);
      }
      const stored = await backupBlobs.store(content);
      if (stored.key !== row.blob_key) {
        throw new Error(`Blob address mismatch: ${row.blob_key}`);
      }
      blobs.push({
        byteLength: stored.byteLength,
        key: stored.key,
        sha256: stored.sha256,
      });
    }

    const manifest: BackupManifest = {
      blobs,
      createdAt: now.toISOString(),
      formatVersion: 1,
      sqliteSha256: digest(await readFile(snapshotPath)),
    };
    await writeFile(
      path.join(temporary, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporary, destination);
    return manifest;
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }
}

export async function restoreBackup(
  backupDirectory: string,
  destinationDataDirectory: string,
): Promise<BackupManifest> {
  const backup = path.resolve(backupDirectory);
  const destination = path.resolve(destinationDataDirectory);
  validateDistinctDirectories(backup, destination);
  await mustNotExist(destination);
  const temporary = `${destination}.tmp-${randomUUID()}`;
  await mustNotExist(temporary);
  await mkdir(temporary, { recursive: true, mode: 0o700 });

  try {
    const manifest = await readManifest(backup);
    const sourceDatabase = path.join(backup, "yaaps.sqlite");
    if (digest(await readFile(sourceDatabase)) !== manifest.sqliteSha256) {
      throw new Error(
        "The SQLite snapshot does not match the backup manifest.",
      );
    }
    const rows = readVersionBlobs(sourceDatabase);
    if (
      JSON.stringify(
        rows.map((row) => ({
          byteLength: row.byte_length,
          key: row.blob_key,
          sha256: row.sha256,
        })),
      ) !== JSON.stringify(manifest.blobs)
    ) {
      throw new Error(
        "The backup blob set does not match its SQLite snapshot.",
      );
    }

    await copyFile(sourceDatabase, path.join(temporary, "yaaps.sqlite"));
    const sourceBlobs = new HtmlBlobStore(backup);
    const restoredBlobs = new HtmlBlobStore(temporary);
    for (const blob of manifest.blobs) {
      const content = await sourceBlobs.read(blob.key);
      if (
        content.byteLength !== blob.byteLength ||
        digest(content) !== blob.sha256
      ) {
        throw new Error(`Backup blob failed validation: ${blob.key}`);
      }
      const stored = await restoredBlobs.store(content);
      if (stored.key !== blob.key) {
        throw new Error(`Restored blob address mismatch: ${blob.key}`);
      }
    }
    readVersionBlobs(path.join(temporary, "yaaps.sqlite"));
    await rename(temporary, destination);
    return manifest;
  } catch (error) {
    await rm(temporary, { force: true, recursive: true });
    throw error;
  }
}
