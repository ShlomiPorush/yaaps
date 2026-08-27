import {
  DOCUMENT_LIMITS,
  addDraftVersionQuerySchema,
  createDraftQuerySchema,
  draftIdSchema,
  draftListQuerySchema,
  paginationQuerySchema,
  updateDraftRequestSchema,
  type DraftSummary,
  type DraftVersionSummary,
  type RetentionPolicy,
} from "@yaaps/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  AuthenticationError,
  type AuthenticatedApiKey,
  type AuthenticationRepository,
} from "../auth/repository.js";
import {
  DraftNotFoundError,
  type DraftStorage,
  type StoredDraftVersion,
  type StoredDraft,
  type StoredVersionMetadata,
} from "../storage/draft-storage.js";

const draftParametersSchema = z.object({ draftId: draftIdSchema });

class UnsupportedReportMediaTypeError extends Error {
  readonly statusCode = 415;
}

export class InvalidTtlError extends Error {
  constructor(readonly retention: RetentionPolicy) {
    super("The requested TTL is outside the configured range.");
    this.name = "InvalidTtlError";
  }
}

function bearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  const match = /^Bearer (yaaps_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+)$/.exec(
    authorization ?? "",
  );
  if (!match?.[1]) {
    throw new AuthenticationError();
  }
  return match[1];
}

export function expiration(ttlSeconds: number): string {
  return new Date(Date.now() + ttlSeconds * 1_000).toISOString();
}

export function selectedTtl(
  requested: number | undefined,
  retention: RetentionPolicy,
): number {
  const ttl = requested ?? retention.defaultTtlSeconds;
  if (ttl < retention.minimumTtlSeconds || ttl > retention.maximumTtlSeconds) {
    throw new InvalidTtlError(retention);
  }
  return ttl;
}

function canonicalUrl(origin: string, draftId: string): string {
  return `${origin}/d/${draftId}`;
}

export function draftSummary(origin: string, draft: StoredDraft): DraftSummary {
  return {
    category: draft.category,
    createdAt: draft.created_at,
    expiresAt: draft.expires_at,
    id: draft.id,
    latestVersionNumber: draft.latest_version_number,
    publicUrl: canonicalUrl(origin, draft.id),
    resourcePolicy: draft.resourcePolicy,
    status: draft.status,
    title: draft.title,
    updatedAt: draft.updated_at,
    viewCount: draft.view_count,
  };
}

export function versionSummary(
  origin: string,
  draftId: string,
  version: StoredDraftVersion | StoredVersionMetadata,
): DraftVersionSummary {
  return {
    byteLength: version.byteLength,
    createdAt: version.createdAt,
    publicUrl: `${canonicalUrl(origin, draftId)}/v/${version.versionNumber}`,
    resourcePolicy: version.resourcePolicy,
    sha256: version.sha256,
    versionNumber: version.versionNumber,
    viewCount: version.viewCount,
  };
}

function htmlBody(request: FastifyRequest): Buffer {
  if (!Buffer.isBuffer(request.body)) {
    throw new z.ZodError([]);
  }
  return request.body;
}

async function requireHtmlMediaType(request: FastifyRequest): Promise<void> {
  const essence = request.headers["content-type"]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (essence !== "text/html") {
    throw new UnsupportedReportMediaTypeError();
  }
}

