import { randomUUID } from "node:crypto";

import type { Kysely, Transaction } from "kysely";

import { insertAuditEvent } from "../storage/audit-log.js";

import { generateSecret, hashSecret, secretMatchesHash } from "./secrets.js";
import type {
  DatabaseSchema,
  UserRole,
  WebauthnCeremony,
} from "../storage/schema.js";

export class AuthenticationError extends Error {
  constructor(message = "Authentication failed.") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  constructor() {
    super("The operation is not allowed.");
    this.name = "AuthorizationError";
  }
}

export class AuthenticationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationConflictError";
  }
}

export interface AuthenticatedPrincipal {
  role: UserRole;
  userId: string;
}

export interface AuthenticatedApiKey extends AuthenticatedPrincipal {
  apiKeyId: string;
}

export interface AuthenticatedSession extends AuthenticatedPrincipal {
  csrfTokenHash: string;
  sessionIdHash: string;
}

export interface CreatedApiKey {
  id: string;
  key: string;
  prefix: string;
}

export interface ApiKeySummary {
  createdAt: string;
  id: string;
  label: string;
  lastUsedAt: string | null;
  prefix: string;
}

export interface CreatedSession {
  csrfToken: string;
  expiresAt: string;
  sessionToken: string;
}

export interface CreatedInvitation {
  expiresAt: string;
  id: string;
  token: string;
}

export interface ValidInvitation {
  id: string;
  role: UserRole;
}

export interface AdminUserSummary {
  createdAt: string;
  disabledAt: string | null;
  displayName: string;
  draftCount: number;
  id: string;
  role: UserRole;
  status: "active" | "disabled";
}

export interface InvitationSummary {
  createdAt: string;
  expiresAt: string;
  id: string;
  role: UserRole;
  status: "accepted" | "expired" | "pending" | "revoked";
}

export interface ChallengeContext {
  id: string;
  invitationId: string | null;
  pendingDisplayName: string | null;
  pendingWebauthnUserId: Uint8Array | null;
  userId: string | null;
}

export interface StoredPasskey {
  backedUp: boolean;
  counter: number;
  credentialId: string;
  deviceType: string;
  id: string;
  publicKey: Uint8Array;
  transports: string[];
  userId: string;
}

export interface NewPasskey {
  backedUp: boolean;
  counter: number;
  credentialId: string;
  deviceType: string;
  publicKey: Uint8Array;
  transports: string[];
}

export interface CompletedRegistration {
  recoveryCodes: string[];
  role: UserRole;
  userId: string;
}

export interface PasskeyRegistrationUser {
  displayName: string;
  passkeys: Array<{ credentialId: string; transports: string[] }>;
  webauthnUserId: Uint8Array;
}

