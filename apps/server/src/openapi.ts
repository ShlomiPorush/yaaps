import {
  categoryListResponseSchema,
  createDeviceConnectionRequestSchema,
  createDeviceConnectionResponseSchema,
  DOCUMENT_LIMITS,
  draftListResponseSchema,
  draftSummarySchema,
  draftVersionListResponseSchema,
  healthResponseSchema,
  publicErrorSchema,
  publicServiceMetadataSchema,
  pollDeviceConnectionRequestSchema,
  pollDeviceConnectionResponseSchema,
  publishDraftResponseSchema,
  readinessResponseSchema,
  updateDraftRequestSchema,
  type RetentionPolicy,
} from "@yaaps/contracts";
import { toJSONSchema, type ZodType } from "zod";

function schema(value: ZodType): Record<string, unknown> {
  const converted = toJSONSchema(value) as Record<string, unknown>;
  delete converted.$schema;
  return converted;
}

const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const bearerSecurity = [{ bearerAuth: [] }];

const draftIdParameter = {
  description: "A 32-character high-entropy draft identifier.",
  in: "path",
  name: "draftId",
  required: true,
  schema: { pattern: "^[A-Za-z0-9_-]{32}$", type: "string" },
};

const versionParameter = {
  description: "An immutable positive version number.",
  in: "path",
  name: "version",
  required: true,
  schema: { minimum: 1, type: "integer" },
};

const categoryParameter = {
  description:
    "An optional owner-scoped label, up to 100 characters, compared exactly.",
  in: "query",
  name: "category",
  required: false,
  schema: { maxLength: 100, minLength: 1, type: "string" },
};

const categoryFilterParameter = {
  ...categoryParameter,
  description:
    "Return only drafts whose category matches this value exactly. Omit for every draft.",
};

const titleParameter = {
  description: "An optional human-readable title, up to 200 characters.",
  in: "query",
  name: "title",
  required: false,
  schema: { maxLength: 200, minLength: 1, type: "string" },
};

const resourcePolicyParameter = {
  description:
    "Resource loading policy for this immutable version. Connected permits HTTPS images, fonts, and stylesheets while scripts and programmatic network access remain blocked, and is the default. Choose isolated explicitly to reject automatic external loads.",
  in: "query",
  name: "resourcePolicy",
  required: false,
  schema: {
    default: "connected",
    enum: ["isolated", "connected"],
    type: "string",
  },
};

const ttlParameter = (retention: RetentionPolicy) => ({
  description: `Lifetime in seconds. Defaults to ${retention.defaultTtlSeconds}.`,
  in: "query",
  name: "ttlSeconds",
  required: false,
  schema: {
    maximum: retention.maximumTtlSeconds,
    minimum: retention.minimumTtlSeconds,
    type: "integer",
  },
});

const paginationParameters = [
  {
    description: "Number of records to return. Defaults to 50.",
    in: "query",
    name: "limit",
    required: false,
    schema: { default: 50, maximum: 100, minimum: 1, type: "integer" },
  },
  {
    description: "Number of records to skip.",
    in: "query",
    name: "offset",
    required: false,
    schema: { default: 0, maximum: 10_000, minimum: 0, type: "integer" },
  },
];

const errorResponse = (description: string) => ({
  content: {
    "application/json": { schema: reference("Error") },
  },
  description,
});

const htmlRequestBody = {
  content: {
    "text/html": {
      schema: {
        description: "A complete UTF-8 HTML document.",
        maxLength: DOCUMENT_LIMITS.maximumHtmlBytes,
        type: "string",
      },
    },
  },
  description:
    "The report document. Scripts, forms, frames, programmatic network access, non-HTTPS resources, and unsafe CSS are rejected. Automatic external presentation resources additionally require resourcePolicy=connected.",
  required: true,
};

const publishResponses = {
  "201": {
    content: {
      "application/json": { schema: reference("PublishDraftResponse") },
    },
    description: "The draft and immutable version were created.",
  },
  "400": errorResponse("The HTML, query parameters, or TTL are invalid."),
  "401": errorResponse("The API key is missing, invalid, or revoked."),
  "413": errorResponse("The HTML document exceeds the configured limit."),
  "415": errorResponse("The request content type is not text/html."),
};