export async function registerReportApiRoutes(
  application: FastifyInstance,
  options: {
    authentication: AuthenticationRepository;
    drafts: DraftStorage;
    publicOrigin: string;
    retention: RetentionPolicy;
  },
): Promise<void> {
  const publicOrigin = options.publicOrigin.replace(/\/$/, "");

  await application.register(
    async (api) => {
      const principals = new WeakMap<FastifyRequest, AuthenticatedApiKey>();
      api.addContentTypeParser(
        "text/html",
        {
          bodyLimit: DOCUMENT_LIMITS.maximumHtmlBytes,
          parseAs: "buffer",
        },
        (_request, body, done) => done(null, body),
      );
      api.addHook("onRequest", async (request) => {
        principals.set(
          request,
          await options.authentication.authenticateApiKey(bearerToken(request)),
        );
      });

      const principal = (request: FastifyRequest): AuthenticatedApiKey => {
        const value = principals.get(request);
        if (!value) {
          throw new AuthenticationError();
        }
        return value;
      };

      api.post(
        "/drafts",
        {
          bodyLimit: DOCUMENT_LIMITS.maximumHtmlBytes,
          onRequest: requireHtmlMediaType,
        },
        async (request, reply) => {
          const actor = principal(request);
          const query = createDraftQuerySchema.parse(request.query);
          const stored = await options.drafts.createDraft({
            category: query.category,
            expiresAt: expiration(
              selectedTtl(query.ttlSeconds, options.retention),
            ),
            html: htmlBody(request),
            ownerId: actor.userId,
            resourcePolicy: query.resourcePolicy,
            title: query.title,
            uploadedByApiKeyId: actor.apiKeyId,
          });
          const draft = await options.drafts.findForOwner(
            actor.userId,
            stored.draftId,
          );
          if (!draft) {
            throw new Error("A newly created draft could not be read.");
          }
          return reply.code(201).send({
            draft: draftSummary(publicOrigin, draft),
            version: versionSummary(publicOrigin, draft.id, stored),
          });
        },
      );

      api.post(
        "/drafts/:draftId/versions",
        {
          bodyLimit: DOCUMENT_LIMITS.maximumHtmlBytes,
          onRequest: requireHtmlMediaType,
        },
        async (request, reply) => {
          const actor = principal(request);
          const { draftId } = draftParametersSchema.parse(request.params);
          const query = addDraftVersionQuerySchema.parse(request.query);
          const stored = await options.drafts.addVersion({
            category: query.category,
            draftId,
            expiresAt: expiration(
              selectedTtl(query.ttlSeconds, options.retention),
            ),
            html: htmlBody(request),
            ownerId: actor.userId,
            resourcePolicy: query.resourcePolicy,
            title: query.title,
            uploadedByApiKeyId: actor.apiKeyId,
          });
          const draft = await options.drafts.findForOwner(
            actor.userId,
            draftId,
          );
          if (!draft) {
            throw new Error("An updated draft could not be read.");
          }
          return reply.code(201).send({
            draft: draftSummary(publicOrigin, draft),
            version: versionSummary(publicOrigin, draft.id, stored),
          });
        },
      );

      api.get("/categories", async (request) => {
        const actor = principal(request);
        return {
          items: await options.drafts.listCategoriesForOwner(actor.userId),
        };
      });

      api.get("/drafts", async (request) => {
        const actor = principal(request);
        const query = draftListQuerySchema.parse(request.query);
        const limit = query.limit ?? 50;
        const offset = query.offset ?? 0;
        const result = await options.drafts.listForOwner(
          actor.userId,
          limit,
          offset,
          query.category,
        );
        return {
          items: result.items.map((draft) => draftSummary(publicOrigin, draft)),
          limit,
          offset,
          total: result.total,
        };
      });

      api.get("/drafts/:draftId", async (request) => {
        const actor = principal(request);
        const { draftId } = draftParametersSchema.parse(request.params);
        const draft = await options.drafts.findForOwner(actor.userId, draftId);
        if (!draft) {
          throw new DraftNotFoundError();
        }
        return draftSummary(publicOrigin, draft);
      });

      api.get("/drafts/:draftId/versions", async (request) => {
        const actor = principal(request);
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
      });

      api.patch("/drafts/:draftId", async (request) => {
        const actor = principal(request);
        const { draftId } = draftParametersSchema.parse(request.params);
        const update = updateDraftRequestSchema.parse(request.body);
        return draftSummary(
          publicOrigin,
          await options.drafts.updateForOwner({
            apiKeyId: actor.apiKeyId,
            category: update.category,
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

      api.delete("/drafts/:draftId", async (request, reply) => {
        const actor = principal(request);
        const { draftId } = draftParametersSchema.parse(request.params);
        await options.drafts.deleteForOwner({
          apiKeyId: actor.apiKeyId,
          draftId,
          ownerId: actor.userId,
        });
        return reply.code(204).send();
      });
    },
    { prefix: "/api" },
  );
}
