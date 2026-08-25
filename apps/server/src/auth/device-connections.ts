import { randomBytes, randomUUID } from "node:crypto";

import type { Kysely, Transaction } from "kysely";

import type { DatabaseSchema } from "../storage/schema.js";
import { insertAuditEvent } from "../storage/audit-log.js";
import { generateSecret, hashSecret, secretMatchesHash } from "./secrets.js";

const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const DEVICE_CONNECTION_LIFETIME_SECONDS = 10 * 60;
export const DEVICE_CONNECTION_POLL_INTERVAL_SECONDS = 2;
export const DEVICE_CONNECTION_STALE_RETENTION_SECONDS = 24 * 60 * 60;
const DEVICE_CONNECTION_CLEANUP_BATCH_SIZE = 100;

export class DeviceConnectionNotFoundError extends Error {
  constructor() {
    super("The device connection was not found.");
    this.name = "DeviceConnectionNotFoundError";
  }
}

export class DeviceConnectionExpiredError extends Error {
  constructor() {
    super("The device connection has expired.");
    this.name = "DeviceConnectionExpiredError";
  }
}

export class DeviceConnectionDecidedError extends Error {
  constructor() {
    super("The device connection was already approved or denied.");
    this.name = "DeviceConnectionDecidedError";
  }
}

export class DeviceConnectionConflictError extends Error {
  constructor() {
    super("The proposed API key is already registered.");
    this.name = "DeviceConnectionConflictError";
  }
}

export interface PendingDeviceConnection {
  createdAt: string;
  expiresAt: string;
  id: string;
  keyPrefix: string;
  label: string;
  status: "pending";
  userCode: string;
}

