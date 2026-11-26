import { mkdir } from "node:fs/promises";
import path from "node:path";

import BetterSqlite3 from "better-sqlite3";
import {
  CompiledQuery,
  Kysely,
  SqliteAdapter,
  SqliteDialect,
  SqliteDriver,
  type DatabaseConnection,
  type DialectAdapter,
  type Driver,
  type SqliteDialectConfig,
} from "kysely";

import { migrateToLatest } from "./migrations.js";
import type { DatabaseSchema } from "./schema.js";

export interface YaapsDatabase {
  connection: Kysely<DatabaseSchema>;
  path: string;
}

class WriteLockingSqliteDriver extends SqliteDriver {
  override async beginTransaction(
    connection: DatabaseConnection,
  ): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin immediate"));
  }
}

class TransactionalDdlSqliteAdapter extends SqliteAdapter {
  override get supportsTransactionalDdl(): boolean {
    return true;
  }
}

class WriteLockingSqliteDialect extends SqliteDialect {
  readonly #config: SqliteDialectConfig;

  constructor(config: SqliteDialectConfig) {
    super(config);
    this.#config = config;
  }

  override createDriver(): Driver {
    return new WriteLockingSqliteDriver(this.#config);
  }

  override createAdapter(): DialectAdapter {
    return new TransactionalDdlSqliteAdapter();
  }
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
      dialect: new WriteLockingSqliteDialect({ database: sqlite }),
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
