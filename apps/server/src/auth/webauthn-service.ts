import { randomBytes } from "node:crypto";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

import {
  AuthenticationConflictError,
  AuthenticationError,
  type AuthenticationRepository,
  type ChallengeContext,
  type CreatedSession,
} from "./repository.js";
import { hashSecret, secretMatchesHash } from "./secrets.js";

const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;

export interface WebAuthnServiceConfiguration {
  bootstrapSecret?: string;
  openRegistration?: boolean;
  origin: string;
  rpId: string;
}

export interface CompletedSignIn extends CreatedSession {
  recoveryCodes?: string[];
  role: "admin" | "user";
  userId: string;
}

export interface WebAuthnImplementation {
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
}

const defaultImplementation: WebAuthnImplementation = {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
};

export class WebAuthnService {
  constructor(
    private readonly repository: AuthenticationRepository,
    private readonly configuration: WebAuthnServiceConfiguration,
    private readonly implementation: WebAuthnImplementation = defaultImplementation,
  ) {}

  async beginBootstrap(
    secret: string,
    displayName: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const configuredSecret = this.configuration.bootstrapSecret;
    if (
      !configuredSecret ||
      !secretMatchesHash(secret, hashSecret(configuredSecret))
    ) {
      throw new AuthenticationError();
    }
    if ((await this.repository.countUsers()) !== 0) {
      throw new AuthenticationConflictError(
        "Bootstrap has already been completed.",
      );
    }
    return this.#beginRegistration("bootstrap", displayName, null);
  }

  async beginInvitation(
    invitationToken: string,
    displayName: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const invitation =
      await this.repository.findValidInvitation(invitationToken);
    return this.#beginRegistration("invitation", displayName, invitation.id);
  }

  async beginOpenRegistration(
    displayName: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    if (!this.configuration.openRegistration) {
      throw new AuthenticationError("Open registration is disabled.");
    }
    // Reuses the invitation ceremony with no invitation attached; the
    // repository only accepts that shape when open registration is allowed.
    return this.#beginRegistration("invitation", displayName, null);
  }