export function normalizeDeviceConnectionUserCode(value: string): string {
  const normalized = value.replace(/[\t\n\v\f\r -]/gu, "").toUpperCase();
  if (
    normalized.length !== 8 ||
    [...normalized].some((character) => !USER_CODE_ALPHABET.includes(character))
  ) {
    throw new Error("The device connection code is invalid.");
  }
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

function generateUserCode(): string {
  const bytes = randomBytes(5);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code = USER_CODE_ALPHABET[Number(value & 31n)] + code;
    value >>= 5n;
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export class DeviceConnectionRepository {
  constructor(
    private readonly database: Kysely<DatabaseSchema>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: {
    keyHash: string;
    keyPrefix: string;
    label: string;
  }): Promise<{
    deviceSecret: string;
    expiresAt: string;
    id: string;
    userCode: string;
  }> {
    await this.#cleanupStale();
    const existingKey = await this.database
      .selectFrom("api_keys")
      .select("id")
      .where("key_hash", "=", input.keyHash)
      .executeTakeFirst();
    const existingRequest = await this.database
      .selectFrom("device_connections")
      .select("id")
      .where("key_hash", "=", input.keyHash)
      .executeTakeFirst();
    if (existingKey || existingRequest) {
      throw new DeviceConnectionConflictError();
    }

    const now = this.now();
    const deviceSecret = `yad_${generateSecret()}`;
    const userCode = generateUserCode();
    const id = randomUUID();
    const expiresAt = new Date(
      now.getTime() + DEVICE_CONNECTION_LIFETIME_SECONDS * 1_000,
    ).toISOString();
    try {
      await this.database
        .insertInto("device_connections")
        .values({
          api_key_id: null,
          created_at: now.toISOString(),
          decided_at: null,
          decided_by_user_id: null,
          device_secret_hash: hashSecret(deviceSecret),
          expires_at: expiresAt,
          id,
          key_hash: input.keyHash,
          key_prefix: input.keyPrefix,
          label: input.label,
          status: "pending",
          user_code_hash: hashSecret(userCode),
        })
        .executeTakeFirstOrThrow();
    } catch (error) {
      // Two concurrent creates with the same key hash can both pass the check
      // above; the loser hits the UNIQUE constraint and must surface as the
      // intended 409 conflict rather than a raw 500.
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed")
      ) {
        throw new DeviceConnectionConflictError();
      }
      throw error;
    }
    return { deviceSecret, expiresAt, id, userCode };
  }

  async poll(
    deviceSecret: string,
  ): Promise<
    { status: "denied" | "pending" } | { apiKeyId: string; status: "approved" }
  > {
    const secretHash = hashSecret(deviceSecret);
    const connection = await this.database
      .selectFrom("device_connections")
      .select(["api_key_id", "device_secret_hash", "expires_at", "status"])
      .where("device_secret_hash", "=", secretHash)
      .executeTakeFirst();
    if (
      !connection ||
      !secretMatchesHash(deviceSecret, connection.device_secret_hash)
    ) {
      throw new DeviceConnectionNotFoundError();
    }
    // A connection approved just before expiry must still return its key;
    // otherwise the CLI discards a key that approve() already attached to the
    // account, leaving an orphaned active api_keys row.
    if (connection.status === "approved") {
      if (!connection.api_key_id) {
        throw new DeviceConnectionNotFoundError();
      }
      return { apiKeyId: connection.api_key_id, status: "approved" };
    }
    if (connection.expires_at <= this.#timestamp()) {
      throw new DeviceConnectionExpiredError();
    }
    return { status: connection.status };
  }

  async getPending(userCode: string): Promise<PendingDeviceConnection> {
    const normalizedCode = normalizeDeviceConnectionUserCode(userCode);
    const codeHash = hashSecret(normalizedCode);
    const connection = await this.database
      .selectFrom("device_connections")
      .select([
        "created_at",
        "expires_at",
        "id",
        "key_prefix",
        "label",
        "status",
        "user_code_hash",
      ])
      .where("user_code_hash", "=", codeHash)
      .executeTakeFirst();
    if (
      !connection ||
      !secretMatchesHash(normalizedCode, connection.user_code_hash)
    ) {
      throw new DeviceConnectionNotFoundError();
    }
    this.#requireActionable(connection);
    return {
      createdAt: connection.created_at,
      expiresAt: connection.expires_at,
      id: connection.id,
      keyPrefix: connection.key_prefix,
      label: connection.label,
      status: "pending",
      userCode: normalizedCode,
    };
  }

  async approve(input: {
    id: string;
    userCode: string;
    userId: string;
  }): Promise<{
    apiKey: {
      createdAt: string;
      id: string;
      label: string;
      lastUsedAt: null;
      prefix: string;
    };
    status: "approved";
  }> {
    const normalizedCode = normalizeDeviceConnectionUserCode(input.userCode);
    return this.database.transaction().execute(async (transaction) => {
      const connection = await this.#findForDecision(
        transaction,
        input.id,
        normalizedCode,
      );
      await this.#requireActiveUser(transaction, input.userId);
      const now = this.#timestamp();
      const apiKeyId = randomUUID();
      await transaction
        .insertInto("api_keys")
        .values({
          created_at: now,
          id: apiKeyId,
          key_hash: connection.key_hash,
          key_prefix: connection.key_prefix,
          label: connection.label,
          last_used_at: null,
          revoked_at: null,
          user_id: input.userId,
        })
        .executeTakeFirstOrThrow();
      await this.#markDecided(
        transaction,
        connection.id,
        input.userId,
        "approved",
        apiKeyId,
        now,
      );
      await insertAuditEvent(transaction, {
        action: "api_key.created",
        actorApiKeyId: null,
        actorUserId: input.userId,
        createdAt: now,
        metadata: { source: "device_connection" },
        targetId: apiKeyId,
        targetType: "api_key",
      });
      return {
        apiKey: {
          createdAt: now,
          id: apiKeyId,
          label: connection.label,
          lastUsedAt: null,
          prefix: connection.key_prefix,
        },
        status: "approved",
      };
    });
  }

  async deny(input: {
    id: string;
    userCode: string;
    userId: string;
  }): Promise<void> {
    const normalizedCode = normalizeDeviceConnectionUserCode(input.userCode);
    await this.database.transaction().execute(async (transaction) => {
      const connection = await this.#findForDecision(
        transaction,
        input.id,
        normalizedCode,
      );
      await this.#requireActiveUser(transaction, input.userId);
      await this.#markDecided(
        transaction,
        connection.id,
        input.userId,
        "denied",
        null,
        this.#timestamp(),
      );
    });
  }

  async #findForDecision(
    transaction: Transaction<DatabaseSchema>,
    id: string,
    normalizedCode: string,
  ) {
    const connection = await transaction
      .selectFrom("device_connections")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (
      !connection ||
      !secretMatchesHash(normalizedCode, connection.user_code_hash)
    ) {
      throw new DeviceConnectionNotFoundError();
    }
    this.#requireActionable(connection);
    return connection;
  }

  async #cleanupStale(): Promise<void> {
    const cutoff = new Date(
      this.now().getTime() - DEVICE_CONNECTION_STALE_RETENTION_SECONDS * 1_000,
    ).toISOString();
    const stale = await this.database
      .selectFrom("device_connections")
      .select("id")
      .where("expires_at", "<=", cutoff)
      .orderBy("expires_at", "asc")
      .limit(DEVICE_CONNECTION_CLEANUP_BATCH_SIZE)
      .execute();
    if (stale.length === 0) return;
    await this.database
      .deleteFrom("device_connections")
      .where(
        "id",
        "in",
        stale.map((connection) => connection.id),
      )
      .execute();
  }

  #requireActionable(connection: {
    expires_at: string;
    status: "approved" | "denied" | "pending";
  }): void {
    if (connection.expires_at <= this.#timestamp()) {
      throw new DeviceConnectionExpiredError();
    }
    if (connection.status !== "pending") {
      throw new DeviceConnectionDecidedError();
    }
  }

  async #requireActiveUser(
    transaction: Transaction<DatabaseSchema>,
    userId: string,
  ): Promise<void> {
    const user = await transaction
      .selectFrom("users")
      .select("id")
      .where("id", "=", userId)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!user) {
      throw new DeviceConnectionNotFoundError();
    }
  }

  async #markDecided(
    transaction: Transaction<DatabaseSchema>,
    id: string,
    userId: string,
    status: "approved" | "denied",
    apiKeyId: string | null,
    decidedAt: string,
  ): Promise<void> {
    const result = await transaction
      .updateTable("device_connections")
      .set({
        api_key_id: apiKeyId,
        decided_at: decidedAt,
        decided_by_user_id: userId,
        status,
      })
      .where("id", "=", id)
      .where("status", "=", "pending")
      .where("expires_at", ">", decidedAt)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new DeviceConnectionDecidedError();
    }
  }

  #timestamp(): string {
    return this.now().toISOString();
  }
}
