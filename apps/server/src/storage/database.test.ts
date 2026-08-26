import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-storage-test-"));
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

describe("database migrations", () => {
  it("creates the complete initial schema and is idempotent", async () => {
    const directory = await temporaryDirectory();
    const first = await openDatabase(directory);
    const tables = await first.connection.introspection.getTables();

    expect(tables.map((table) => table.name).sort()).toEqual(
      expect.arrayContaining([
        "api_keys",
        "audit_events",
        "drafts",
        "device_connections",
        "invitations",
        "recovery_codes",
        "sessions",
        "users",
        "versions",
        "webauthn_challenges",
        "webauthn_credentials",
      ]),
    );
    await first.connection.destroy();

    const reopened = await openDatabase(directory);
    try {
      const migrations = await sql<{ name: string }>`
        select name from kysely_migration order by name
      `.execute(reopened.connection);
      expect(migrations.rows).toEqual([
        { name: "001_initial_schema" },
        { name: "002_authentication_state" },
        { name: "003_device_connections" },
        { name: "004_draft_categories" },
      ]);
    } finally {
      await reopened.connection.destroy();
    }
  });

  it("enforces foreign keys", async () => {
    const database = await openDatabase(await temporaryDirectory());

    await expect(
      database.connection
        .insertInto("drafts")
        .values({
          category: null,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          id: "draft-without-owner",
          latest_version_number: 0,
          owner_id: "missing-owner",
          status: "enabled",
          title: null,
          updated_at: new Date().toISOString(),
        })
        .execute(),
    ).rejects.toThrow();

    await database.connection.destroy();
  });

  it("rolls back a failed migration without leaving a partial schema", async () => {
    const directory = await temporaryDirectory();
    const databasePath = path.join(directory, "yaaps.sqlite");
    const seed = new BetterSqlite3(databasePath);
    seed.exec("create table sessions (conflict text)");
    seed.close();

    await expect(openDatabase(directory)).rejects.toThrow(
      "Database migration failed.",
    );

    const inspection = new BetterSqlite3(databasePath, {
      readonly: true,
    });
    const tables = inspection
      .prepare("select name from sqlite_master where type = 'table'")
      .all() as Array<{ name: string }>;
    inspection.close();

    expect(tables.map((table) => table.name)).toContain("sessions");
    expect(tables.map((table) => table.name)).not.toContain("users");
  });

  it("refuses a corrupt database without overwriting the original bytes", async () => {
    const directory = await temporaryDirectory();
    const databasePath = path.join(directory, "yaaps.sqlite");
    const corruptBytes = Buffer.from("not a sqlite database");
    await writeFile(databasePath, corruptBytes);

    await expect(openDatabase(directory)).rejects.toThrow();
    await expect(readFile(databasePath)).resolves.toEqual(corruptBytes);
  });
});
