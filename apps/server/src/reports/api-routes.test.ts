import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  categoryListResponseSchema,
  DOCUMENT_LIMITS,
  draftListResponseSchema,
  draftSummarySchema,
  draftVersionListResponseSchema,
  publishDraftResponseSchema,
} from "@yaaps/contracts";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app.js";

let application: FastifyInstance;
let directory: string;

function html(body: string): Buffer {
  return Buffer.from(
    `<!doctype html><html><head><title>Report</title></head><body>${body}</body></html>`,
  );
}

async function identity(displayName: string): Promise<{
  authorization: string;
  keyId: string;
  userId: string;
}> {
  const userId = await application.yaapsData!.authentication.createUser({
    displayName,
    role: "user",
  });
  const key = await application.yaapsData!.authentication.createApiKey(
    userId,
    `${displayName} agent`,
  );
  return {
    authorization: `Bearer ${key.key}`,
    keyId: key.id,
    userId,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "yaaps-report-api-test-"));
  application = await buildApplication({
    dataDirectory: directory,
    publicOrigin: "https://share.example.test/",
  });
});

afterEach(async () => {
  await application.close();
  await rm(directory, { force: true, recursive: true });
});

describe("agent report API", () => {
  it("completes an authenticated list request", async () => {
    const actor = await identity("Minimal owner");
    const response = await application.inject({
      headers: { authorization: actor.authorization },
      method: "GET",
      url: "/api/drafts",
    });

    expect(response.statusCode).toBe(200);
  });

  it("completes an authenticated HTML upload", async () => {
    const actor = await identity("Minimal uploader");
    const response = await application.inject({
      headers: {
        authorization: actor.authorization,
        "content-type": "text/html",
      },
      method: "POST",
      payload: html("<p>Minimal upload</p>"),
      url: "/api/drafts",
    });

    expect(response.statusCode).toBe(201);
  });

  it("publishes, versions, lists, and inspects only authenticated owner data", async () => {
    const actor = await identity("Owner");
    const created = await application.inject({
      headers: {
        authorization: actor.authorization,
        "content-type": "text/html; charset=utf-8",
      },
      method: "POST",
      payload: html("<h1>First version</h1>"),
      url: "/api/drafts?title=Quarterly%20report&ttlSeconds=3600",
    });

    expect(created.statusCode).toBe(201);
    const first = publishDraftResponseSchema.parse(created.json());
    expect(first.draft).toMatchObject({
      latestVersionNumber: 1,
      status: "enabled",
      title: "Quarterly report",
    });
    expect(first.draft.publicUrl).toBe(
      `https://share.example.test/d/${first.draft.id}`,
    );
    expect(first.version.publicUrl).toBe(`${first.draft.publicUrl}/v/1`);

    const updated = await application.inject({
      headers: {
        authorization: actor.authorization,
        "content-type": "text/html",
      },
      method: "POST",
      payload: html("<h1>Second version</h1>"),
      url: `/api/drafts/${first.draft.id}/versions?ttlSeconds=7200`,
    });
    expect(updated.statusCode).toBe(201);
    const second = publishDraftResponseSchema.parse(updated.json());
    expect(second.version.versionNumber).toBe(2);
    expect(Date.parse(second.draft.expiresAt)).toBeGreaterThan(
      Date.parse(first.draft.expiresAt),
    );

    const listed = await application.inject({
      headers: { authorization: actor.authorization },
      method: "GET",
      url: "/api/drafts?limit=10&offset=0",
    });
    expect(draftListResponseSchema.parse(listed.json())).toMatchObject({
      items: [{ id: first.draft.id, latestVersionNumber: 2 }],
      limit: 10,
      offset: 0,
      total: 1,
    });

    const inspected = await application.inject({
      headers: { authorization: actor.authorization },
      method: "GET",
      url: `/api/drafts/${first.draft.id}`,
    });
    expect(draftSummarySchema.parse(inspected.json()).id).toBe(first.draft.id);

    const versions = await application.inject({
      headers: { authorization: actor.authorization },
      method: "GET",
      url: `/api/drafts/${first.draft.id}/versions?limit=1&offset=0`,
    });
    expect(draftVersionListResponseSchema.parse(versions.json())).toMatchObject(
      {
        items: [{ versionNumber: 2 }],
        limit: 1,
        offset: 0,
        total: 2,
      },
    );

    const publicLatest = await application.inject({
      method: "GET",
      url: `/d/${first.draft.id}`,
    });
    expect(publicLatest.body).toContain("Second version");

    const auditActions = (
      await application
        .yaapsData!.database.connection.selectFrom("audit_events")
        .select(["action", "actor_api_key_id", "actor_user_id"])
        .where("target_id", "=", first.draft.id)
        .orderBy("id")
        .execute()
    ).map((event) => event.action);
    expect(auditActions).toEqual(["draft.created", "draft.version_created"]);
  });

  it("returns the same not-found boundary for every cross-owner operation", async () => {
    const owner = await identity("First owner");
    const other = await identity("Second owner");
    const created = await application.inject({
      headers: {
        authorization: owner.authorization,
        "content-type": "text/html",
      },
      method: "POST",
      payload: html("<p>Owner-only report</p>"),
      url: "/api/drafts",
    });
    const draftId = publishDraftResponseSchema.parse(created.json()).draft.id;
    const blobsBefore = await application.yaapsData!.blobs.listKeys();

    const attempts = await Promise.all([
      application.inject({
        headers: { authorization: other.authorization },
        method: "GET",
        url: `/api/drafts/${draftId}`,
      }),
      application.inject({
        headers: { authorization: other.authorization },
        method: "GET",
        url: `/api/drafts/${draftId}/versions`,
      }),
      application.inject({
        headers: {
          authorization: other.authorization,
          "content-type": "text/html",
        },
        method: "POST",
        payload: html("<p>Unauthorized version</p>"),
        url: `/api/drafts/${draftId}/versions`,
      }),
      application.inject({
        headers: { authorization: other.authorization },
        method: "PATCH",
        payload: { status: "disabled" },
        url: `/api/drafts/${draftId}`,
      }),
      application.inject({
        headers: { authorization: other.authorization },
        method: "DELETE",
        url: `/api/drafts/${draftId}`,
      }),
    ]);

    for (const attempt of attempts) {
      expect(attempt.statusCode).toBe(404);
      expect(attempt.json()).toEqual({
        error: {
          code: "DRAFT_NOT_FOUND",
          message: "The draft was not found.",
        },
      });
    }
    expect(await application.yaapsData!.blobs.listKeys()).toEqual(blobsBefore);
    expect(
      await application.yaapsData!.drafts.findForOwner(owner.userId, draftId),
    ).toBeDefined();
  });

  it("publishes, filters, aggregates, and clears draft categories", async () => {
    const actor = await identity("Category owner");
    const publish = async (category: string | undefined, body: string) => {
      const response = await application.inject({
        headers: {
          authorization: actor.authorization,
          "content-type": "text/html",
        },
        method: "POST",
        payload: html(body),
        url:
          category === undefined
            ? "/api/drafts"
            : `/api/drafts?category=${encodeURIComponent(category)}`,
      });
      expect(response.statusCode).toBe(201);
      return publishDraftResponseSchema.parse(response.json()).draft;
    };

    const operations = await publish("Operations", "<p>ops</p>");
    const alsoOperations = await publish("Operations", "<p>more ops</p>");
    const uncategorized = await publish(undefined, "<p>no category</p>");
    expect(operations.category).toBe("Operations");
    expect(uncategorized.category).toBe(null);

    const versioned = await application.inject({
      headers: {
        authorization: actor.authorization,
        "content-type": "text/html",
      },
      method: "POST",
      payload: html("<p>promoted</p>"),
      url: `/api/drafts/${uncategorized.id}/versions?category=Reviews`,
    });
    expect(versioned.statusCode).toBe(201);
    expect(
      publishDraftResponseSchema.parse(versioned.json()).draft.category,
    ).toBe("Reviews");

    const filtered = await application.inject({
      headers: { authorization: actor.authorization },
      method: "GET",
      url: "/api/drafts?category=Operations",
    });
    const filteredList = draftListResponseSchema.parse(filtered.json());
    expect(filteredList.total).toBe(2);
    expect(filteredList.items.map((draft) => draft.id).sort()).toEqual(
      [operations.id, alsoOperations.id].sort(),
    );

    const categories = await application.inject({
      headers: { authorization: actor.authorization },
      method: "GET",
      url: "/api/categories",
    });
    expect(categories.statusCode).toBe(200);
    expect(categoryListResponseSchema.parse(categories.json())).toEqual({
      items: [
        { category: "Operations", draftCount: 2 },
        { category: "Reviews", draftCount: 1 },
      ],
    });

    const recategorized = await application.inject({
      headers: { authorization: actor.authorization },
      method: "PATCH",
      payload: { category: "Archive" },
      url: `/api/drafts/${operations.id}`,
    });
    expect(draftSummarySchema.parse(recategorized.json()).category).toBe(
      "Archive",
    );

    const cleared = await application.inject({
      headers: { authorization: actor.authorization },
      method: "PATCH",
      payload: { category: null },
      url: `/api/drafts/${operations.id}`,
    });
    expect(draftSummarySchema.parse(cleared.json()).category).toBe(null);

    const afterClearing = await application.inject({
      headers: { authorization: actor.authorization },
      method: "GET",
      url: "/api/categories",
    });
    expect(
      categoryListResponseSchema
        .parse(afterClearing.json())
        .items.map((entry) => entry.category),
    ).toEqual(["Operations", "Reviews"]);

    const publicResponse = await application.inject({
      method: "GET",
      url: `/d/${alsoOperations.id}`,
    });
    expect(publicResponse.statusCode).toBe(200);
    expect(publicResponse.body).not.toContain("Operations");
  });

  it("keeps categories, filters, and aggregates inside the owner boundary", async () => {
    const owner = await identity("Category first owner");
    const other = await identity("Category second owner");
    const created = await application.inject({
      headers: {
        authorization: owner.authorization,
        "content-type": "text/html",
      },
      method: "POST",
      payload: html("<p>owner report</p>"),
      url: "/api/drafts?category=Confidential",
    });
    const ownerDraft = publishDraftResponseSchema.parse(created.json()).draft;
    await application.inject({
      headers: {
        authorization: other.authorization,
        "content-type": "text/html",
      },
      method: "POST",
      payload: html("<p>other report</p>"),
      url: "/api/drafts?category=Public",
    });

    const foreignFilter = await application.inject({
      headers: { authorization: other.authorization },
      method: "GET",
      url: "/api/drafts?category=Confidential",
    });
    expect(draftListResponseSchema.parse(foreignFilter.json())).toMatchObject({
      items: [],
      total: 0,
    });

    const foreignCategories = await application.inject({
      headers: { authorization: other.authorization },
      method: "GET",
      url: "/api/categories",
    });
    expect(categoryListResponseSchema.parse(foreignCategories.json())).toEqual({
      items: [{ category: "Public", draftCount: 1 }],
    });

    const foreignPatch = await application.inject({
      headers: { authorization: other.authorization },
      method: "PATCH",
      payload: { category: "Stolen" },
      url: `/api/drafts/${ownerDraft.id}`,
    });
    expect(foreignPatch.statusCode).toBe(404);
    expect(
      (
        await application.yaapsData!.drafts.findForOwner(
          owner.userId,
          ownerDraft.id,
        )
      )?.category,
    ).toBe("Confidential");

    const anonymousCategories = await application.inject({
      method: "GET",
      url: "/api/categories",
    });
    expect(anonymousCategories.statusCode).toBe(401);
  });

  it("disables, re-enables, and deletes without leaving report blobs", async () => {
    const actor = await identity("Owner");
    const created = await application.inject({
      headers: {
        authorization: actor.authorization,
        "content-type": "text/html",
      },
      method: "POST",
      payload: html("<p>Lifecycle report</p>"),
      url: "/api/drafts",
    });
    const draftId = publishDraftResponseSchema.parse(created.json()).draft.id;

    const disabled = await application.inject({
      headers: { authorization: actor.authorization },
      method: "PATCH",
      payload: { status: "disabled", title: null },
      url: `/api/drafts/${draftId}`,
    });
    expect(draftSummarySchema.parse(disabled.json())).toMatchObject({
      status: "disabled",
      title: null,
    });
    expect(
      (await application.inject({ method: "GET", url: `/d/${draftId}` }))
        .statusCode,
    ).toBe(404);

    const enabled = await application.inject({
      headers: { authorization: actor.authorization },
      method: "PATCH",
      payload: { status: "enabled" },
      url: `/api/drafts/${draftId}`,
    });
    expect(draftSummarySchema.parse(enabled.json()).status).toBe("enabled");

    const deleted = await application.inject({
      headers: { authorization: actor.authorization },
      method: "DELETE",
      url: `/api/drafts/${draftId}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(await application.yaapsData!.blobs.listKeys()).toEqual([]);
    expect(
      (await application.inject({ method: "GET", url: `/d/${draftId}` }))
        .statusCode,
    ).toBe(404);
  });

  it("rejects missing credentials, unsafe HTML, unsupported media, TTLs, and oversized bodies", async () => {
    const actor = await identity("Owner");
    const missingAuthentication = await application.inject({
      headers: { "content-type": "text/html" },
      method: "POST",
      payload: html("<p>Must not be parsed</p>"),
      url: "/api/drafts",
    });
    expect(missingAuthentication.statusCode).toBe(401);

    const unsafe = await application.inject({
      headers: {
        authorization: actor.authorization,
        "content-type": "text/html",
      },
      method: "POST",
      payload: html("<script>alert(1)</script>"),
      url: "/api/drafts",
    });
    expect(unsafe.statusCode).toBe(400);
    expect(unsafe.json().error.code).toBe("HTML_POLICY_VIOLATION");

    const unsupported = await application.inject({
      headers: {
        authorization: actor.authorization,
        "content-type": "application/json",
      },
      method: "POST",
      payload: { html: "<p>wrong transport</p>" },
      url: "/api/drafts",
    });
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json().error.code).toBe("UNSUPPORTED_MEDIA_TYPE");

    const invalidTtl = await application.inject({
      headers: {
        authorization: actor.authorization,
        "content-type": "text/html",
      },
      method: "POST",
      payload: html("<p>TTL</p>"),
      url: "/api/drafts?ttlSeconds=30",
    });
    expect(invalidTtl.statusCode).toBe(400);
    expect(invalidTtl.json().error.code).toBe("INVALID_TTL");

    const oversized = await application.inject({
      headers: {
        authorization: actor.authorization,
        "content-type": "text/html",
      },
      method: "POST",
      payload: Buffer.alloc(DOCUMENT_LIMITS.maximumHtmlBytes + 1, 0x20),
      url: "/api/drafts",
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json().error.code).toBe("HTML_TOO_LARGE");

    for (const category of ["", "%20%20", "a".repeat(101), "Two%0Alines"]) {
      const invalidCategory = await application.inject({
        headers: {
          authorization: actor.authorization,
          "content-type": "text/html",
        },
        method: "POST",
        payload: html("<p>Category</p>"),
        url: `/api/drafts?category=${category}`,
      });
      expect(invalidCategory.statusCode).toBe(400);
      expect(invalidCategory.json().error.code).toBe("INVALID_REQUEST");

      const invalidFilter = await application.inject({
        headers: { authorization: actor.authorization },
        method: "GET",
        url: `/api/drafts?category=${category}`,
      });
      expect(invalidFilter.statusCode).toBe(400);
      expect(invalidFilter.json().error.code).toBe("INVALID_REQUEST");
    }

    expect(
      await application
        .yaapsData!.database.connection.selectFrom("drafts")
        .selectAll()
        .execute(),
    ).toEqual([]);
    expect(await application.yaapsData!.blobs.listKeys()).toEqual([]);
  });
});
