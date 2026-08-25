import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  bootstrapOptionsRequestSchema,
  registerOptionsRequestSchema,
  createApiKeyRequestSchema,
  createInvitationRequestSchema,
  invitationOptionsRequestSchema,
  recoveryRequestSchema,
} from "@yaaps/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  type AuthenticatedSession,
  AuthenticationError,
  type AuthenticationRepository,
  AuthorizationError,
} from "./repository.js";
import { hashSecret, secretMatchesHash } from "./secrets.js";
import {
  type CompletedSignIn,
  type WebAuthnService,
} from "./webauthn-service.js";

const credentialSchema = z
  .object({
    clientExtensionResults: z.record(z.string(), z.unknown()),
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z.record(z.string(), z.unknown()),
    type: z.literal("public-key"),
  })
  .passthrough();

export interface AuthenticationRouteOptions {
  openRegistration?: boolean;
  repository: AuthenticationRepository;
  secureCookies: boolean;
  service: WebAuthnService;
}

function cookieNames(secure: boolean): {
  csrf: string;
  session: string;
} {
  return secure
    ? { csrf: "__Host-yaaps-csrf", session: "__Host-yaaps-session" }
    : { csrf: "yaaps_csrf", session: "yaaps_session" };
}

function setSessionCookies(
  reply: FastifyReply,
  signIn: CompletedSignIn,
  secure: boolean,
): void {
  const names = cookieNames(secure);
  const common = {
    expires: new Date(signIn.expiresAt),
    path: "/",
    sameSite: "strict" as const,
    secure,
  };
  reply.setCookie(names.session, signIn.sessionToken, {
    ...common,
    httpOnly: true,
  });
  reply.setCookie(names.csrf, signIn.csrfToken, {
    ...common,
    httpOnly: false,
  });
}

function clearSessionCookies(reply: FastifyReply, secure: boolean): void {
  const names = cookieNames(secure);
  const options = { path: "/", sameSite: "strict" as const, secure };
  reply.clearCookie(names.session, { ...options, httpOnly: true });
  reply.clearCookie(names.csrf, { ...options, httpOnly: false });
}

export async function requireBrowserSession(
  request: FastifyRequest,
  repository: AuthenticationRepository,
  secure: boolean,
): Promise<AuthenticatedSession> {
  const token = request.cookies[cookieNames(secure).session];
  if (!token) {
    throw new AuthenticationError();
  }
  return repository.authenticateSession(token);
}

export function requireBrowserCsrf(
  request: FastifyRequest,
  session: AuthenticatedSession,
  repository: AuthenticationRepository,
  secure: boolean,
): void {
  const header = request.headers["x-csrf-token"];
  const cookieValue = request.cookies[cookieNames(secure).csrf];
  if (
    typeof header !== "string" ||
    !cookieValue ||
    !secretMatchesHash(header, hashSecret(cookieValue))
  ) {
    throw new AuthorizationError();
  }
  repository.verifyCsrf(session, header);
}

function publicSession(signIn: CompletedSignIn): Record<string, unknown> {
  return {
    recoveryCodes: signIn.recoveryCodes,
    user: { id: signIn.userId, role: signIn.role },
  };
}

