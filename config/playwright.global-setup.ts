import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FullConfig } from "@playwright/test";

import { buildApplication } from "../apps/server/src/app.js";

const MAIN_ORIGIN = "http://localhost:4173";
const SECURITY_ORIGIN = "http://localhost:4174";
const SECURITY_DRAFT_ID = "S".repeat(32);

export default async function globalSetup(_config: FullConfig) {
  const mainDirectory = await mkdtemp(path.join(tmpdir(), "yaaps-e2e-main-"));
  const securityDirectory = await mkdtemp(
    path.join(tmpdir(), "yaaps-e2e-security-"),
  );
  const main = await buildApplication({
    authentication: {
      bootstrapSecret: "yaaps-playwright-bootstrap-secret-2026",
      origin: MAIN_ORIGIN,
      rpId: "localhost",
      secureCookies: false,
    },
    dashboardDirectory: path.resolve("apps/dashboard/dist"),
    dataDirectory: mainDirectory,
    publicOrigin: MAIN_ORIGIN,
  });
  const security = await buildApplication({
    dataDirectory: securityDirectory,
    publicOrigin: SECURITY_ORIGIN,
  });

  let networkProbeCount = 0;
  const unsafeFixture = Buffer.from(`<!doctype html>
<html>
  <head><title>YAAPS isolation fixture</title></head>
  <body>
    <h1>YAAPS isolation fixture</h1>
    <form action="/__e2e/network-probe" method="get">
      <button id="submit-probe" type="submit">Submit blocked form</button>
    </form>
    <img alt="Blocked network image" src="/__e2e/network-probe?source=image">
    <iframe title="Blocked network frame" src="/__e2e/network-probe?source=frame"></iframe>
    <script>
      window.yaapsUnsafeScriptRan = true;
      fetch("/__e2e/network-probe?source=fetch");
    </script>
  </body>
</html>`);
  const userId = randomUUID();
  const createdAt = new Date().toISOString();
  const blob = await security.yaapsData!.blobs.store(unsafeFixture);
  await security
    .yaapsData!.database.connection.insertInto("users")
    .values({
      created_at: createdAt,
      disabled_at: null,
      display_name: "E2E security owner",
      id: userId,
      role: "user",
      status: "active",
      webauthn_user_id: null,
    })
    .execute();
  await security
    .yaapsData!.database.connection.insertInto("drafts")
    .values({
      created_at: createdAt,
      expires_at: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      id: SECURITY_DRAFT_ID,
      latest_version_number: 1,
      owner_id: userId,
      status: "enabled",
      title: "E2E security fixture",
      updated_at: createdAt,
    })
    .execute();
  await security
    .yaapsData!.database.connection.insertInto("versions")
    .values({
      blob_key: blob.key,
      byte_length: blob.byteLength,
      created_at: createdAt,
      draft_id: SECURITY_DRAFT_ID,
      id: randomUUID(),
      sha256: blob.sha256,
      uploaded_by_api_key_id: null,
      version_number: 1,
    })
    .execute();
  security.get("/__e2e/network-probe", async () => {
    networkProbeCount += 1;
    return { reached: true };
  });
  security.get("/__e2e/probes", async () => ({ networkProbeCount }));

  try {
    await main.listen({ host: "127.0.0.1", port: 4173 });
    await security.listen({ host: "127.0.0.1", port: 4174 });
  } catch (error) {
    await Promise.allSettled([main.close(), security.close()]);
    await Promise.allSettled([
      rm(mainDirectory, { force: true, recursive: true }),
      rm(securityDirectory, { force: true, recursive: true }),
    ]);
    throw error;
  }

  return async () => {
    await Promise.all([main.close(), security.close()]);
    await Promise.all([
      rm(mainDirectory, { force: true, recursive: true }),
      rm(securityDirectory, { force: true, recursive: true }),
    ]);
  };
}
