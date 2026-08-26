import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  draftListResponseSchema,
  draftSummarySchema,
  publicErrorSchema,
} from "@yaaps/contracts";
import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-dashboard-test-"));
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

function responseCookies(
  response: LightMyRequestResponse,
): Record<string, string> {
  const raw = response.headers["set-cookie"];
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return Object.fromEntries(
    entries.map(
      (entry) => entry.split(";", 1)[0]!.split("=", 2) as [string, string],
    ),
  );
}

function browserHeaders(cookies: Record<string, string>, csrf = false) {
  return {
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join("; "),
    ...(csrf ? { "x-csrf-token": cookies.yaaps_csrf! } : {}),
  };
}

async function signIn(
  application: Awaited<ReturnType<typeof buildApplication>>,
  userId: string,
) {
  const [code] =
    await application.yaapsData!.authentication.createRecoveryCodes(userId, 1);
  return responseCookies(
    await application.inject({
      method: "POST",
      payload: { code },
      url: "/auth/recovery",
    }),
  );
}

describe("dashboard report management boundary", () => {
  it("exposes administration data and mutations only to an administrator", async () => {
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory(),
    });
    const repository = application.yaapsData!.authentication;
    const adminId = await repository.createUser({
      displayName: "Admin",
      role: "admin",
    });
    const userId = await repository.createUser({
      displayName: "Member",
      role: "user",
    });
    const adminCookies = await signIn(application, adminId);
    const userCookies = await signIn(application, userId);
    const memberDraft = await application.yaapsData!.drafts.createDraft({
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      html: Buffer.from(
        "<!doctype html><html><head><title>Member</title></head><body>Member report</body></html>",
      ),
      ownerId: userId,
      title: "Member report",
      uploadedByApiKeyId: null,
    });

    const forbidden = await application.inject({
      headers: browserHeaders(userCookies),
      method: "GET",
      url: "/dashboard/api/admin/users",
    });
    expect(forbidden.statusCode).toBe(403);

    const users = await application.inject({
      headers: browserHeaders(adminCookies),
      method: "GET",
      url: "/dashboard/api/admin/users",
    });
    expect(users.statusCode).toBe(200);
    expect(users.json()).toEqual({
      items: expect.arrayContaining([
        expect.objectContaining({ displayName: "Admin", role: "admin" }),
        expect.objectContaining({ displayName: "Member", role: "user" }),
      ]),
    });

    const adminDrafts = await application.inject({
      headers: browserHeaders(adminCookies),
      method: "GET",
      url: "/dashboard/api/admin/drafts",
    });
    expect(adminDrafts.statusCode).toBe(200);
    expect(adminDrafts.json()).toMatchObject({
      items: [
        {
          id: memberDraft.draftId,
          ownerDisplayName: "Member",
          ownerId: userId,
        },
      ],
      total: 1,
    });
    const adminDisabledDraft = await application.inject({
      headers: browserHeaders(adminCookies, true),
      method: "PATCH",
      payload: { status: "disabled" },
      url: `/dashboard/api/admin/drafts/${memberDraft.draftId}`,
    });
    expect(adminDisabledDraft.statusCode).toBe(200);
    expect(adminDisabledDraft.json().status).toBe("disabled");
    const adminDeletedDraft = await application.inject({
      headers: browserHeaders(adminCookies, true),
      method: "DELETE",
      url: `/dashboard/api/admin/drafts/${memberDraft.draftId}`,
    });
    expect(adminDeletedDraft.statusCode).toBe(204);

    const invitation = await application.inject({
      headers: browserHeaders(adminCookies, true),
      method: "POST",
      payload: { lifetimeSeconds: 3600, role: "user" },
      url: "/auth/invitations",
    });
    expect(invitation.statusCode).toBe(200);
    const invitations = await application.inject({
      headers: browserHeaders(adminCookies),
      method: "GET",
      url: "/dashboard/api/admin/invitations",
    });
    expect(invitations.json()).toEqual({
      items: [
        expect.objectContaining({
          id: invitation.json().id,
          status: "pending",
        }),
      ],
    });
    const revoked = await application.inject({
      headers: browserHeaders(adminCookies, true),
      method: "DELETE",
      url: `/dashboard/api/admin/invitations/${invitation.json().id}`,
    });
    expect(revoked.statusCode).toBe(204);

    const disabled = await application.inject({
      headers: browserHeaders(adminCookies, true),
      method: "POST",
      url: `/auth/users/${userId}/disable`,
    });
    expect(disabled.statusCode).toBe(204);
    const enabled = await application.inject({
      headers: browserHeaders(adminCookies, true),
      method: "POST",
      url: `/dashboard/api/admin/users/${userId}/enable`,
    });
    expect(enabled.statusCode).toBe(204);
    const adminDraftAudit = await application
      .yaapsData!.database.connection.selectFrom("audit_events")
      .select(["action", "actor_user_id"])
      .where("target_id", "=", memberDraft.draftId)
      .where("action", "in", ["draft.admin_updated", "draft.admin_deleted"])
      .orderBy("id")
      .execute();
    expect(adminDraftAudit).toEqual([
      { action: "draft.admin_updated", actor_user_id: adminId },
      { action: "draft.admin_deleted", actor_user_id: adminId },
    ]);
    await application.close();
  });

  it("lists, updates, and deletes only the signed-in user's drafts", async () => {
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory(),
      publicOrigin: "https://share.example.test",
    });
    const repository = application.yaapsData!.authentication;
    const ownerId = await repository.createUser({
      displayName: "Owner",
      role: "user",
    });
    const otherId = await repository.createUser({
      displayName: "Other",
      role: "user",
    });
    const ownerCookies = await signIn(application, ownerId);
    const otherCookies = await signIn(application, otherId);
    const stored = await application.yaapsData!.drafts.createDraft({
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      html: Buffer.from(
        "<!doctype html><html><head><title>Owner</title></head><body>Owner report</body></html>",
      ),
      ownerId,
      title: "Owner report",
      uploadedByApiKeyId: null,
    });

    const ownList = await application.inject({
      headers: browserHeaders(ownerCookies),
      method: "GET",
      url: "/dashboard/api/drafts",
    });
    expect(draftListResponseSchema.parse(ownList.json())).toMatchObject({
      items: [{ id: stored.draftId, title: "Owner report" }],
      total: 1,
    });

    const otherList = await application.inject({
      headers: browserHeaders(otherCookies),
      method: "GET",
      url: "/dashboard/api/drafts",
    });
    expect(draftListResponseSchema.parse(otherList.json()).items).toEqual([]);

    for (const attempt of [
      application.inject({
        headers: browserHeaders(otherCookies),
        method: "GET",
        url: `/dashboard/api/drafts/${stored.draftId}/versions`,
      }),
      application.inject({
        headers: browserHeaders(otherCookies, true),
        method: "PATCH",
        payload: { status: "disabled" },
        url: `/dashboard/api/drafts/${stored.draftId}`,
      }),
      application.inject({
        headers: browserHeaders(otherCookies, true),
        method: "DELETE",
        url: `/dashboard/api/drafts/${stored.draftId}`,
      }),
    ]) {
      const response = await attempt;
      expect(response.statusCode).toBe(404);
      expect(publicErrorSchema.parse(response.json()).error.code).toBe(
        "DRAFT_NOT_FOUND",
      );
    }

    const missingCsrf = await application.inject({
      headers: browserHeaders(ownerCookies),
      method: "PATCH",
      payload: { status: "disabled" },
      url: `/dashboard/api/drafts/${stored.draftId}`,
    });
    expect(missingCsrf.statusCode).toBe(403);

    const updated = await application.inject({
      headers: browserHeaders(ownerCookies, true),
      method: "PATCH",
      payload: { status: "disabled", title: "Reviewed report" },
      url: `/dashboard/api/drafts/${stored.draftId}`,
    });
    expect(draftSummarySchema.parse(updated.json())).toMatchObject({
      status: "disabled",
      title: "Reviewed report",
    });

    const requestedTtlSeconds = 14 * 24 * 60 * 60;
    const beforeExtension = Date.now();
    const extended = await application.inject({
      headers: browserHeaders(ownerCookies, true),
      method: "PATCH",
      payload: { ttlSeconds: requestedTtlSeconds },
      url: `/dashboard/api/drafts/${stored.draftId}`,
    });
    expect(extended.statusCode).toBe(200);
    const newExpiry = Date.parse(
      draftSummarySchema.parse(extended.json()).expiresAt,
    );
    expect(newExpiry).toBeGreaterThanOrEqual(
      beforeExtension + requestedTtlSeconds * 1_000,
    );
    expect(newExpiry).toBeLessThanOrEqual(
      Date.now() + requestedTtlSeconds * 1_000,
    );

    const invalidTtl = await application.inject({
      headers: browserHeaders(ownerCookies, true),
      method: "PATCH",
      payload: { ttlSeconds: 365 * 24 * 60 * 60 },
      url: `/dashboard/api/drafts/${stored.draftId}`,
    });
    expect(invalidTtl.statusCode).toBe(400);
    expect(publicErrorSchema.parse(invalidTtl.json()).error.code).toBe(
      "INVALID_TTL",
    );

    const deleted = await application.inject({
      headers: browserHeaders(ownerCookies, true),
      method: "DELETE",
      url: `/dashboard/api/drafts/${stored.draftId}`,
    });
    expect(deleted.statusCode).toBe(204);
    await expect(
      application.yaapsData!.drafts.findForOwner(ownerId, stored.draftId),
    ).resolves.toBeUndefined();

    const browserAudit = await application
      .yaapsData!.database.connection.selectFrom("audit_events")
      .select(["action", "actor_api_key_id", "actor_user_id"])
      .where("target_id", "=", stored.draftId)
      .where("action", "in", ["draft.updated", "draft.deleted"])
      .orderBy("id")
      .execute();
    expect(browserAudit).toEqual([
      {
        action: "draft.updated",
        actor_api_key_id: null,
        actor_user_id: ownerId,
      },
      {
        action: "draft.updated",
        actor_api_key_id: null,
        actor_user_id: ownerId,
      },
      {
        action: "draft.deleted",
        actor_api_key_id: null,
        actor_user_id: ownerId,
      },
    ]);
    await application.close();
  });

  it("requires an authenticated browser session for reads", async () => {
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory(),
    });
    const response = await application.inject({
      method: "GET",
      url: "/dashboard/api/drafts",
    });
    expect(response.statusCode).toBe(401);
    await application.close();
  });
});
