import type { Kysely, Transaction } from "kysely";

import type { DatabaseSchema } from "./schema.js";

export interface AuditEventInput {
  action: string;
  actorApiKeyId: string | null;
  actorUserId: string | null;
  createdAt: string;
  metadata?: Record<string, unknown>;
  targetId: string | null;
  targetType: string;
}

export async function insertAuditEvent(
  database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
  input: AuditEventInput,
): Promise<void> {
  await database
    .insertInto("audit_events")
    .values({
      action: input.action,
      actor_api_key_id: input.actorApiKeyId,
      actor_user_id: input.actorUserId,
      created_at: input.createdAt,
      metadata_json: JSON.stringify(input.metadata ?? {}),
      target_id: input.targetId,
      target_type: input.targetType,
    })
    .executeTakeFirstOrThrow();
}
