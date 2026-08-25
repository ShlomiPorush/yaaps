import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-routes-test-"));
  temporaryPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

function responseCookies(response: LightMyRequestResponse): {
  header: string;
  values: Record<string, string>;
} {
  const raw = response.headers["set-cookie"];
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const values: Record<string, string> = {};
  for (const entry of entries) {
    const [pair] = entry.split(";", 1);
    const separator = pair?.indexOf("=") ?? -1;
    if (pair && separator > 0) {
      values[pair.slice(0, separator)] = pair.slice(separator + 1);
    }
  }
  return { header: entries.join("\n"), values };
}

function cookieHeader(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

describe("authentication HTTP boundary", () => {
  it("rate limits unauthenticated device creation and polling endpoints", async () => {
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory(),
    });

    let createResponse: LightMyRequestResponse | undefined;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      createResponse = await application.inject({
        method: "POST",
        payload: {},
        url: "/auth/device-connections",
      });
    }
    expect(createResponse?.statusCode).toBe(429);

    let pollResponse: LightMyRequestResponse | undefined;
    for (let attempt = 0; attempt < 31; attempt += 1) {
      pollResponse = await application.inject({
        method: "POST",
        payload: { deviceSecret: `yad_${"x".repeat(43)}` },
        url: "/auth/device-connections/token",
      });
    }
    expect(pollResponse?.statusCode).toBe(429);
    await application.close();
  });

  it("rate limits recovery-code sign-in to five attempts per window", async () => {
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory(),
    });

    let recoveryResponse: LightMyRequestResponse | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      recoveryResponse = await application.inject({
        method: "POST",
        payload: { code: `yar_${"x".repeat(27)}` },
        url: "/auth/recovery",
      });
    }
    expect(recoveryResponse?.statusCode).toBe(429);
    await application.close();
  });

  it("gates open registration behind the configuration flag", async () => {
    const closed = await buildApplication({
      dataDirectory: await temporaryDirectory(),
    });
    const closedState = await closed.inject({
      method: "GET",
      url: "/auth/state",
    });
    expect(closedState.json()).toMatchObject({ openRegistration: false });
    const denied = await closed.inject({
      method: "POST",
      payload: { displayName: "Visitor" },
      url: "/auth/register/options",
    });
    expect(denied.statusCode).toBe(401);
    await closed.close();

    const open = await buildApplication({
      authentication: {
        openRegistration: true,
        origin: "https://share.example.com",
        rpId: "share.example.com",
        secureCookies: true,
      },
      dataDirectory: await temporaryDirectory(),
    });
    const openState = await open.inject({ method: "GET", url: "/auth/state" });
    expect(openState.json()).toMatchObject({ openRegistration: true });
    const allowed = await open.inject({
      method: "POST",
      payload: { displayName: "Visitor" },
      url: "/auth/register/options",
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      rp: { id: "share.example.com", name: "YAAPS" },
    });
    await open.close();
  });

  it("regenerates recovery codes and invalidates the unused old ones", async () => {
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory(),
    });
    const repository = application.yaapsData!.authentication;
    const userId = await repository.createUser({
      displayName: "Owner",
      role: "user",
    });
    const [oldCode, unusedOldCode] = await repository.createRecoveryCodes(
      userId,
      2,
    );
    const signedIn = await application.inject({
      method: "POST",
      payload: { code: oldCode },
      url: "/auth/recovery",
    });
    expect(signedIn.statusCode).toBe(200);
    const cookies = responseCookies(signedIn);
    const browserCookies = cookieHeader(cookies.values);
    const csrfToken = cookies.values["yaaps_csrf"]!;

    const regenerated = await application.inject({
      headers: { cookie: browserCookies, "x-csrf-token": csrfToken },
      method: "POST",
      url: "/auth/recovery-codes",
    });
    expect(regenerated.statusCode).toBe(200);
    const newCodes = regenerated.json().recoveryCodes as string[];
    expect(newCodes).toHaveLength(8);

    // The unused old code must stop working; a freshly issued one must work.
    const staleSignIn = await application.inject({
      method: "POST",
      payload: { code: unusedOldCode },
      url: "/auth/recovery",
    });
    expect(staleSignIn.statusCode).toBe(401);
    const newSignIn = await application.inject({
      method: "POST",
      payload: { code: newCodes[0] },
      url: "/auth/recovery",
    });
    expect(newSignIn.statusCode).toBe(200);
    await application.close();
  });

  it("protects one-time bootstrap options with the configured secret", async () => {
    const application = await buildApplication({
      authentication: {
        bootstrapSecret: "bootstrap-secret-that-is-at-least-32-characters",
        origin: "https://share.yaaps.net",
        rpId: "share.yaaps.net",
        secureCookies: true,
      },
      dataDirectory: await temporaryDirectory(),
    });

    const denied = await application.inject({
      method: "POST",
      payload: { displayName: "Admin", secret: "wrong" },
      url: "/auth/bootstrap/options",
    });
    const allowed = await application.inject({
      method: "POST",
      payload: {
        displayName: "Admin",
        secret: "bootstrap-secret-that-is-at-least-32-characters",
      },
      url: "/auth/bootstrap/options",
    });

    expect(denied.statusCode).toBe(401);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      rp: { id: "share.yaaps.net", name: "YAAPS" },
    });
    await application.close();
  });

  it("uses hardened session cookies and requires CSRF for state changes", async () => {
    const application = await buildApplication({
      authentication: {
        origin: "https://share.yaaps.net",
        rpId: "share.yaaps.net",
        secureCookies: true,
      },
      dataDirectory: await temporaryDirectory(),
    });
    const repository = application.yaapsData!.authentication;
    const userId = await repository.createUser({
      displayName: "Admin",
      role: "admin",
    });
    const [recoveryCode] = await repository.createRecoveryCodes(userId, 1);
    const recovered = await application.inject({
      method: "POST",
      payload: { code: recoveryCode },
      url: "/auth/recovery",
    });
    const cookies = responseCookies(recovered);
    const browserCookies = cookieHeader(cookies.values);

    expect(recovered.statusCode).toBe(200);
    expect(cookies.header).toContain("__Host-yaaps-session=");
    expect(cookies.header).toContain("HttpOnly");
    expect(cookies.header).toContain("SameSite=Strict");
    expect(cookies.header).toContain("Secure");

    const missingCsrf = await application.inject({
      headers: { cookie: browserCookies },
      method: "POST",
      payload: { label: "Agent" },
      url: "/auth/api-keys",
    });
    expect(missingCsrf.statusCode).toBe(403);

    const csrfToken = cookies.values["__Host-yaaps-csrf"]!;
    const createdKey = await application.inject({
      headers: { cookie: browserCookies, "x-csrf-token": csrfToken },
      method: "POST",
      payload: { label: "Agent" },
      url: "/auth/api-keys",
    });
    expect(createdKey.statusCode).toBe(200);
    expect(createdKey.json().key).toMatch(/^yaaps_/);

    const listedKeys = await application.inject({
      headers: { cookie: browserCookies },
      method: "GET",
      url: "/auth/api-keys",
    });
    expect(listedKeys.statusCode).toBe(200);
    expect(listedKeys.json()).toEqual({
      items: [
        expect.objectContaining({
          id: createdKey.json().id,
          label: "Agent",
          prefix: createdKey.json().prefix,
        }),
      ],
    });
    expect(JSON.stringify(listedKeys.json())).not.toContain(
      createdKey.json().key,
    );

    const signOut = await application.inject({
      headers: { cookie: browserCookies, "x-csrf-token": csrfToken },
      method: "POST",
      url: "/auth/sign-out",
    });
    expect(signOut.statusCode).toBe(204);
    const expiredSession = await application.inject({
      headers: { cookie: browserCookies },
      method: "GET",
      url: "/auth/session",
    });
    expect(expiredSession.statusCode).toBe(401);
    await application.close();
  });

  it("does not allow one browser user to revoke another user's API key", async () => {
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory(),
    });
    const repository = application.yaapsData!.authentication;
    const firstUser = await repository.createUser({
      displayName: "First",
      role: "user",
    });
    const secondUser = await repository.createUser({
      displayName: "Second",
      role: "user",
    });
    const [firstCode] = await repository.createRecoveryCodes(firstUser, 1);
    const [secondCode] = await repository.createRecoveryCodes(secondUser, 1);
    const firstRecovery = await application.inject({
      method: "POST",
      payload: { code: firstCode },
      url: "/auth/recovery",
    });
    const secondRecovery = await application.inject({
      method: "POST",
      payload: { code: secondCode },
      url: "/auth/recovery",
    });
    const firstCookies = responseCookies(firstRecovery).values;
    const secondCookies = responseCookies(secondRecovery).values;
    const createdKey = await application.inject({
      headers: {
        cookie: cookieHeader(firstCookies),
        "x-csrf-token": firstCookies.yaaps_csrf!,
      },
      method: "POST",
      payload: { label: "First key" },
      url: "/auth/api-keys",
    });

    const crossUserDelete = await application.inject({
      headers: {
        cookie: cookieHeader(secondCookies),
        "x-csrf-token": secondCookies.yaaps_csrf!,
      },
      method: "DELETE",
      url: `/auth/api-keys/${createdKey.json().id}`,
    });
    expect(crossUserDelete.statusCode).toBe(403);
    await expect(
      repository.authenticateApiKey(createdKey.json().key as string),
    ).resolves.toMatchObject({ userId: firstUser });
    await application.close();
  });

  it("authorizes a client-generated API key without exposing its plaintext to the server", async () => {
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory(),
      publicOrigin: "https://share.yaaps.net",
    });
    const authentication = application.yaapsData!.authentication;
    const userId = await authentication.createUser({
      displayName: "Approver",
      role: "user",
    });
    const [recoveryCode] = await authentication.createRecoveryCodes(userId, 1);
    const recovered = await application.inject({
      method: "POST",
      payload: { code: recoveryCode },
      url: "/auth/recovery",
    });
    const cookies = responseCookies(recovered).values;
    const browserCookies = cookieHeader(cookies);

    const secret = randomBytes(32).toString("base64url");
    const keyPrefix = `yaaps_${secret.slice(0, 10)}`;
    const apiKey = `${keyPrefix}_${secret}`;
    const keyHash = createHash("sha256").update(apiKey).digest("hex");
    const started = await application.inject({
      method: "POST",
      payload: { keyHash, keyPrefix, label: "Provider-neutral agent" },
      url: "/auth/device-connections",
    });

    expect(started.statusCode).toBe(201);
    expect(started.body).not.toContain(apiKey);
    expect(started.json()).toMatchObject({
      intervalSeconds: 2,
      verificationUrl: "https://share.yaaps.net/dashboard/connect/approve",
    });
    expect(started.json().verificationUrlComplete).toBe(
      `https://share.yaaps.net/dashboard/connect/approve?code=${encodeURIComponent(started.json().userCode as string)}`,
    );
    const storedPending = await application
      .yaapsData!.database.connection.selectFrom("device_connections")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(storedPending.key_hash).toBe(keyHash);
    expect(storedPending.device_secret_hash).not.toBe(
      started.json().deviceSecret,
    );
    expect(JSON.stringify(storedPending)).not.toContain(apiKey);

    const invalidPollingSecret = `yad_${"z".repeat(43)}`;
    const invalidPoll = await application.inject({
      method: "POST",
      payload: { deviceSecret: invalidPollingSecret },
      url: "/auth/device-connections/token",
    });
    expect(invalidPoll.statusCode).toBe(404);
    expect(invalidPoll.body).not.toContain(invalidPollingSecret);

    const unauthenticatedInspection = await application.inject({
      method: "POST",
      payload: { userCode: started.json().userCode },
      url: "/auth/device-connections/lookup",
    });
    expect(unauthenticatedInspection.statusCode).toBe(401);
    for (const decision of ["approve", "deny"] as const) {
      const unauthenticatedDecision = await application.inject({
        method: "POST",
        payload: { userCode: started.json().userCode },
        url: `/auth/device-connections/${storedPending.id}/${decision}`,
      });
      expect(unauthenticatedDecision.statusCode).toBe(401);
    }

    const inspection = await application.inject({
      headers: { cookie: browserCookies },
      method: "POST",
      payload: {
        userCode: String(started.json().userCode)
          .replace("-", "")
          .toLowerCase(),
      },
      url: "/auth/device-connections/lookup",
    });
    expect(inspection.statusCode).toBe(200);
    expect(inspection.json()).toMatchObject({
      keyPrefix,
      label: "Provider-neutral agent",
      status: "pending",
    });

    const secondSecret = randomBytes(32).toString("base64url");
    const secondPrefix = `yaaps_${secondSecret.slice(0, 10)}`;
    const secondKey = `${secondPrefix}_${secondSecret}`;
    const secondStarted = await application.inject({
      method: "POST",
      payload: {
        keyHash: createHash("sha256").update(secondKey).digest("hex"),
        keyPrefix: secondPrefix,
        label: "Other request",
      },
      url: "/auth/device-connections",
    });
    const crossedApproval = await application.inject({
      headers: {
        cookie: browserCookies,
        "x-csrf-token": cookies.yaaps_csrf!,
      },
      method: "POST",
      payload: { userCode: secondStarted.json().userCode },
      url: `/auth/device-connections/${inspection.json().id}/approve`,
    });
    expect(crossedApproval.statusCode).toBe(404);

    const missingCsrf = await application.inject({
      headers: { cookie: browserCookies },
      method: "POST",
      payload: { userCode: started.json().userCode },
      url: `/auth/device-connections/${inspection.json().id}/approve`,
    });
    expect(missingCsrf.statusCode).toBe(403);
    const missingCsrfDenial = await application.inject({
      headers: { cookie: browserCookies },
      method: "POST",
      payload: { userCode: started.json().userCode },
      url: `/auth/device-connections/${inspection.json().id}/deny`,
    });
    expect(missingCsrfDenial.statusCode).toBe(403);

    const approved = await application.inject({
      headers: {
        cookie: browserCookies,
        "x-csrf-token": cookies.yaaps_csrf!,
      },
      method: "POST",
      payload: { userCode: started.json().userCode },
      url: `/auth/device-connections/${inspection.json().id}/approve`,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.body).not.toContain(apiKey);
    expect(approved.json()).toMatchObject({
      apiKey: { label: "Provider-neutral agent", prefix: keyPrefix },
      status: "approved",
    });

    const polled = await application.inject({
      method: "POST",
      payload: { deviceSecret: started.json().deviceSecret },
      url: "/auth/device-connections/token",
    });
    expect(polled.statusCode).toBe(200);
    expect(polled.json()).toEqual({
      apiKeyId: approved.json().apiKey.id,
      status: "approved",
    });
    await expect(authentication.authenticateApiKey(apiKey)).resolves.toEqual({
      apiKeyId: approved.json().apiKey.id,
      role: "user",
      userId,
    });
    const replay = await application.inject({
      headers: {
        cookie: browserCookies,
        "x-csrf-token": cookies.yaaps_csrf!,
      },
      method: "POST",
      payload: { userCode: started.json().userCode },
      url: `/auth/device-connections/${inspection.json().id}/approve`,
    });
    expect(replay.statusCode).toBe(409);

    const audit = await application
      .yaapsData!.database.connection.selectFrom("audit_events")
      .select(["action", "actor_user_id", "metadata_json", "target_id"])
      .where("target_id", "=", approved.json().apiKey.id)
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({
      action: "api_key.created",
      actor_user_id: userId,
      metadata_json: '{"source":"device_connection"}',
    });
    await application.close();
  });
});
