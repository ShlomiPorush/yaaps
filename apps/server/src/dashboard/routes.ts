import {
  draftIdSchema,
  paginationQuerySchema,
  type RetentionPolicy,
  updateDraftRequestSchema,
} from "@yaaps/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  type AuthenticationRepository,
  AuthorizationError,
} from "../auth/repository.js";
import { requireBrowserCsrf, requireBrowserSession } from "../auth/routes.js";
import {
  draftSummary,
  expiration,
  selectedTtl,
  versionSummary,
} from "../reports/api-routes.js";
import {
  DraftNotFoundError,
  type DraftStorage,
} from "../storage/draft-storage.js";

const draftParametersSchema = z.object({ draftId: draftIdSchema });

export async function registerDashboardManagementRoutes(
  application: FastifyInstance,
  options: {
    authentication: AuthenticationRepository;
    drafts: DraftStorage;
    publicOrigin: string;
    retention: RetentionPolicy;
    secureCookies: boolean;
  },
): Promise<void> {
  const publicOrigin = options.publicOrigin.replace(/\/$/, "");
  const session = (request: Parameters<typeof requireBrowserSession>[0]) =>
    requireBrowserSession(
      request,
      options.authentication,
      options.secureCookies,
    );
  const csrf = async (request: Parameters<typeof requireBrowserSession>[0]) => {
    const actor = await session(request);
    requireBrowserCsrf(
      request,
      actor,
      options.authentication,
      options.secureCookies,
    );
    return actor;
  };
  const adminSession = async (
    request: Parameters<typeof requireBrowserSession>[0],
    requireWrite = false,
  ) => {
    const actor = requireWrite ? await csrf(request) : await session(request);
    if (actor.role !== "admin") {
      throw new AuthorizationError();
    }
    return actor;
  };

  application.get("/dashboard/api/drafts", async (request) => {
    const actor = await session(request);
    const query = paginationQuerySchema.parse(request.query);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const result = await options.drafts.listForOwner(
      actor.userId,
      limit,
      offset,
    );
    return {
      items: result.items.map((draft) => draftSummary(publicOrigin, draft)),
      limit,
      offset,
      total: result.total,
    };
  });

  application.get(
    "/dashboard/api/drafts/:draftId/versions",
    async (request) => {
      const actor = await session(request);
      const { draftId } = draftParametersSchema.parse(request.params);
      const query = paginationQuerySchema.parse(request.query);
      const limit = query.limit ?? 50;
      const offset = query.offset ?? 0;
      const result = await options.drafts.listVersionsForOwner(
        actor.userId,
        draftId,
        limit,
        offset,
      );
      return {
        items: result.items.map((version) =>
          versionSummary(publicOrigin, draftId, version),
        ),
        limit,
        offset,
        total: result.total,
      };
    },
  );

  application.patch("/dashboard/api/drafts/:draftId", async (request) => {
    const actor = await csrf(request);
    const { draftId } = draftParametersSchema.parse(request.params);
    const update = updateDraftRequestSchema.parse(request.body);
    return draftSummary(
      publicOrigin,
      await options.drafts.updateForOwner({
        apiKeyId: null,
        draftId,
        // A new TTL always counts from now, mirroring publish semantics.
        expiresAt:
          update.ttlSeconds === undefined
            ? undefined
            : expiration(selectedTtl(update.ttlSeconds, options.retention)),
        ownerId: actor.userId,
        status: update.status,
        title: update.title,
      }),
    );
  });

  application.delete(
    "/dashboard/api/drafts/:draftId",
    async (request, reply) => {
      const actor = await csrf(request);
      const { draftId } = draftParametersSchema.parse(request.params);
      if (!(await options.drafts.findForOwner(actor.userId, draftId))) {
        throw new DraftNotFoundError();
      }
      await options.drafts.deleteForOwner({
        apiKeyId: null,
        draftId,
        ownerId: actor.userId,
      });
      return reply.code(204).send();
    },
  );

  application.get("/dashboard/api/admin/users", async (request) => {
    const actor = await adminSession(request);
    return { items: await options.authentication.listUsers(actor.userId) };
  });

  application.get("/dashboard/api/admin/invitations", async (request) => {
    const actor = await adminSession(request);
    return {
      items: await options.authentication.listInvitations(actor.userId),
    };
  });

  application.get("/dashboard/api/admin/drafts", async (request) => {
    await adminSession(request);
    const query = paginationQuerySchema.parse(request.query);
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    const result = await options.drafts.listForAdmin(limit, offset);
    return {
      items: result.items.map((entry) => ({
        ...draftSummary(publicOrigin, entry.draft),
        ownerDisplayName: entry.ownerDisplayName,
        ownerId: entry.ownerId,
      })),
      limit,
      offset,
      total: result.total,
    };
  });

  application.patch("/dashboard/api/admin/drafts/:draftId", async (request) => {
    const actor = await adminSession(request, true);
    const { draftId } = draftParametersSchema.parse(request.params);
    const { status } = z
      .object({ status: z.enum(["disabled", "enabled"]) })
      .parse(request.body);
    const draft = await options.drafts.updateAsAdmin({
      actorUserId: actor.userId,
      draftId,
      status,
    });
    const owner = (await options.authentication.listUsers(actor.userId)).find(
      (user) => user.id === draft.owner_id,
    );
    if (!owner) {
      throw new DraftNotFoundError();
    }
    return {
      ...draftSummary(publicOrigin, draft),
      ownerDisplayName: owner.displayName,
      ownerId: owner.id,
    };
  });

  application.delete(
    "/dashboard/api/admin/drafts/:draftId",
    async (request, reply) => {
      const actor = await adminSession(request, true);
      const { draftId } = draftParametersSchema.parse(request.params);
      await options.drafts.deleteAsAdmin({
        actorUserId: actor.userId,
        draftId,
      });
      return reply.code(204).send();
    },
  );

  application.post(
    "/dashboard/api/admin/users/:userId/enable",
    async (request, reply) => {
      const actor = await adminSession(request, true);
      const { userId } = z.object({ userId: z.uuid() }).parse(request.params);
      await options.authentication.enableUser(actor.userId, userId);
      return reply.code(204).send();
    },
  );

  application.delete(
    "/dashboard/api/admin/invitations/:invitationId",
    async (request, reply) => {
      const actor = await adminSession(request, true);
      const { invitationId } = z
        .object({ invitationId: z.uuid() })
        .parse(request.params);
      await options.authentication.revokeInvitation(actor.userId, invitationId);
      return reply.code(204).send();
    },
  );
}
