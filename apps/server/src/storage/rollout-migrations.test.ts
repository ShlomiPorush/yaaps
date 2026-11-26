import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect, sql } from "kysely";
import { type Migration, Migrator } from "kysely/migration";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./database.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-rollout-test-"));
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

function executedMigrationNames(databasePath: string): string[] {
  const inspection = new BetterSqlite3(databasePath, { readonly: true });
  try {
    return (
      inspection
        .prepare("select name from kysely_migration order by name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    inspection.close();
  }
}

function tableNames(databasePath: string): string[] {
  const inspection = new BetterSqlite3(databasePath, { readonly: true });
  try {
    return (
      inspection
        .prepare("select name from sqlite_master where type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
  } finally {
    inspection.close();
  }
}

function migrationsKnownByNewerRelease(
  executed: string[],
  added: Record<string, Migration>,
): Record<string, Migration> {
  return {
    ...Object.fromEntries(
      executed.map((name) => [name, { up: async () => undefined }]),
    ),
    ...added,
  };
}

async function applyNewerReleaseMigration(
  directory: string,
  name: string,
): Promise<void> {
  const databasePath = path.join(directory, "yaaps.sqlite");
  const executed = executedMigrationNames(databasePath);
  const newer = new Kysely<unknown>({
    dialect: new SqliteDialect({ database: new BetterSqlite3(databasePath) }),
  });
  try {
    const { error } = await new Migrator({
      db: newer,
      provider: {
        getMigrations: async () =>
          migrationsKnownByNewerRelease(executed, {
            [name]: {
              async up(database) {
                await database.schema
                  .alterTable("drafts")
                  .addColumn("newer_release_note", "text")
                  .execute();
              },
            },
          }),
      },
    }).migrateToLatest();
    expect(error).toBeUndefined();
  } finally {
    await newer.destroy();
  }
}

describe("startup on a schema migrated by a newer release", () => {
  it("starts when the newer release only added an expand migration", async () => {
    const directory = await temporaryDirectory();
    const current = await openDatabase(directory);
    await current.connection.destroy();
    await applyNewerReleaseMigration(directory, "999_newer_expand_only");

    const restarted = await openDatabase(directory);
    try {
      await expect(
        sql`select newer_release_note from drafts`.execute(
          restarted.connection,
        ),
      ).resolves.toBeDefined();
    } finally {
      await restarted.connection.destroy();
    }
    expect(
      executedMigrationNames(path.join(directory, "yaaps.sqlite")),
    ).toContain("999_newer_expand_only");
  });

  it("refuses a schema that a newer release changed with a breaking migration", async () => {
    const directory = await temporaryDirectory();
    const current = await openDatabase(directory);
    await current.connection.destroy();
    await applyNewerReleaseMigration(directory, "999_newer_change.breaking");

    await expect(openDatabase(directory)).rejects.toThrow();
  });

  it("migrates an empty database to the current schema", async () => {
    const directory = await temporaryDirectory();
    const database = await openDatabase(directory);
    await database.connection.destroy();

    expect(executedMigrationNames(database.path)).toEqual([
      "001_initial_schema",
      "002_authentication_state",
      "003_device_connections",
      "004_draft_categories",
      "005_report_resource_policy",
      "006_report_view_counts",
    ]);
  });

  it("keeps neither the schema change nor the record of a migration that fails after its DDL", async () => {
    const directory = await temporaryDirectory();
    const database = await openDatabase(directory);
    const executed = executedMigrationNames(database.path);
    try {
      const { error } = await new Migrator({
        db: database.connection,
        provider: {
          getMigrations: async () =>
            migrationsKnownByNewerRelease(executed, {
              "999_fails_after_ddl": {
                async up(migrationDatabase) {
                  await migrationDatabase.schema
                    .createTable("half_migrated")
                    .addColumn("id", "text")
                    .execute();
                  throw new Error("Simulated failure after the DDL.");
                },
              },
            }),
        },
      }).migrateToLatest();
      expect(error).toBeDefined();
    } finally {
      await database.connection.destroy();
    }

    expect(tableNames(database.path)).not.toContain("half_migrated");
    expect(executedMigrationNames(database.path)).toEqual(executed);
  });
});