  async #verifyRegistrationWithChallenge(
    ceremony: "add_credential" | "bootstrap" | "invitation",
    response: RegistrationResponseJSON,
    requireUserId?: string,
  ): Promise<{
    context: ChallengeContext;
    info: NonNullable<
      Awaited<ReturnType<typeof verifyRegistrationResponse>>["registrationInfo"]
    >;
  }> {
    let challengeContext: ChallengeContext | undefined;
    let verification;
    try {
      verification = await this.implementation.verifyRegistrationResponse({
        expectedChallenge: async (challenge) => {
          try {
            const context = await this.repository.findValidChallenge(
              ceremony,
              challenge,
            );
            if (
              requireUserId !== undefined &&
              context.userId !== requireUserId
            ) {
              return false;
            }
            challengeContext = context;
            return true;
          } catch {
            return false;
          }
        },
        expectedOrigin: this.configuration.origin,
        expectedRPID: this.configuration.rpId,
        requireUserVerification: true,
        response,
      });
    } catch {
      throw new AuthenticationError();
    }
    if (!verification.verified || !challengeContext) {
      throw new AuthenticationError();
    }
    return { context: challengeContext, info: verification.registrationInfo };
  }

  #toNewPasskey(
    info: NonNullable<
      Awaited<ReturnType<typeof verifyRegistrationResponse>>["registrationInfo"]
    >,
    response: RegistrationResponseJSON,
  ) {
    return {
      backedUp: info.credentialBackedUp,
      counter: info.credential.counter,
      credentialId: info.credential.id,
      deviceType: info.credentialDeviceType,
      publicKey: info.credential.publicKey,
      transports: response.response.transports ?? [],
    };
  }

  async completeRegistration(
    ceremony: "bootstrap" | "invitation",
    response: RegistrationResponseJSON,
    options: { allowOpenRegistration?: boolean } = {},
  ): Promise<CompletedSignIn> {
    if (options.allowOpenRegistration && !this.configuration.openRegistration) {
      throw new AuthenticationError("Open registration is disabled.");
    }
    const { context, info } = await this.#verifyRegistrationWithChallenge(
      ceremony,
      response,
    );
    const completed = await this.repository.completeRegistration(
      context.id,
      ceremony,
      this.#toNewPasskey(info, response),
      { allowOpenRegistration: options.allowOpenRegistration ?? false },
    );
    const session = await this.repository.createSession(
      completed.userId,
      SESSION_LIFETIME_SECONDS,
    );
    return {
      ...session,
      recoveryCodes: completed.recoveryCodes,
      role: completed.role,
      userId: completed.userId,
    };
  }

  async beginAuthentication(): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await this.implementation.generateAuthenticationOptions({
      rpID: this.configuration.rpId,
      userVerification: "required",
    });
    await this.repository.saveChallenge({
      ceremony: "authenticate",
      challenge: options.challenge,
    });
    return options;
  }

  async beginAdditionalPasskey(
    userId: string,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const user = await this.repository.getPasskeyRegistrationUser(userId);
    const options = await this.implementation.generateRegistrationOptions({
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      excludeCredentials: user.passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports as AuthenticatorTransportFuture[],
      })),
      rpID: this.configuration.rpId,
      rpName: "YAAPS",
      userDisplayName: user.displayName,
      userID: new Uint8Array(user.webauthnUserId),
      userName: user.displayName,
    });
    await this.repository.saveChallenge({
      ceremony: "add_credential",
      challenge: options.challenge,
      userId,
    });
    return options;
  }

  async completeAdditionalPasskey(
    userId: string,
    response: RegistrationResponseJSON,
  ): Promise<void> {
    const { context, info } = await this.#verifyRegistrationWithChallenge(
      "add_credential",
      response,
      userId,
    );
    await this.repository.completeAdditionalPasskey(
      context.id,
      userId,
      this.#toNewPasskey(info, response),
    );
  }

  async completeAuthentication(
    response: AuthenticationResponseJSON,
  ): Promise<CompletedSignIn> {
    const passkey = await this.repository.findPasskey(response.id);
    if (!passkey) {
      throw new AuthenticationError();
    }
    let challengeContext: ChallengeContext | undefined;
    let verification;
    try {
      verification = await this.implementation.verifyAuthenticationResponse({
        credential: {
          counter: passkey.counter,
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          transports: passkey.transports as AuthenticatorTransportFuture[],
        },
        expectedChallenge: async (challenge) => {
          try {
            challengeContext = await this.repository.findValidChallenge(
              "authenticate",
              challenge,
            );
            return true;
          } catch {
            return false;
          }
        },
        expectedOrigin: this.configuration.origin,
        expectedRPID: this.configuration.rpId,
        requireUserVerification: true,
        response,
      });
    } catch {
      throw new AuthenticationError();
    }
    if (!verification.verified || !challengeContext) {
      throw new AuthenticationError();
    }
    const principal = await this.repository.completeAuthentication({
      challengeId: challengeContext.id,
      credentialId: passkey.credentialId,
      newCounter: verification.authenticationInfo.newCounter,
    });
    const session = await this.repository.createSession(
      principal.userId,
      SESSION_LIFETIME_SECONDS,
    );
    return { ...session, ...principal };
  }

  async recover(code: string): Promise<CompletedSignIn> {
    const principal = await this.repository.consumeRecoveryCode(code);
    const session = await this.repository.createSession(
      principal.userId,
      SESSION_LIFETIME_SECONDS,
    );
    return { ...session, ...principal };
  }

  async #beginRegistration(
    ceremony: "bootstrap" | "invitation",
    rawDisplayName: string,
    invitationId: string | null,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const displayName = rawDisplayName.trim();
    if (displayName.length < 1 || displayName.length > 100) {
      throw new AuthenticationError("The display name is invalid.");
    }
    const webauthnUserId = randomBytes(32);
    const options = await this.implementation.generateRegistrationOptions({
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      rpID: this.configuration.rpId,
      rpName: "YAAPS",
      userDisplayName: displayName,
      userID: webauthnUserId,
      userName: displayName,
    });
    await this.repository.saveChallenge({
      ceremony,
      challenge: options.challenge,
      invitationId,
      pendingDisplayName: displayName,
      pendingWebauthnUserId: webauthnUserId,
    });
    return options;
  }
}
