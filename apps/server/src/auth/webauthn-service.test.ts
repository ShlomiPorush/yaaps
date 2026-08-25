import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthenticationError, AuthenticationRepository } from "./repository.js";
import {
  WebAuthnService,
  type WebAuthnImplementation,
} from "./webauthn-service.js";
import { openDatabase, type YaapsDatabase } from "../storage/database.js";

const credentialId = Buffer.from("test-credential").toString("base64url");
const registrationResponse = {
  clientExtensionResults: {},
  id: credentialId,
  rawId: credentialId,
  response: {
    attestationObject: "attestation",
    clientDataJSON: "client-data",
    transports: ["internal"],
  },
  type: "public-key",
} as RegistrationResponseJSON;
const authenticationResponse = {
  clientExtensionResults: {},
  id: credentialId,
  rawId: credentialId,
  response: {
    authenticatorData: "authenticator-data",
    clientDataJSON: "client-data",
    signature: "signature",
  },
  type: "public-key",
} as AuthenticationResponseJSON;

interface CapturedVerifyOptions {
  expectedOrigin: unknown;
  expectedRPID: unknown;
  requireUserVerification: unknown;
}

function fakeWebAuthn(
  captured?: CapturedVerifyOptions[],
): WebAuthnImplementation {
  let registrationNumber = 0;
  let currentRegistrationChallenge = "";
  return {
    generateAuthenticationOptions: (async () => ({
      challenge: "authentication-challenge",
      rpId: "share.yaaps.net",
      userVerification: "required",
    })) as WebAuthnImplementation["generateAuthenticationOptions"],
    generateRegistrationOptions: (async (options) => {
      registrationNumber += 1;
      currentRegistrationChallenge = `registration-challenge${
        registrationNumber === 1 ? "" : `-${registrationNumber}`
      }`;
      return {
        challenge: currentRegistrationChallenge,
        excludeCredentials: options.excludeCredentials,
        pubKeyCredParams: [],
        rp: { id: "share.yaaps.net", name: "YAAPS" },
        user: { displayName: "Admin", id: "user", name: "Admin" },
      };
    }) as WebAuthnImplementation["generateRegistrationOptions"],
    verifyAuthenticationResponse: (async (options) => {
      captured?.push({
        expectedOrigin: options.expectedOrigin,
        expectedRPID: options.expectedRPID,
        requireUserVerification: options.requireUserVerification,
      });
      const valid =
        typeof options.expectedChallenge === "function" &&
        (await options.expectedChallenge("authentication-challenge"));
      return {
        authenticationInfo: {
          credentialBackedUp: true,
          credentialDeviceType: "multiDevice",
          credentialID: credentialId,
          newCounter: 1,
          origin: "https://share.yaaps.net",
          rpID: "share.yaaps.net",
          userVerified: true,
        },
        verified: Boolean(valid),
      };
    }) as WebAuthnImplementation["verifyAuthenticationResponse"],
    verifyRegistrationResponse: (async (options) => {
      captured?.push({
        expectedOrigin: options.expectedOrigin,
        expectedRPID: options.expectedRPID,
        requireUserVerification: options.requireUserVerification,
      });
      const valid =
        typeof options.expectedChallenge === "function" &&
        (await options.expectedChallenge(currentRegistrationChallenge));
      return valid
        ? {
            registrationInfo: {
              aaguid: "aaguid",
              attestationObject: new Uint8Array(),
              authenticatorExtensionResults: {},
              credential: {
                counter: 0,
                id: options.response.id,
                publicKey: new Uint8Array([1, 2, 3]),
              },
              credentialBackedUp: true,
              credentialDeviceType: "multiDevice",
              credentialType: "public-key",
              fmt: "none",
              origin: "https://share.yaaps.net",
              rpID: "share.yaaps.net",
              userVerified: true,
            },
            verified: true,
          }
        : { verified: false };
    }) as WebAuthnImplementation["verifyRegistrationResponse"],
  };
}