export class AuthenticationRepository {
  constructor(
    private readonly database: Kysely<DatabaseSchema>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async countUsers(): Promise<number> {
    const result = await this.database
      .selectFrom("users")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    return Number(result.count);
  }

  // Test seam: no route calls this. Users created here skip the registration
  // invariants (no passkey, no audit event) and, without a webauthnUserId,
  // can never register a passkey. Production users come from completeRegistration.
  async createUser(input: {
    displayName: string;
    role: UserRole;
    webauthnUserId?: Uint8Array | null;
  }): Promise<string> {
    const id = randomUUID();
    await this.database
      .insertInto("users")
      .values({
        created_at: this.#timestamp(),
        disabled_at: null,
        display_name: input.displayName,
        id,
        role: input.role,
        status: "active",
        webauthn_user_id: input.webauthnUserId ?? null,
      })
      .executeTakeFirstOrThrow();
    return id;
  }

  async createApiKey(userId: string, label: string): Promise<CreatedApiKey> {
    await this.#requireActiveUser(userId);
    const id = randomUUID();
    const secret = generateSecret();
    // The public prefix is independent random data so it reveals nothing about
    // the secret material.
    const prefix = generateSecret(8).slice(0, 10);
    const key = `yaaps_${prefix}_${secret}`;
    await this.database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("api_keys")
        .values({
          created_at: this.#timestamp(),
          id,
          key_hash: hashSecret(key),
          key_prefix: `yaaps_${prefix}`,
          label,
          last_used_at: null,
          revoked_at: null,
          user_id: userId,
        })
        .executeTakeFirstOrThrow();
      await this.#auditWith(
        transaction,
        userId,
        null,
        "api_key.created",
        "api_key",
        id,
      );
    });
    return { id, key, prefix: `yaaps_${prefix}` };
  }

  async authenticateApiKey(key: string): Promise<AuthenticatedApiKey> {
    const keyHash = hashSecret(key);
    const match = await this.database
      .selectFrom("api_keys")
      .innerJoin("users", "users.id", "api_keys.user_id")
      .select([
        "api_keys.id as api_key_id",
        "api_keys.key_hash",
        "users.id as user_id",
        "users.role",
      ])
      .where("api_keys.key_hash", "=", keyHash)
      .where("api_keys.revoked_at", "is", null)
      .where("users.status", "=", "active")
      .executeTakeFirst();
    if (!match || !secretMatchesHash(key, match.key_hash)) {
      throw new AuthenticationError();
    }
    await this.database
      .updateTable("api_keys")
      .set({ last_used_at: this.#timestamp() })
      .where("id", "=", match.api_key_id)
      .executeTakeFirstOrThrow();
    return {
      apiKeyId: match.api_key_id,
      role: match.role,
      userId: match.user_id,
    };
  }

  async listApiKeys(ownerId: string): Promise<ApiKeySummary[]> {
    await this.#requireActiveUser(ownerId);
    const keys = await this.database
      .selectFrom("api_keys")
      .select(["created_at", "id", "key_prefix", "label", "last_used_at"])
      .where("user_id", "=", ownerId)
      .where("revoked_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return keys.map((key) => ({
      createdAt: key.created_at,
      id: key.id,
      label: key.label,
      lastUsedAt: key.last_used_at,
      prefix: key.key_prefix,
    }));
  }

  async renameApiKey(
    ownerId: string,
    apiKeyId: string,
    label: string,
  ): Promise<ApiKeySummary> {
    const result = await this.database
      .updateTable("api_keys")
      .set({ label })
      .where("id", "=", apiKeyId)
      .where("user_id", "=", ownerId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new AuthorizationError();
    }
    await this.#audit(ownerId, null, "api_key.renamed", "api_key", apiKeyId);
    const key = await this.database
      .selectFrom("api_keys")
      .select(["created_at", "id", "key_prefix", "label", "last_used_at"])
      .where("id", "=", apiKeyId)
      .executeTakeFirstOrThrow();
    return {
      createdAt: key.created_at,
      id: key.id,
      label: key.label,
      lastUsedAt: key.last_used_at,
      prefix: key.key_prefix,
    };
  }

  async revokeApiKey(ownerId: string, apiKeyId: string): Promise<void> {
    const result = await this.database
      .updateTable("api_keys")
      .set({ revoked_at: this.#timestamp() })
      .where("id", "=", apiKeyId)
      .where("user_id", "=", ownerId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new AuthorizationError();
    }
    await this.#audit(ownerId, null, "api_key.revoked", "api_key", apiKeyId);
  }

  async createSession(
    userId: string,
    lifetimeSeconds: number,
  ): Promise<CreatedSession> {
    await this.#requireActiveUser(userId);
    const sessionToken = `yas_${generateSecret()}`;
    const csrfToken = `yac_${generateSecret()}`;
    const now = this.now();
    const expiresAt = new Date(
      now.getTime() + lifetimeSeconds * 1_000,
    ).toISOString();
    await this.database
      .insertInto("sessions")
      .values({
        created_at: now.toISOString(),
        csrf_token_hash: hashSecret(csrfToken),
        expires_at: expiresAt,
        id_hash: hashSecret(sessionToken),
        last_seen_at: now.toISOString(),
        revoked_at: null,
        user_id: userId,
      })
      .executeTakeFirstOrThrow();
    return { csrfToken, expiresAt, sessionToken };
  }

  async authenticateSession(token: string): Promise<AuthenticatedSession> {
    const tokenHash = hashSecret(token);
    const match = await this.database
      .selectFrom("sessions")
      .innerJoin("users", "users.id", "sessions.user_id")
      .select([
        "sessions.csrf_token_hash",
        "sessions.id_hash",
        "users.id as user_id",
        "users.role",
      ])
      .where("sessions.id_hash", "=", tokenHash)
      .where("sessions.revoked_at", "is", null)
      .where("sessions.expires_at", ">", this.#timestamp())
      .where("users.status", "=", "active")
      .executeTakeFirst();
    if (!match || !secretMatchesHash(token, match.id_hash)) {
      throw new AuthenticationError();
    }
    await this.database
      .updateTable("sessions")
      .set({ last_seen_at: this.#timestamp() })
      .where("id_hash", "=", match.id_hash)
      .executeTakeFirstOrThrow();
    return {
      csrfTokenHash: match.csrf_token_hash,
      role: match.role,
      sessionIdHash: match.id_hash,
      userId: match.user_id,
    };
  }

  verifyCsrf(session: AuthenticatedSession, csrfToken: string): void {
    if (!secretMatchesHash(csrfToken, session.csrfTokenHash)) {
      throw new AuthorizationError();
    }
  }

  async revokeSession(sessionIdHash: string): Promise<void> {
    await this.database
      .updateTable("sessions")
      .set({ revoked_at: this.#timestamp() })
      .where("id_hash", "=", sessionIdHash)
      .executeTakeFirst();
  }

  async createInvitation(input: {
    actorUserId: string;
    lifetimeSeconds: number;
    role: UserRole;
  }): Promise<CreatedInvitation> {
    return this.database.transaction().execute(async (transaction) => {
      const actor = await transaction
        .selectFrom("users")
        .select("role")
        .where("id", "=", input.actorUserId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (actor?.role !== "admin") {
        throw new AuthorizationError();
      }
      const token = `yai_${generateSecret()}`;
      const id = randomUUID();
      const expiresAt = new Date(
        this.now().getTime() + input.lifetimeSeconds * 1_000,
      ).toISOString();
      await transaction
        .insertInto("invitations")
        .values({
          accepted_at: null,
          accepted_by_user_id: null,
          code_hash: hashSecret(token),
          created_at: this.#timestamp(),
          expires_at: expiresAt,
          id,
          invited_by_user_id: input.actorUserId,
          revoked_at: null,
          role: input.role,
        })
        .executeTakeFirstOrThrow();
      await this.#auditWith(
        transaction,
        input.actorUserId,
        null,
        "invitation.created",
        "invitation",
        id,
      );
      return { expiresAt, id, token };
    });
  }

  async findValidInvitation(token: string): Promise<ValidInvitation> {
    const tokenHash = hashSecret(token);
    const invitation = await this.database
      .selectFrom("invitations")
      .select(["code_hash", "id", "role"])
      .where("code_hash", "=", tokenHash)
      .where("accepted_at", "is", null)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", this.#timestamp())
      .executeTakeFirst();
    if (!invitation || !secretMatchesHash(token, invitation.code_hash)) {
      throw new AuthenticationError("The invitation is invalid or expired.");
    }
    return { id: invitation.id, role: invitation.role };
  }

  async listUsers(actorUserId: string): Promise<AdminUserSummary[]> {
    await this.#requireAdmin(actorUserId);
    const [users, draftCounts] = await Promise.all([
      this.database
        .selectFrom("users")
        .select([
          "created_at",
          "disabled_at",
          "display_name",
          "id",
          "role",
          "status",
        ])
        .orderBy("created_at", "asc")
        .orderBy("id", "asc")
        .execute(),
      this.database
        .selectFrom("drafts")
        .select(["owner_id", ({ fn }) => fn.countAll<number>().as("count")])
        .groupBy("owner_id")
        .execute(),
    ]);
    const counts = new Map(
      draftCounts.map((entry) => [entry.owner_id, Number(entry.count)]),
    );
    return users.map((user) => ({
      createdAt: user.created_at,
      disabledAt: user.disabled_at,
      displayName: user.display_name,
      draftCount: counts.get(user.id) ?? 0,
      id: user.id,
      role: user.role,
      status: user.status,
    }));
  }

  async listInvitations(actorUserId: string): Promise<InvitationSummary[]> {
    await this.#requireAdmin(actorUserId);
    const now = this.#timestamp();
    const invitations = await this.database
      .selectFrom("invitations")
      .select([
        "accepted_at",
        "created_at",
        "expires_at",
        "id",
        "revoked_at",
        "role",
      ])
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .execute();
    return invitations.map((invitation) => ({
      createdAt: invitation.created_at,
      expiresAt: invitation.expires_at,
      id: invitation.id,
      role: invitation.role,
      status: invitation.accepted_at
        ? "accepted"
        : invitation.revoked_at
          ? "revoked"
          : invitation.expires_at <= now
            ? "expired"
            : "pending",
    }));
  }

  async revokeInvitation(
    actorUserId: string,
    invitationId: string,
  ): Promise<void> {
    await this.#requireAdmin(actorUserId);
    const result = await this.database
      .updateTable("invitations")
      .set({ revoked_at: this.#timestamp() })
      .where("id", "=", invitationId)
      .where("accepted_at", "is", null)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new AuthorizationError();
    }
    await this.#audit(
      actorUserId,
      null,
      "invitation.revoked",
      "invitation",
      invitationId,
    );
  }

  async disableUser(actorUserId: string, targetUserId: string): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const actor = await transaction
        .selectFrom("users")
        .select("role")
        .where("id", "=", actorUserId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (actor?.role !== "admin" || actorUserId === targetUserId) {
        throw new AuthorizationError();
      }
      const target = await transaction
        .selectFrom("users")
        .select("role")
        .where("id", "=", targetUserId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!target) {
        throw new AuthorizationError();
      }
      if (target.role === "admin") {
        const activeAdmins = await transaction
          .selectFrom("users")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .where("role", "=", "admin")
          .where("status", "=", "active")
          .executeTakeFirstOrThrow();
        if (Number(activeAdmins.count) <= 1) {
          throw new AuthorizationError();
        }
      }
      await transaction
        .updateTable("users")
        .set({ disabled_at: this.#timestamp(), status: "disabled" })
        .where("id", "=", targetUserId)
        .where("status", "=", "active")
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sessions")
        .set({ revoked_at: this.#timestamp() })
        .where("user_id", "=", targetUserId)
        .where("revoked_at", "is", null)
        .execute();
      await transaction
        .updateTable("api_keys")
        .set({ revoked_at: this.#timestamp() })
        .where("user_id", "=", targetUserId)
        .where("revoked_at", "is", null)
        .execute();
      await transaction
        .updateTable("drafts")
        .set({ status: "disabled", updated_at: this.#timestamp() })
        .where("owner_id", "=", targetUserId)
        .where("status", "=", "enabled")
        .execute();
      await this.#auditWith(
        transaction,
        actorUserId,
        null,
        "user.disabled",
        "user",
        targetUserId,
      );
    });
  }

  async enableUser(actorUserId: string, targetUserId: string): Promise<void> {
    await this.#requireAdmin(actorUserId);
    const result = await this.database
      .updateTable("users")
      .set({ disabled_at: null, status: "active" })
      .where("id", "=", targetUserId)
      .where("status", "=", "disabled")
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new AuthorizationError();
    }
    await this.#audit(actorUserId, null, "user.enabled", "user", targetUserId);
  }

  // Test seam: production ceremonies consume challenges inside their own
  // transactions. Find and consume run in one transaction here so the seam
  // cannot race the way a separate find-then-consume would.
  async consumeChallenge(
    ceremony: WebauthnCeremony,
    challenge: string,
  ): Promise<ChallengeContext> {
    return this.database.transaction().execute(async (transaction) => {
      const match = await transaction
        .selectFrom("webauthn_challenges")
        .select([
          "id",
          "invitation_id",
          "pending_display_name",
          "pending_webauthn_user_id",
          "user_id",
        ])
        .where("challenge_hash", "=", hashSecret(challenge))
        .where("ceremony", "=", ceremony)
        .where("consumed_at", "is", null)
        .where("expires_at", ">", this.#timestamp())
        .executeTakeFirst();
      if (!match) {
        throw new AuthenticationError();
      }
      await this.#consumeChallengeWith(transaction, match.id, ceremony);
      return {
        id: match.id,
        invitationId: match.invitation_id,
        pendingDisplayName: match.pending_display_name,
        pendingWebauthnUserId: match.pending_webauthn_user_id,
        userId: match.user_id,
      };
    });
  }

  async findValidChallenge(
    ceremony: WebauthnCeremony,
    challenge: string,
  ): Promise<ChallengeContext> {
    const match = await this.database
      .selectFrom("webauthn_challenges")
      .select([
        "id",
        "invitation_id",
        "pending_display_name",
        "pending_webauthn_user_id",
        "user_id",
      ])
      .where("challenge_hash", "=", hashSecret(challenge))
      .where("ceremony", "=", ceremony)
      .where("consumed_at", "is", null)
      .where("expires_at", ">", this.#timestamp())
      .executeTakeFirst();
    if (!match) {
      throw new AuthenticationError(
        "The authentication challenge is invalid or expired.",
      );
    }
    return {
      id: match.id,
      invitationId: match.invitation_id,
      pendingDisplayName: match.pending_display_name,
      pendingWebauthnUserId: match.pending_webauthn_user_id,
      userId: match.user_id,
    };
  }

  async saveChallenge(input: {
    ceremony: WebauthnCeremony;
    challenge: string;
    invitationId?: string | null;
    lifetimeSeconds?: number;
    pendingDisplayName?: string | null;
    pendingWebauthnUserId?: Uint8Array | null;
    userId?: string | null;
  }): Promise<string> {
    const id = randomUUID();
    const lifetimeSeconds = input.lifetimeSeconds ?? 300;
    // Bound the table: this endpoint is unauthenticated, so purge expired rows
    // (consumed rows self-expire within their lifetime) on every insert.
    await this.database
      .deleteFrom("webauthn_challenges")
      .where("expires_at", "<=", this.#timestamp())
      .execute();
    await this.database
      .insertInto("webauthn_challenges")
      .values({
        ceremony: input.ceremony,
        challenge_hash: hashSecret(input.challenge),
        consumed_at: null,
        created_at: this.#timestamp(),
        expires_at: new Date(
          this.now().getTime() + lifetimeSeconds * 1_000,
        ).toISOString(),
        id,
        invitation_id: input.invitationId ?? null,
        pending_display_name: input.pendingDisplayName ?? null,
        pending_webauthn_user_id: input.pendingWebauthnUserId ?? null,
        user_id: input.userId ?? null,
      })
      .executeTakeFirstOrThrow();
    return id;
  }

  async regenerateRecoveryCodes(userId: string, count = 8): Promise<string[]> {
    await this.#requireActiveUser(userId);
    const codes = await this.database
      .transaction()
      .execute(async (transaction) => {
        await transaction
          .deleteFrom("recovery_codes")
          .where("user_id", "=", userId)
          .where("used_at", "is", null)
          .execute();
        return this.#insertRecoveryCodes(transaction, userId, count);
      });
    await this.#audit(
      userId,
      null,
      "recovery_codes.regenerated",
      "user",
      userId,
    );
    return codes;
  }

  // Test seam: not exposed by any route. Delegates to the same generator the
  // registration flow uses so the code format cannot drift between the two.
  async createRecoveryCodes(userId: string, count = 8): Promise<string[]> {
    await this.#requireActiveUser(userId);
    const codes = await this.database
      .transaction()
      .execute((transaction) =>
        this.#insertRecoveryCodes(transaction, userId, count),
      );
    await this.#audit(userId, null, "recovery_codes.created", "user", userId);
    return codes;
  }

  async completeRegistration(
    challengeId: string,
    ceremony: "bootstrap" | "invitation",
    passkey: NewPasskey,
    options: { allowOpenRegistration?: boolean } = {},
  ): Promise<CompletedRegistration> {
    return this.database.transaction().execute(async (transaction) => {
      const challenge = await transaction
        .selectFrom("webauthn_challenges")
        .select([
          "invitation_id",
          "pending_display_name",
          "pending_webauthn_user_id",
        ])
        .where("id", "=", challengeId)
        .where("ceremony", "=", ceremony)
        .where("consumed_at", "is", null)
        .where("expires_at", ">", this.#timestamp())
        .executeTakeFirst();
      if (
        !challenge?.pending_display_name ||
        !challenge.pending_webauthn_user_id
      ) {
        throw new AuthenticationError(
          "The registration challenge is invalid or expired.",
        );
      }
      await this.#consumeChallengeWith(transaction, challengeId, ceremony);

      let role: UserRole = "admin";
      if (ceremony === "bootstrap") {
        const count = await transaction
          .selectFrom("users")
          .select(({ fn }) => fn.countAll<number>().as("count"))
          .executeTakeFirstOrThrow();
        if (Number(count.count) !== 0) {
          throw new AuthenticationConflictError(
            "Bootstrap has already been completed.",
          );
        }
      } else if (!challenge.invitation_id) {
        // An invitation-ceremony challenge without an invitation is the open
        // self-registration path; it is only honored when the service allows it.
        if (!options.allowOpenRegistration) {
          throw new AuthenticationError(
            "The invitation is invalid or expired.",
          );
        }
        role = "user";
      } else {
        const invitation = await transaction
          .selectFrom("invitations")
          .select("role")
          .where("id", "=", challenge.invitation_id)
          .where("accepted_at", "is", null)
          .where("revoked_at", "is", null)
          .where("expires_at", ">", this.#timestamp())
          .executeTakeFirst();
        if (!invitation) {
          throw new AuthenticationError(
            "The invitation is invalid or expired.",
          );
        }
        role = invitation.role;
      }

      const userId = randomUUID();
      await transaction
        .insertInto("users")
        .values({
          created_at: this.#timestamp(),
          disabled_at: null,
          display_name: challenge.pending_display_name,
          id: userId,
          role,
          status: "active",
          webauthn_user_id: challenge.pending_webauthn_user_id,
        })
        .executeTakeFirstOrThrow();
      await this.#insertPasskey(transaction, userId, passkey);

      if (challenge.invitation_id) {
        const accepted = await transaction
          .updateTable("invitations")
          .set({
            accepted_at: this.#timestamp(),
            accepted_by_user_id: userId,
          })
          .where("id", "=", challenge.invitation_id)
          .where("accepted_at", "is", null)
          .executeTakeFirst();
        if (accepted.numUpdatedRows !== 1n) {
          throw new AuthenticationError("The invitation is already used.");
        }
      }

      const recoveryCodes = await this.#insertRecoveryCodes(
        transaction,
        userId,
        8,
      );
      await this.#auditWith(
        transaction,
        userId,
        null,
        ceremony === "bootstrap"
          ? "bootstrap.completed"
          : challenge.invitation_id
            ? "invitation.accepted"
            : "registration.completed",
        "user",
        userId,
      );
      return { recoveryCodes, role, userId };
    });
  }

  async findPasskey(credentialId: string): Promise<StoredPasskey | undefined> {
    const match = await this.database
      .selectFrom("webauthn_credentials")
      .innerJoin("users", "users.id", "webauthn_credentials.user_id")
      .select([
        "webauthn_credentials.backed_up",
        "webauthn_credentials.counter",
        "webauthn_credentials.credential_id",
        "webauthn_credentials.device_type",
        "webauthn_credentials.id",
        "webauthn_credentials.public_key",
        "webauthn_credentials.transports_json",
        "users.id as user_id",
      ])
      .where(
        "webauthn_credentials.credential_id",
        "=",
        Buffer.from(credentialId, "base64url"),
      )
      .where("users.status", "=", "active")
      .executeTakeFirst();
    if (!match) {
      return undefined;
    }
    return {
      backedUp: match.backed_up === 1,
      counter: match.counter,
      credentialId: Buffer.from(match.credential_id).toString("base64url"),
      deviceType: match.device_type,
      id: match.id,
      publicKey: new Uint8Array(match.public_key),
      transports: JSON.parse(match.transports_json) as string[],
      userId: match.user_id,
    };
  }

  async getPasskeyRegistrationUser(
    userId: string,
  ): Promise<PasskeyRegistrationUser> {
    const user = await this.database
      .selectFrom("users")
      .select(["display_name", "webauthn_user_id"])
      .where("id", "=", userId)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!user?.webauthn_user_id) {
      throw new AuthenticationError();
    }
    const credentials = await this.database
      .selectFrom("webauthn_credentials")
      .select(["credential_id", "transports_json"])
      .where("user_id", "=", userId)
      .execute();
    return {
      displayName: user.display_name,
      passkeys: credentials.map((credential) => ({
        credentialId: Buffer.from(credential.credential_id).toString(
          "base64url",
        ),
        transports: JSON.parse(credential.transports_json) as string[],
      })),
      webauthnUserId: new Uint8Array(user.webauthn_user_id),
    };
  }

  async completeAdditionalPasskey(
    challengeId: string,
    userId: string,
    passkey: NewPasskey,
  ): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      const challenge = await transaction
        .selectFrom("webauthn_challenges")
        .select("user_id")
        .where("id", "=", challengeId)
        .where("ceremony", "=", "add_credential")
        .where("consumed_at", "is", null)
        .where("expires_at", ">", this.#timestamp())
        .executeTakeFirst();
      if (challenge?.user_id !== userId) {
        throw new AuthorizationError();
      }
      await this.#consumeChallengeWith(
        transaction,
        challengeId,
        "add_credential",
      );
      await this.#insertPasskey(transaction, userId, passkey);
      await this.#auditWith(
        transaction,
        userId,
        null,
        "passkey.added",
        "user",
        userId,
      );
    });
  }

  async completeAuthentication(input: {
    challengeId: string;
    credentialId: string;
    newCounter: number;
  }): Promise<AuthenticatedPrincipal> {
    return this.database.transaction().execute(async (transaction) => {
      await this.#consumeChallengeWith(
        transaction,
        input.challengeId,
        "authenticate",
      );
      const credential = await transaction
        .selectFrom("webauthn_credentials")
        .innerJoin("users", "users.id", "webauthn_credentials.user_id")
        .select([
          "webauthn_credentials.counter",
          "webauthn_credentials.id",
          "users.id as user_id",
          "users.role",
        ])
        .where(
          "webauthn_credentials.credential_id",
          "=",
          Buffer.from(input.credentialId, "base64url"),
        )
        .where("users.status", "=", "active")
        .executeTakeFirst();
      if (!credential) {
        throw new AuthenticationError();
      }
      const updated = await transaction
        .updateTable("webauthn_credentials")
        .set({
          counter: input.newCounter,
          last_used_at: this.#timestamp(),
        })
        .where("id", "=", credential.id)
        .where("counter", "=", credential.counter)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) {
        throw new AuthenticationError();
      }
      return { role: credential.role, userId: credential.user_id };
    });
  }

  async consumeRecoveryCode(code: string): Promise<AuthenticatedPrincipal> {
    return this.database.transaction().execute(async (transaction) => {
      const codeHash = hashSecret(code);
      const match = await transaction
        .selectFrom("recovery_codes")
        .innerJoin("users", "users.id", "recovery_codes.user_id")
        .select(["recovery_codes.id", "users.id as user_id", "users.role"])
        .where("recovery_codes.code_hash", "=", codeHash)
        .where("recovery_codes.used_at", "is", null)
        .where("users.status", "=", "active")
        .executeTakeFirst();
      if (!match) {
        throw new AuthenticationError(
          "The recovery code is invalid or already used.",
        );
      }
      const result = await transaction
        .updateTable("recovery_codes")
        .set({ used_at: this.#timestamp() })
        .where("id", "=", match.id)
        .where("used_at", "is", null)
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n) {
        throw new AuthenticationError(
          "The recovery code is invalid or already used.",
        );
      }
      await this.#auditWith(
        transaction,
        match.user_id,
        null,
        "recovery_code.used",
        "user",
        match.user_id,
      );
      return { role: match.role, userId: match.user_id };
    });
  }

  async #consumeChallengeWith(
    transaction: Transaction<DatabaseSchema>,
    challengeId: string,
    ceremony: WebauthnCeremony,
  ): Promise<void> {
    const result = await transaction
      .updateTable("webauthn_challenges")
      .set({ consumed_at: this.#timestamp() })
      .where("id", "=", challengeId)
      .where("ceremony", "=", ceremony)
      .where("consumed_at", "is", null)
      .where("expires_at", ">", this.#timestamp())
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new AuthenticationError(
        "The authentication challenge is invalid, expired, or already used.",
      );
    }
  }

  async #insertPasskey(
    transaction: Transaction<DatabaseSchema>,
    userId: string,
    passkey: NewPasskey,
  ): Promise<void> {
    await transaction
      .insertInto("webauthn_credentials")
      .values({
        backed_up: passkey.backedUp ? 1 : 0,
        counter: passkey.counter,
        created_at: this.#timestamp(),
        credential_id: Buffer.from(passkey.credentialId, "base64url"),
        device_type: passkey.deviceType,
        id: randomUUID(),
        last_used_at: null,
        public_key: passkey.publicKey,
        transports_json: JSON.stringify(passkey.transports),
        user_id: userId,
      })
      .executeTakeFirstOrThrow();
  }

  async #insertRecoveryCodes(
    transaction: Transaction<DatabaseSchema>,
    userId: string,
    count: number,
  ): Promise<string[]> {
    const codes = Array.from(
      { length: count },
      () => `yar_${generateSecret(20)}`,
    );
    await transaction
      .insertInto("recovery_codes")
      .values(
        codes.map((code) => ({
          code_hash: hashSecret(code),
          created_at: this.#timestamp(),
          id: randomUUID(),
          used_at: null,
          user_id: userId,
        })),
      )
      .execute();
    return codes;
  }

  async #requireActiveUser(userId: string): Promise<void> {
    const user = await this.database
      .selectFrom("users")
      .select("id")
      .where("id", "=", userId)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!user) {
      throw new AuthenticationError();
    }
  }

  async #requireAdmin(userId: string): Promise<void> {
    const user = await this.database
      .selectFrom("users")
      .select("id")
      .where("id", "=", userId)
      .where("role", "=", "admin")
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!user) {
      throw new AuthorizationError();
    }
  }

  async #audit(
    actorUserId: string | null,
    actorApiKeyId: string | null,
    action: string,
    targetType: string,
    targetId: string | null,
  ): Promise<void> {
    await this.#auditWith(
      this.database,
      actorUserId,
      actorApiKeyId,
      action,
      targetType,
      targetId,
    );
  }

  async #auditWith(
    database: Kysely<DatabaseSchema> | Transaction<DatabaseSchema>,
    actorUserId: string | null,
    actorApiKeyId: string | null,
    action: string,
    targetType: string,
    targetId: string | null,
  ): Promise<void> {
    await insertAuditEvent(database, {
      action,
      actorApiKeyId,
      actorUserId,
      createdAt: this.#timestamp(),
      targetId,
      targetType,
    });
  }

  #timestamp(): string {
    return this.now().toISOString();
  }
}
