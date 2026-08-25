import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  draftListResponseSchema,
  publishDraftResponseSchema,
} from "@yaaps/contracts";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApplication } from "../app.js";

const DRAFT_COUNT = 16;
const VERSION_ROUNDS = 3;
const READ_ROUNDS = 20;
let application: FastifyInstance;
let authorization: string;
let directory: string;

function html(label: string): Buffer {
  return Buffer.from(
    `<!doctype html><html><head><title>Load</title></head><body><p>${label}</p></body></html>`,
  );
}

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "yaaps-load-test-"));
  application = await buildApplication({ dataDirectory: directory });
  const userId = await application.yaapsData!.authentication.createUser({
    displayName: "Load test owner",
    role: "user",
  });
  const apiKey = await application.yaapsData!.authentication.createApiKey(
    userId,
    "Load test agent",
  );
  authorization = `Bearer ${apiKey.key}`;
});

afterAll(async () => {
  await application.close();
  await rm(directory, { force: true, recursive: true });
});

describe("bounded single-instance load", () => {
  it("preserves consistent metadata and immutable content under concurrent work", async () => {
    const creations = await Promise.all(
      Array.from({ length: DRAFT_COUNT }, async (_, index) =>
        application.inject({
          headers: { authorization, "content-type": "text/html" },
          method: "POST",
          payload: html(`draft ${index} version 1`),
          url: `/api/drafts?title=Load%20draft%20${index}`,
        }),
      ),
    );
    expect(creations.every((response) => response.statusCode === 201)).toBe(
      true,
    );
    const drafts = creations.map(
      (response) => publishDraftResponseSchema.parse(response.json()).draft,
    );

    for (let round = 2; round <= VERSION_ROUNDS + 1; round += 1) {
      const [versions, cleanup] = await Promise.all([
        Promise.all(
          drafts.map((draft, index) =>
            application.inject({
              headers: { authorization, "content-type": "text/html" },
              method: "POST",
              payload: html(`draft ${index} version ${round}`),
              url: `/api/drafts/${draft.id}/versions`,
            }),
          ),
        ),
        application.yaapsData!.drafts.cleanupExpired(new Date()),
      ]);
      expect(versions.every((response) => response.statusCode === 201)).toBe(
        true,
      );
      expect(cleanup).toEqual({ deletedDrafts: 0, reclaimedBlobs: 0 });
    }

    const reads = await Promise.all(
      Array.from({ length: READ_ROUNDS }, () =>
        Promise.all(
          drafts.map((draft) =>
            application.inject({ method: "GET", url: `/d/${draft.id}` }),
          ),
        ),
      ),
    );
    expect(reads.flat().every((response) => response.statusCode === 200)).toBe(
      true,
    );

    const listed = await application.inject({
      headers: { authorization },
      method: "GET",
      url: "/api/drafts?limit=100",
    });
    const list = draftListResponseSchema.parse(listed.json());
    expect(list.total).toBe(DRAFT_COUNT);
    expect(
      list.items.every(
        (draft) => draft.latestVersionNumber === VERSION_ROUNDS + 1,
      ),
    ).toBe(true);

    const integrity = await sql<{
      integrity_check: string;
    }>`pragma integrity_check`.execute(
      application.yaapsData!.database.connection,
    );
    expect(integrity.rows).toEqual([{ integrity_check: "ok" }]);
    const versionCount = await application
      .yaapsData!.database.connection.selectFrom("versions")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(versionCount.count)).toBe(DRAFT_COUNT * (VERSION_ROUNDS + 1));
  });
});
