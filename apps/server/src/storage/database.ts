import { mkdir } from "node:fs/promises";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { migrateToLatest } from "./migrations.js";
import type { DatabaseSchema } from "./schema.js";

export interface YaapsDatabase {
  connection: Kysely<DatabaseSchema>;
  path: string;
}

export async function openDatabase(
  dataDirectory: string,
): Promise<YaapsDatabase> {
  await mkdir(dataDirectory, { recursive: true });
  const databasePath = path.join(dataDirectory, "yaaps.sqlite");
  const sqlite = new BetterSqlite3(databasePath, { timeout: 5_000 });
  let connection: Kysely<DatabaseSchema> | undefined;

  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = FULL");
    connection = new Kysely<DatabaseSchema>({
      dialect: new SqliteDialect({ database: sqlite }),
    });
    await migrateToLatest(connection);
    return { connection, path: databasePath };
  } catch (error) {
    if (connection) {
      await connection.destroy();
    } else {
      sqlite.close();
    }
    throw error;
  }
}
