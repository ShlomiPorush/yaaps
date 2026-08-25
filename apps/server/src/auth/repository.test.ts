import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AuthenticationError,
  AuthenticationRepository,
  AuthorizationError,
} from "./repository.js";
import { openDatabase, type YaapsDatabase } from "../storage/database.js";

const temporaryPaths: string[] = [];
let database: YaapsDatabase;
let repository: AuthenticationRepository;
let now: Date;

beforeEach(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-auth-test-"));
  temporaryPaths.push(directory);
  database = await openDatabase(directory);
  now = new Date("2026-08-24T00:00:00.000Z");
  repository = new AuthenticationRepository(database.connection, () => now);
});

afterEach(async () => {
  await database.connection.destroy();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

describe("authentication repository", () => {
  it("authenticates and revokes API keys without allowing cross-user revocation", async () => {
    const ownerId = await repository.createUser({
      displayName: "Owner",
      role: "user",
    });
    const otherId = await repository.createUser({
      displayName: "Other",
      role: "user",
    });
    const created = await repository.createApiKey(ownerId, "Local agent");

    expect(created.key).toMatch(/^yaaps_[A-Za-z0-9_-]{10}_/);
    await expect(repository.authenticateApiKey(created.key)).resolves.toEqual({
      apiKeyId: created.id,
      role: "user",
      userId: ownerId,
    });
    await expect(
      repository.revokeApiKey(otherId, created.id),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await repository.revokeApiKey(ownerId, created.id);
    await expect(
      repository.authenticateApiKey(created.key),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("enforces session expiry, revocation, and CSRF", async () => {
    const userId = await repository.createUser({
      displayName: "Session user",
      role: "user",
    });
    const created = await repository.createSession(userId, 60);
    const authenticated = await repository.authenticateSession(
      created.sessionToken,
    );

    expect(() =>
      repository.verifyCsrf(authenticated, created.csrfToken),
    ).not.toThrow();
    expect(() => repository.verifyCsrf(authenticated, "wrong")).toThrow(
      AuthorizationError,
    );

    now = new Date(now.getTime() + 61_000);
    await expect(
      repository.authenticateSession(created.sessionToken),
    ).rejects.toBeInstanceOf(AuthenticationError);

    now = new Date("2026-08-24T00:00:00.000Z");
    const revocable = await repository.createSession(userId, 60);
    const session = await repository.authenticateSession(
      revocable.sessionToken,
    );
    await repository.revokeSession(session.sessionIdHash);
    await expect(
      repository.authenticateSession(revocable.sessionToken),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("allows only administrators to create expiring invitations", async () => {
    const adminId = await repository.createUser({
      displayName: "Admin",
      role: "admin",
    });
    const userId = await repository.createUser({
      displayName: "User",
      role: "user",
    });

    await expect(
      repository.createInvitation({
        actorUserId: userId,
        lifetimeSeconds: 300,
        role: "user",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const invitation = await repository.createInvitation({
      actorUserId: adminId,
      lifetimeSeconds: 300,
      role: "user",
    });
    expect(invitation.token).toMatch(/^yai_/);
    expect(invitation.expiresAt).toBe("2026-08-24T00:05:00.000Z");

    expect(await repository.listInvitations(adminId)).toEqual([
      expect.objectContaining({
        id: invitation.id,
        role: "user",
        status: "pending",
      }),
    ]);
    await expect(repository.listInvitations(userId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await repository.revokeInvitation(adminId, invitation.id);
    expect(await repository.listInvitations(adminId)).toEqual([
      expect.objectContaining({ id: invitation.id, status: "revoked" }),
    ]);
  });

  it("consumes WebAuthn challenges and recovery codes only once", async () => {
    const userId = await repository.createUser({
      displayName: "Recoverable user",
      role: "user",
    });
    await repository.saveChallenge({
      ceremony: "authenticate",
      challenge: "challenge-value",
      userId,
    });

    await expect(
      repository.consumeChallenge("authenticate", "challenge-value"),
    ).resolves.toMatchObject({ userId });
    await expect(
      repository.consumeChallenge("authenticate", "challenge-value"),
    ).rejects.toBeInstanceOf(AuthenticationError);

    const [code] = await repository.createRecoveryCodes(userId, 1);
    expect(code).toBeDefined();
    await expect(repository.consumeRecoveryCode(code!)).resolves.toEqual({
      role: "user",
      userId,
    });
    await expect(repository.consumeRecoveryCode(code!)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
  });

  it("completes bootstrap atomically and never exposes stored secrets", async () => {
    const challenge = "bootstrap-challenge";
    const challengeId = await repository.saveChallenge({
      ceremony: "bootstrap",
      challenge,
      pendingDisplayName: "Initial administrator",
      pendingWebauthnUserId: new Uint8Array([1, 2, 3, 4]),
    });
    const context = await repository.findValidChallenge("bootstrap", challenge);
    expect(context.id).toBe(challengeId);

    const completed = await repository.completeRegistration(
      challengeId,
      "bootstrap",
      {
        backedUp: true,
        counter: 0,
        credentialId: Buffer.from("credential-one").toString("base64url"),
        deviceType: "multiDevice",
        publicKey: new Uint8Array([5, 6, 7]),
        transports: ["internal"],
      },
    );

    expect(completed.recoveryCodes).toHaveLength(8);
    expect(await repository.countUsers()).toBe(1);
    expect(
      await repository.findPasskey(
        Buffer.from("credential-one").toString("base64url"),
      ),
    ).toMatchObject({ userId: completed.userId });
    await expect(
      repository.completeRegistration(challengeId, "bootstrap", {
        backedUp: true,
        counter: 0,
        credentialId: Buffer.from("credential-two").toString("base64url"),
        deviceType: "multiDevice",
        publicKey: new Uint8Array([8, 9]),
        transports: [],
      }),
    ).rejects.toBeInstanceOf(AuthenticationError);

    const storedRecovery = await database.connection
      .selectFrom("recovery_codes")
      .select("code_hash")
      .execute();
    expect(storedRecovery[0]?.code_hash).not.toBe(completed.recoveryCodes[0]);
  });

  it("revokes every session and API key when an administrator disables a user", async () => {
    const adminId = await repository.createUser({
      displayName: "Admin",
      role: "admin",
    });
    const userId = await repository.createUser({
      displayName: "User",
      role: "user",
    });
    const key = await repository.createApiKey(userId, "Agent");
    const session = await repository.createSession(userId, 300);
    await database.connection
      .insertInto("drafts")
      .values({
        created_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 300_000).toISOString(),
        id: "abcdefghijabcdefghijabcdefghijab",
        latest_version_number: 1,
        owner_id: userId,
        status: "enabled",
        title: "Published report",
        updated_at: now.toISOString(),
      })
      .executeTakeFirstOrThrow();

    await expect(
      repository.disableUser(userId, adminId),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await repository.disableUser(adminId, userId);
    await expect(repository.authenticateApiKey(key.key)).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    await expect(
      repository.authenticateSession(session.sessionToken),
    ).rejects.toBeInstanceOf(AuthenticationError);
    await expect(
      database.connection
        .selectFrom("drafts")
        .select("status")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "disabled" });

    expect(await repository.listUsers(adminId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayName: "Admin",
          draftCount: 0,
          status: "active",
        }),
        expect.objectContaining({
          displayName: "User",
          draftCount: 1,
          status: "disabled",
        }),
      ]),
    );
    await repository.enableUser(adminId, userId);
    expect(await repository.listUsers(adminId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: userId, status: "active" }),
      ]),
    );
    await expect(repository.listUsers(userId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