export async function registerAuthenticationRoutes(
  application: FastifyInstance,
  options: AuthenticationRouteOptions,
): Promise<void> {
  const limited = { rateLimit: { max: 10, timeWindow: "1 minute" } };

  const readSession = (request: FastifyRequest) =>
    requireBrowserSession(request, options.repository, options.secureCookies);
  // Every mutating browser route must pair the session check with CSRF; going
  // through this helper makes omitting the CSRF half impossible to miss.
  const mutatingSession = async (request: FastifyRequest) => {
    const actor = await readSession(request);
    requireBrowserCsrf(
      request,
      actor,
      options.repository,
      options.secureCookies,
    );
    return actor;
  };

  application.get("/auth/state", async () => ({
    initialized: (await options.repository.countUsers()) > 0,
    openRegistration: options.openRegistration ?? false,
  }));
  application.post(
    "/auth/register/options",
    { config: limited },
    async (request) => {
      const body = registerOptionsRequestSchema.parse(request.body);
      return options.service.beginOpenRegistration(body.displayName);
    },
  );
  application.post(
    "/auth/register/verify",
    { config: limited },
    async (request, reply) => {
      const response = credentialSchema.parse(
        request.body,
      ) as unknown as RegistrationResponseJSON;
      const signIn = await options.service.completeRegistration(
        "invitation",
        response,
        { allowOpenRegistration: true },
      );
      setSessionCookies(reply, signIn, options.secureCookies);
      return publicSession(signIn);
    },
  );
  application.post(
    "/auth/bootstrap/options",
    { config: limited },
    async (request) => {
      const body = bootstrapOptionsRequestSchema.parse(request.body);
      return options.service.beginBootstrap(body.secret, body.displayName);
    },
  );
  application.post(
    "/auth/bootstrap/verify",
    { config: limited },
    async (request, reply) => {
      const response = credentialSchema.parse(
        request.body,
      ) as unknown as RegistrationResponseJSON;
      const signIn = await options.service.completeRegistration(
        "bootstrap",
        response,
      );
      setSessionCookies(reply, signIn, options.secureCookies);
      return publicSession(signIn);
    },
  );
  application.post(
    "/auth/invitations/options",
    { config: limited },
    async (request) => {
      const body = invitationOptionsRequestSchema.parse(request.body);
      return options.service.beginInvitation(body.token, body.displayName);
    },
  );
  application.post(
    "/auth/invitations/verify",
    { config: limited },
    async (request, reply) => {
      const response = credentialSchema.parse(
        request.body,
      ) as unknown as RegistrationResponseJSON;
      const signIn = await options.service.completeRegistration(
        "invitation",
        response,
      );
      setSessionCookies(reply, signIn, options.secureCookies);
      return publicSession(signIn);
    },
  );
  application.post("/auth/sign-in/options", { config: limited }, async () =>
    options.service.beginAuthentication(),
  );
  application.post(
    "/auth/sign-in/verify",
    { config: limited },
    async (request, reply) => {
      const response = credentialSchema.parse(
        request.body,
      ) as unknown as AuthenticationResponseJSON;
      const signIn = await options.service.completeAuthentication(response);
      setSessionCookies(reply, signIn, options.secureCookies);
      return publicSession(signIn);
    },
  );
  application.post(
    "/auth/recovery",
    { config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      const body = recoveryRequestSchema.parse(request.body);
      const signIn = await options.service.recover(body.code);
      setSessionCookies(reply, signIn, options.secureCookies);
      return publicSession(signIn);
    },
  );
  application.get("/auth/session", async (request) => {
    const session = await readSession(request);
    return { user: { id: session.userId, role: session.role } };
  });
  application.post("/auth/sign-out", async (request, reply) => {
    const session = await mutatingSession(request);
    await options.repository.revokeSession(session.sessionIdHash);
    clearSessionCookies(reply, options.secureCookies);
    return reply.code(204).send();
  });
  application.post("/auth/api-keys", async (request) => {
    const session = await mutatingSession(request);
    const body = createApiKeyRequestSchema.parse(request.body);
    return options.repository.createApiKey(session.userId, body.label);
  });
  application.post("/auth/recovery-codes", async (request) => {
    const session = await mutatingSession(request);
    return {
      recoveryCodes: await options.repository.regenerateRecoveryCodes(
        session.userId,
      ),
    };
  });
  application.get("/auth/api-keys", async (request) => {
    const session = await readSession(request);
    return { items: await options.repository.listApiKeys(session.userId) };
  });
  application.post("/auth/passkeys/options", async (request) => {
    const session = await mutatingSession(request);
    return options.service.beginAdditionalPasskey(session.userId);
  });
  application.post("/auth/passkeys/verify", async (request, reply) => {
    const session = await mutatingSession(request);
    const response = credentialSchema.parse(
      request.body,
    ) as unknown as RegistrationResponseJSON;
    await options.service.completeAdditionalPasskey(session.userId, response);
    return reply.code(204).send();
  });
  application.delete<{ Params: { id: string } }>(
    "/auth/api-keys/:id",
    async (request, reply) => {
      const session = await mutatingSession(request);
      await options.repository.revokeApiKey(session.userId, request.params.id);
      return reply.code(204).send();
    },
  );
  application.post("/auth/invitations", async (request) => {
    const session = await mutatingSession(request);
    const body = createInvitationRequestSchema.parse(request.body);
    return options.repository.createInvitation({
      actorUserId: session.userId,
      lifetimeSeconds: body.lifetimeSeconds,
      role: body.role,
    });
  });
  application.post<{ Params: { id: string } }>(
    "/auth/users/:id/disable",
    async (request, reply) => {
      const session = await mutatingSession(request);
      await options.repository.disableUser(session.userId, request.params.id);
      return reply.code(204).send();
    },
  );
}