describe("WebAuthn service", () => {
  let database: YaapsDatabase;
  let directory: string;
  let repository: AuthenticationRepository;
  let service: WebAuthnService;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "yaaps-webauthn-test-"));
    database = await openDatabase(directory);
    repository = new AuthenticationRepository(database.connection);
    service = new WebAuthnService(
      repository,
      {
        bootstrapSecret: "bootstrap-secret-that-is-at-least-32-characters",
        origin: "https://share.yaaps.net",
        rpId: "share.yaaps.net",
      },
      fakeWebAuthn(),
    );
  });

  afterEach(async () => {
    await database.connection.destroy();
    await rm(directory, { force: true, recursive: true });
  });

  it("passes the configured origin, RP ID, and user-verification requirement to every ceremony", async () => {
    const captured: CapturedVerifyOptions[] = [];
    const capturingService = new WebAuthnService(
      repository,
      {
        bootstrapSecret: "bootstrap-secret-that-is-at-least-32-characters",
        origin: "https://share.yaaps.net",
        rpId: "share.yaaps.net",
      },
      fakeWebAuthn(captured),
    );
    await capturingService.beginBootstrap(
      "bootstrap-secret-that-is-at-least-32-characters",
      "Admin",
    );
    await capturingService.completeRegistration(
      "bootstrap",
      registrationResponse,
    );
    await capturingService.beginAuthentication();
    await capturingService.completeAuthentication(authenticationResponse);

    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const options of captured) {
      expect(options).toEqual({
        expectedOrigin: "https://share.yaaps.net",
        expectedRPID: "share.yaaps.net",
        requireUserVerification: true,
      });
    }
  });

  it("registers a self-service user only when open registration is enabled", async () => {
    const openService = new WebAuthnService(
      repository,
      {
        openRegistration: true,
        origin: "https://share.yaaps.net",
        rpId: "share.yaaps.net",
      },
      fakeWebAuthn(),
    );
    await expect(
      service.beginOpenRegistration("Visitor"),
    ).rejects.toBeInstanceOf(AuthenticationError);

    await openService.beginOpenRegistration("Visitor");
    const completed = await openService.completeRegistration(
      "invitation",
      registrationResponse,
      { allowOpenRegistration: true },
    );
    expect(completed).toMatchObject({ role: "user" });
    expect(completed.recoveryCodes).toHaveLength(8);

    // The open path must not smuggle a user through the invitation route when
    // the flag is off, and a no-invitation challenge is rejected without it.
    await openService.beginOpenRegistration("Second visitor");
    await expect(
      openService.completeRegistration("invitation", registrationResponse),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("establishes the first administrator and rejects bootstrap reuse", async () => {
    await expect(
      service.beginBootstrap("wrong-secret", "Admin"),
    ).rejects.toBeInstanceOf(AuthenticationError);
    await expect(
      service.beginBootstrap(
        "bootstrap-secret-that-is-at-least-32-characters",
        "Admin",
      ),
    ).resolves.toMatchObject({ challenge: "registration-challenge" });

    const completed = await service.completeRegistration(
      "bootstrap",
      registrationResponse,
    );
    expect(completed).toMatchObject({ role: "admin" });
    expect(completed.recoveryCodes).toHaveLength(8);
    await expect(
      repository.authenticateSession(completed.sessionToken),
    ).resolves.toMatchObject({ userId: completed.userId });
    await expect(
      service.beginBootstrap(
        "bootstrap-secret-that-is-at-least-32-characters",
        "Another admin",
      ),
    ).rejects.toThrow("Bootstrap has already been completed.");
  });

  it("authenticates with a stored credential and rejects assertion replay", async () => {
    await service.beginBootstrap(
      "bootstrap-secret-that-is-at-least-32-characters",
      "Admin",
    );
    await service.completeRegistration("bootstrap", registrationResponse);
    await expect(service.beginAuthentication()).resolves.toMatchObject({
      challenge: "authentication-challenge",
    });

    await expect(
      service.completeAuthentication(authenticationResponse),
    ).resolves.toMatchObject({ role: "admin" });
    await expect(
      service.completeAuthentication(authenticationResponse),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("accepts each administrator invitation exactly once", async () => {
    const adminId = await repository.createUser({
      displayName: "Existing admin",
      role: "admin",
    });
    const invitation = await repository.createInvitation({
      actorUserId: adminId,
      lifetimeSeconds: 300,
      role: "user",
    });

    await expect(
      service.beginInvitation(invitation.token, "Invited user"),
    ).resolves.toMatchObject({ challenge: "registration-challenge" });
    const completed = await service.completeRegistration(
      "invitation",
      registrationResponse,
    );
    expect(completed).toMatchObject({ role: "user" });
    await expect(
      service.beginInvitation(invitation.token, "Second use"),
    ).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("adds a second passkey only to the authenticated user", async () => {
    await service.beginBootstrap(
      "bootstrap-secret-that-is-at-least-32-characters",
      "Admin",
    );
    const administrator = await service.completeRegistration(
      "bootstrap",
      registrationResponse,
    );
    const options = await service.beginAdditionalPasskey(administrator.userId);
    expect(options.excludeCredentials).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: credentialId })]),
    );
    const secondCredentialId =
      Buffer.from("second-credential").toString("base64url");
    const secondResponse = {
      ...registrationResponse,
      id: secondCredentialId,
      rawId: secondCredentialId,
    };

    await service.completeAdditionalPasskey(
      administrator.userId,
      secondResponse,
    );
    await expect(
      repository.findPasskey(secondCredentialId),
    ).resolves.toMatchObject({ userId: administrator.userId });
  });
});