export function createOpenApiDocument(options: {
  publicOrigin: string;
  retention: RetentionPolicy;
  version: string;
}) {
  const origin = options.publicOrigin.replace(/\/$/u, "");
  const ttl = ttlParameter(options.retention);

  return {
    openapi: "3.1.0",
    info: {
      description:
        "Publish temporary HTML reports with an immutable per-version resource policy and manage their public lifecycle. Browser authentication and administration routes are intentionally outside this agent-facing API.",
      license: { name: "MIT" },
      title: "YAAPS API",
      version: options.version,
    },
    servers: [{ description: "This YAAPS instance", url: origin }],
    tags: [
      {
        description: "Service status and configured publishing limits.",
        name: "Service",
      },
      {
        description:
          "Authorize a local agent helper without sending its complete API key to YAAPS.",
        name: "Agent connection",
      },
      {
        description: "Bearer-authenticated report publishing and lifecycle.",
        name: "Drafts",
      },
      {
        description: "Capability URLs for reading enabled reports.",
        name: "Public reports",
      },
    ],
    paths: {
      "/auth/device-connections": {
        post: {
          operationId: "createDeviceConnection",
          requestBody: {
            content: {
              "application/json": {
                schema: reference("CreateDeviceConnectionRequest"),
              },
            },
            required: true,
          },
          responses: {
            "201": {
              content: {
                "application/json": {
                  schema: reference("CreateDeviceConnectionResponse"),
                },
              },
              description:
                "A short-lived connection request and human verification code.",
            },
            "400": errorResponse("The request is invalid."),
            "409": errorResponse("The proposed API key already exists."),
            "429": errorResponse("Too many connection attempts."),
          },
          summary: "Start agent authorization",
          tags: ["Agent connection"],
        },
      },
      "/auth/device-connections/token": {
        post: {
          operationId: "pollDeviceConnection",
          requestBody: {
            content: {
              "application/json": {
                schema: reference("PollDeviceConnectionRequest"),
              },
            },
            required: true,
          },
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: reference("PollDeviceConnectionResponse"),
                },
              },
              description: "The current authorization decision.",
            },
            "404": errorResponse("The device secret is invalid."),
            "410": errorResponse("The connection request expired."),
            "429": errorResponse("Polling is too frequent."),
          },
          summary: "Poll agent authorization",
          tags: ["Agent connection"],
        },
      },
      "/healthz": {
        get: {
          operationId: "getHealth",
          responses: {
            "200": {
              content: { "application/json": { schema: reference("Health") } },
              description: "The process is alive.",
            },
          },
          summary: "Check process health",
          tags: ["Service"],
        },
      },
      "/readyz": {
        get: {
          operationId: "getReadiness",
          responses: {
            "200": {
              content: {
                "application/json": { schema: reference("Readiness") },
              },
              description: "The database and data directory are ready.",
            },
            "503": {
              content: {
                "application/json": { schema: reference("Readiness") },
              },
              description: "The service is alive but not ready.",
            },
          },
          summary: "Check service readiness",
          tags: ["Service"],
        },
      },
      "/api/meta": {
        get: {
          operationId: "getServiceMetadata",
          responses: {
            "200": {
              content: {
                "application/json": { schema: reference("ServiceMetadata") },
              },
              description: "Current upload and retention limits.",
            },
          },
          summary: "Read publishing limits",
          tags: ["Service"],
        },
      },
      "/api/categories": {
        get: {
          operationId: "listCategories",
          responses: {
            "200": {
              content: {
                "application/json": { schema: reference("CategoryList") },
              },
              description:
                "Every distinct category on the API key user's drafts, with draft counts.",
            },
            "401": errorResponse(
              "The API key is missing, invalid, or revoked.",
            ),
          },
          security: bearerSecurity,
          summary: "List categories",
          tags: ["Drafts"],
        },
      },
      "/api/drafts": {
        get: {
          operationId: "listDrafts",
          parameters: [categoryFilterParameter, ...paginationParameters],
          responses: {
            "200": {
              content: {
                "application/json": { schema: reference("DraftList") },
              },
              description: "A page of drafts owned by the API key user.",
            },
            "401": errorResponse(
              "The API key is missing, invalid, or revoked.",
            ),
          },
          security: bearerSecurity,
          summary: "List drafts",
          tags: ["Drafts"],
        },
        post: {
          operationId: "createDraft",
          parameters: [
            categoryParameter,
            titleParameter,
            ttl,
            resourcePolicyParameter,
          ],
          requestBody: htmlRequestBody,
          responses: publishResponses,
          security: bearerSecurity,
          summary: "Publish a new draft",
          tags: ["Drafts"],
        },
      },
      "/api/drafts/{draftId}": {
        delete: {
          operationId: "deleteDraft",
          parameters: [draftIdParameter],
          responses: {
            "204": { description: "The draft and all versions were deleted." },
            "401": errorResponse(
              "The API key is missing, invalid, or revoked.",
            ),
            "404": errorResponse("The draft does not exist for this owner."),
          },
          security: bearerSecurity,
          summary: "Delete a draft",
          tags: ["Drafts"],
        },
        get: {
          operationId: "getDraft",
          parameters: [draftIdParameter],
          responses: {
            "200": {
              content: { "application/json": { schema: reference("Draft") } },
              description: "Draft metadata.",
            },
            "401": errorResponse(
              "The API key is missing, invalid, or revoked.",
            ),
            "404": errorResponse("The draft does not exist for this owner."),
          },
          security: bearerSecurity,
          summary: "Inspect a draft",
          tags: ["Drafts"],
        },
        patch: {
          operationId: "updateDraft",
          parameters: [draftIdParameter],
          requestBody: {
            content: {
              "application/json": { schema: reference("UpdateDraft") },
            },
            required: true,
          },
          responses: {
            "200": {
              content: { "application/json": { schema: reference("Draft") } },
              description: "Updated draft metadata.",
            },
            "400": errorResponse("The update is invalid."),
            "401": errorResponse(
              "The API key is missing, invalid, or revoked.",
            ),
            "404": errorResponse("The draft does not exist for this owner."),
          },
          security: bearerSecurity,
          summary: "Update category, title, or availability",
          tags: ["Drafts"],
        },
      },
      "/api/drafts/{draftId}/versions": {
        get: {
          operationId: "listDraftVersions",
          parameters: [draftIdParameter, ...paginationParameters],
          responses: {
            "200": {
              content: {
                "application/json": { schema: reference("VersionList") },
              },
              description: "A page of immutable versions.",
            },
            "401": errorResponse(
              "The API key is missing, invalid, or revoked.",
            ),
            "404": errorResponse("The draft does not exist for this owner."),
          },
          security: bearerSecurity,
          summary: "List immutable versions",
          tags: ["Drafts"],
        },
        post: {
          operationId: "addDraftVersion",
          parameters: [
            draftIdParameter,
            categoryParameter,
            titleParameter,
            ttl,
            resourcePolicyParameter,
          ],
          requestBody: htmlRequestBody,
          responses: publishResponses,
          security: bearerSecurity,
          summary: "Publish a new immutable version",
          tags: ["Drafts"],
        },
      },
      "/d/{draftId}": {
        get: {
          operationId: "readLatestReport",
          parameters: [draftIdParameter],
          responses: {
            "200": {
              content: { "text/html": { schema: { type: "string" } } },
              description:
                "The latest enabled report in a server-controlled sandbox.",
            },
            "404": errorResponse("The report is unavailable."),
            "410": errorResponse("The report has expired."),
          },
          summary: "Read the latest report",
          tags: ["Public reports"],
        },
      },
      "/d/{draftId}/v/{version}": {
        get: {
          operationId: "readReportVersion",
          parameters: [draftIdParameter, versionParameter],
          responses: {
            "200": {
              content: { "text/html": { schema: { type: "string" } } },
              description:
                "An immutable report version in a server-controlled sandbox.",
            },
            "404": errorResponse("The report is unavailable."),
            "410": errorResponse("The report has expired."),
          },
          summary: "Read an immutable report version",
          tags: ["Public reports"],
        },
      },
    },
    components: {
      schemas: {
        CategoryList: schema(categoryListResponseSchema),
        CreateDeviceConnectionRequest: schema(
          createDeviceConnectionRequestSchema,
        ),
        CreateDeviceConnectionResponse: schema(
          createDeviceConnectionResponseSchema,
        ),
        Draft: schema(draftSummarySchema),
        DraftList: schema(draftListResponseSchema),
        Error: schema(publicErrorSchema),
        Health: schema(healthResponseSchema),
        PublishDraftResponse: schema(publishDraftResponseSchema),
        PollDeviceConnectionRequest: schema(pollDeviceConnectionRequestSchema),
        PollDeviceConnectionResponse: schema(
          pollDeviceConnectionResponseSchema,
        ),
        Readiness: schema(readinessResponseSchema),
        ServiceMetadata: schema(publicServiceMetadataSchema),
        UpdateDraft: schema(updateDraftRequestSchema),
        VersionList: schema(draftVersionListResponseSchema),
      },
      securitySchemes: {
        bearerAuth: {
          bearerFormat: "YAAPS API key",
          description: "Use an API key created in the signed-in dashboard.",
          scheme: "bearer",
          type: "http",
        },
      },
    },
  } as const;
}
