import { type Kysely, sql } from "kysely";
import {
  type Migration,
  type MigrationProvider,
  Migrator,
} from "kysely/migration";

import type { DatabaseSchema } from "./schema.js";

const initialSchema: Migration = {
  async up(database) {
    await database.transaction().execute(async (transaction) => {
      await transaction.schema
        .createTable("users")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("display_name", "text", (column) => column.notNull())
        .addColumn("role", "text", (column) =>
          column.notNull().check(sql`role in ('admin', 'user')`),
        )
        .addColumn("status", "text", (column) =>
          column.notNull().check(sql`status in ('active', 'disabled')`),
        )
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("disabled_at", "text")
        .execute();

      await transaction.schema
        .createTable("webauthn_credentials")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("user_id", "text", (column) =>
          column.notNull().references("users.id").onDelete("cascade"),
        )
        .addColumn("credential_id", "blob", (column) =>
          column.notNull().unique(),
        )
        .addColumn("public_key", "blob", (column) => column.notNull())
        .addColumn("counter", "integer", (column) => column.notNull())
        .addColumn("transports_json", "text", (column) => column.notNull())
        .addColumn("device_type", "text", (column) => column.notNull())
        .addColumn("backed_up", "integer", (column) =>
          column.notNull().check(sql`backed_up in (0, 1)`),
        )
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("last_used_at", "text")
        .execute();

      await transaction.schema
        .createTable("invitations")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("code_hash", "text", (column) => column.notNull().unique())
        .addColumn("invited_by_user_id", "text", (column) =>
          column.notNull().references("users.id").onDelete("restrict"),
        )
        .addColumn("role", "text", (column) =>
          column.notNull().check(sql`role in ('admin', 'user')`),
        )
        .addColumn("expires_at", "text", (column) => column.notNull())
        .addColumn("accepted_by_user_id", "text", (column) =>
          column.references("users.id").onDelete("set null"),
        )
        .addColumn("accepted_at", "text")
        .addColumn("revoked_at", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .execute();

      await transaction.schema
        .createTable("sessions")
        .addColumn("id_hash", "text", (column) => column.primaryKey())
        .addColumn("user_id", "text", (column) =>
          column.notNull().references("users.id").onDelete("cascade"),
        )
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("last_seen_at", "text", (column) => column.notNull())
        .addColumn("expires_at", "text", (column) => column.notNull())
        .addColumn("revoked_at", "text")
        .execute();

      await transaction.schema
        .createTable("recovery_codes")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("user_id", "text", (column) =>
          column.notNull().references("users.id").onDelete("cascade"),
        )
        .addColumn("code_hash", "text", (column) => column.notNull().unique())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("used_at", "text")
        .execute();

      await transaction.schema
        .createTable("api_keys")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("user_id", "text", (column) =>
          column.notNull().references("users.id").onDelete("cascade"),
        )
        .addColumn("key_hash", "text", (column) => column.notNull().unique())
        .addColumn("key_prefix", "text", (column) => column.notNull())
        .addColumn("label", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("last_used_at", "text")
        .addColumn("revoked_at", "text")
        .execute();

      await transaction.schema
        .createTable("drafts")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("owner_id", "text", (column) =>
          column.notNull().references("users.id").onDelete("cascade"),
        )
        .addColumn("title", "text")
        .addColumn("status", "text", (column) =>
          column.notNull().check(sql`status in ('enabled', 'disabled')`),
        )
        .addColumn("expires_at", "text", (column) => column.notNull())
        .addColumn("latest_version_number", "integer", (column) =>
          column
            .notNull()
            .defaultTo(0)
            .check(sql`latest_version_number >= 0`),
        )
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("updated_at", "text", (column) => column.notNull())
        .execute();

      await transaction.schema
        .createTable("versions")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("draft_id", "text", (column) =>
          column.notNull().references("drafts.id").onDelete("cascade"),
        )
        .addColumn("version_number", "integer", (column) =>
          column.notNull().check(sql`version_number > 0`),
        )
        .addColumn("blob_key", "text", (column) => column.notNull())
        .addColumn("sha256", "text", (column) => column.notNull())
        .addColumn("byte_length", "integer", (column) =>
          column.notNull().check(sql`byte_length > 0`),
        )
        .addColumn("uploaded_by_api_key_id", "text", (column) =>
          column.references("api_keys.id").onDelete("set null"),
        )
        .addColumn("created_at", "text", (column) => column.notNull())
        .addUniqueConstraint("versions_draft_number_unique", [
          "draft_id",
          "version_number",
        ])
        .execute();

      await transaction.schema
        .createTable("audit_events")
        .addColumn("id", "integer", (column) =>
          column.primaryKey().autoIncrement(),
        )
        .addColumn("actor_user_id", "text", (column) =>
          column.references("users.id").onDelete("set null"),
        )
        .addColumn("actor_api_key_id", "text", (column) =>
          column.references("api_keys.id").onDelete("set null"),
        )
        .addColumn("action", "text", (column) => column.notNull())
        .addColumn("target_type", "text", (column) => column.notNull())
        .addColumn("target_id", "text")
        .addColumn("metadata_json", "text", (column) => column.notNull())
        .addColumn("created_at", "text", (column) => column.notNull())
        .execute();

      await transaction.schema
        .createIndex("drafts_owner_updated_idx")
        .on("drafts")
        .columns(["owner_id", "updated_at"])
        .execute();
      await transaction.schema
        .createIndex("drafts_expiry_idx")
        .on("drafts")
        .columns(["status", "expires_at"])
        .execute();
      await transaction.schema
        .createIndex("versions_draft_idx")
        .on("versions")
        .columns(["draft_id", "version_number"])
        .execute();
      await transaction.schema
        .createIndex("versions_blob_idx")
        .on("versions")
        .column("blob_key")
        .execute();
      await transaction.schema
        .createIndex("api_keys_user_idx")
        .on("api_keys")
        .columns(["user_id", "revoked_at"])
        .execute();
      await transaction.schema
        .createIndex("sessions_user_idx")
        .on("sessions")
        .columns(["user_id", "expires_at"])
        .execute();
    });
  },
  async down(database) {
    for (const table of [
      "audit_events",
      "versions",
      "drafts",
      "api_keys",
      "recovery_codes",
      "sessions",
      "invitations",
      "webauthn_credentials",
      "users",
    ] as const) {
      await database.schema.dropTable(table).ifExists().execute();
    }
  },
};

const authenticationState: Migration = {
  async up(database) {
    await database.transaction().execute(async (transaction) => {
      await transaction.schema
        .alterTable("users")
        .addColumn("webauthn_user_id", "blob")
        .execute();
      await transaction.schema
        .createIndex("users_webauthn_user_id_unique")
        .unique()
        .on("users")
        .column("webauthn_user_id")
        .execute();
      await transaction.schema
        .alterTable("sessions")
        .addColumn("csrf_token_hash", "text", (column) =>
          column.notNull().defaultTo(""),
        )
        .execute();
      await transaction.schema
        .createTable("webauthn_challenges")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("challenge_hash", "text", (column) =>
          column.notNull().unique(),
        )
        .addColumn("ceremony", "text", (column) =>
          column
            .notNull()
            .check(
              sql`ceremony in ('bootstrap', 'invitation', 'authenticate', 'add_credential')`,
            ),
        )
        .addColumn("user_id", "text", (column) =>
          column.references("users.id").onDelete("cascade"),
        )
        .addColumn("invitation_id", "text", (column) =>
          column.references("invitations.id").onDelete("cascade"),
        )
        .addColumn("pending_display_name", "text")
        .addColumn("pending_webauthn_user_id", "blob")
        .addColumn("expires_at", "text", (column) => column.notNull())
        .addColumn("consumed_at", "text")
        .addColumn("created_at", "text", (column) => column.notNull())
        .execute();
      await transaction.schema
        .createIndex("webauthn_challenges_expiry_idx")
        .on("webauthn_challenges")
        .columns(["ceremony", "expires_at", "consumed_at"])
        .execute();
    });
  },
  async down(database) {
    await database.transaction().execute(async (transaction) => {
      await transaction.schema
        .dropTable("webauthn_challenges")
        .ifExists()
        .execute();
      await transaction.schema
        .dropIndex("users_webauthn_user_id_unique")
        .ifExists()
        .execute();
      await transaction.schema
        .alterTable("sessions")
        .dropColumn("csrf_token_hash")
        .execute();
      await transaction.schema
        .alterTable("users")
        .dropColumn("webauthn_user_id")
        .execute();
    });
  },
};

const deviceConnections: Migration = {
  async up(database) {
    await database.transaction().execute(async (transaction) => {
      await transaction.schema
        .createTable("device_connections")
        .addColumn("id", "text", (column) => column.primaryKey())
        .addColumn("device_secret_hash", "text", (column) =>
          column.notNull().unique(),
        )
        .addColumn("user_code_hash", "text", (column) =>
          column.notNull().unique(),
        )
        .addColumn("key_hash", "text", (column) => column.notNull().unique())
        .addColumn("key_prefix", "text", (column) => column.notNull())
        .addColumn("label", "text", (column) => column.notNull())
        .addColumn("status", "text", (column) =>
          column
            .notNull()
            .check(sql`status in ('pending', 'approved', 'denied')`),
        )
        .addColumn("api_key_id", "text", (column) =>
          column.references("api_keys.id").onDelete("set null"),
        )
        .addColumn("decided_by_user_id", "text", (column) =>
          column.references("users.id").onDelete("set null"),
        )
        .addColumn("created_at", "text", (column) => column.notNull())
        .addColumn("expires_at", "text", (column) => column.notNull())
        .addColumn("decided_at", "text")
        .execute();
      await transaction.schema
        .createIndex("device_connections_expiry_idx")
        .on("device_connections")
        .columns(["status", "expires_at"])
        .execute();
    });
  },
  async down(database) {
    await database.schema.dropTable("device_connections").ifExists().execute();
  },
};

class YaapsMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return {
      "001_initial_schema": initialSchema,
      "002_authentication_state": authenticationState,
      "003_device_connections": deviceConnections,
    };
  }
}

export async function migrateToLatest(
  database: Kysely<DatabaseSchema>,
): Promise<void> {
  const { error, results } = await new Migrator({
    db: database,
    provider: new YaapsMigrationProvider(),
  }).migrateToLatest();

  if (error) {
    throw new Error("Database migration failed.", { cause: error });
  }

  const failed = results?.find((result) => result.status === "Error");
  if (failed) {
    throw new Error(`Database migration ${failed.migrationName} failed.`);
  }
}
