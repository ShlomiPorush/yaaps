import { z } from "zod";

export const PRODUCT_NAME = "YAAPS" as const;
export const DEFAULT_SERVICE_ORIGIN = "https://yaaps.net" as const;
export const FOUNDATION_VERSION = "1.6.0" as const;

export const RETENTION_LIMITS_SECONDS = {
  default: 7 * 24 * 60 * 60,
  maximum: 30 * 24 * 60 * 60,
  minimum: 60 * 60,
} as const;

export const DOCUMENT_LIMITS = {
  maximumHtmlBytes: 10 * 1024 * 1024,
} as const;

// A category is a plain owner-scoped label: trimmed, printable, compared exactly.
export const draftCategorySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => !/\p{Cc}/u.test(value));
export const draftIdSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
export const draftStatusSchema = z.enum(["enabled", "disabled"]);
export const reportResourcePolicySchema = z.enum(["isolated", "connected"]);
export const draftTitleSchema = z.string().trim().min(1).max(200);
export const ttlSecondsSchema = z.coerce.number().int().positive().safe();
export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
});
export const draftListQuerySchema = paginationQuerySchema.extend({
  category: draftCategorySchema.optional(),
});
export const createDraftQuerySchema = z.object({
  category: draftCategorySchema.optional(),
  resourcePolicy: reportResourcePolicySchema.optional(),
  title: draftTitleSchema.optional(),
  ttlSeconds: ttlSecondsSchema.optional(),
});
export const addDraftVersionQuerySchema = z.object({
  category: draftCategorySchema.optional(),
  resourcePolicy: reportResourcePolicySchema.optional(),
  title: draftTitleSchema.optional(),
  ttlSeconds: ttlSecondsSchema.optional(),
});
export const updateDraftRequestSchema = z
  .object({
    category: draftCategorySchema.nullable().optional(),
    status: draftStatusSchema.optional(),
    title: draftTitleSchema.nullable().optional(),
    ttlSeconds: ttlSecondsSchema.optional(),
  })
  .refine(
    (value) =>
      value.category !== undefined ||
      value.status !== undefined ||
      value.title !== undefined ||
      value.ttlSeconds !== undefined,
  );

export const draftSummarySchema = z.object({
  category: draftCategorySchema.nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  id: draftIdSchema,
  latestVersionNumber: z.number().int().positive(),
  publicUrl: z.url(),
  resourcePolicy: reportResourcePolicySchema,
  status: draftStatusSchema,
  title: draftTitleSchema.nullable(),
  updatedAt: z.iso.datetime(),
  viewCount: z.number().int().nonnegative(),
});
export const draftVersionSummarySchema = z.object({
  byteLength: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  publicUrl: z.url(),
  resourcePolicy: reportResourcePolicySchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  versionNumber: z.number().int().positive(),
  viewCount: z.number().int().nonnegative(),
});
export const publishDraftResponseSchema = z.object({
  draft: draftSummarySchema,
  version: draftVersionSummarySchema,
});
export const draftListResponseSchema = z.object({
  items: z.array(draftSummarySchema),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export const adminDraftSummarySchema = draftSummarySchema.extend({
  ownerDisplayName: z.string().min(1).max(100),
  ownerId: z.uuid(),
});
export const adminDraftListResponseSchema = z.object({
  items: z.array(adminDraftSummarySchema),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export const draftVersionListResponseSchema = z.object({
  items: z.array(draftVersionSummarySchema),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export const categorySummarySchema = z.object({
  category: draftCategorySchema,
  draftCount: z.number().int().positive(),
});
export const categoryListResponseSchema = z.object({
  items: z.array(categorySummarySchema),
});

export const healthResponseSchema = z.object({
  name: z.literal(PRODUCT_NAME),
  status: z.literal("ok"),
  version: z.string().min(1),
});

export const readinessResponseSchema = z.object({
  checks: z.object({
    dataDirectory: z.enum(["ok", "failed"]),
  }),
  name: z.literal(PRODUCT_NAME),
  status: z.enum(["ready", "not_ready"]),
  version: z.string().min(1),
});

export const publicServiceMetadataSchema = z.object({
  limits: z
    .object({
      defaultTtlSeconds: z.number().int().positive().safe(),
      maximumHtmlBytes: z.literal(DOCUMENT_LIMITS.maximumHtmlBytes),
      maximumTtlSeconds: z.number().int().positive().safe(),
      minimumTtlSeconds: z.number().int().positive().safe(),
    })
    .refine(
      (limits) =>
        limits.minimumTtlSeconds <= limits.defaultTtlSeconds &&
        limits.defaultTtlSeconds <= limits.maximumTtlSeconds,
    ),
  name: z.literal(PRODUCT_NAME),
  stage: z.literal("foundation"),
});

export const publicErrorSchema = z.object({
  error: z.object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string().min(1),
  }),
});

export const userRoleSchema = z.enum(["admin", "user"]);
export const userStatusSchema = z.enum(["active", "disabled"]);
export const displayNameSchema = z.string().trim().min(1).max(100);
export const bootstrapOptionsRequestSchema = z.object({
  displayName: displayNameSchema,
  secret: z.string().min(1),
});
export const invitationOptionsRequestSchema = z.object({
  displayName: displayNameSchema,
  token: z.string().min(1),
});
export const registerOptionsRequestSchema = z.object({
  displayName: displayNameSchema,
});
export const recoveryRequestSchema = z.object({ code: z.string().min(1) });
export const apiKeyLabelSchema = z.string().trim().min(1).max(100);
export const createApiKeyRequestSchema = z.object({
  label: apiKeyLabelSchema,
});
export const updateApiKeyRequestSchema = z.object({
  label: apiKeyLabelSchema,
});
export const apiKeyPrefixSchema = z.string().regex(/^yaaps_[A-Za-z0-9_-]{10}$/);
export const apiKeySchema = z
  .string()
  .regex(/^yaaps_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
export const deviceConnectionUserCodeSchema = z
  .string()
  .trim()
  .min(8)
  .max(32)
  .regex(/^[A-HJ-NP-Za-hj-np-z2-9\t\n\v\f\r -]+$/)
  .refine((value) => value.replace(/[\t\n\v\f\r -]/gu, "").length === 8);
export const createDeviceConnectionRequestSchema = z.object({
  keyHash: z.string().regex(/^[a-f0-9]{64}$/),
  keyPrefix: apiKeyPrefixSchema,
  label: apiKeyLabelSchema,
});
export const createDeviceConnectionResponseSchema = z.object({
  deviceSecret: z.string().regex(/^yad_[A-Za-z0-9_-]{43}$/),
  expiresAt: z.iso.datetime(),
  intervalSeconds: z.number().int().min(1).max(30),
  userCode: z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
  verificationUrl: z.url(),
  verificationUrlComplete: z.url(),
});
export const pollDeviceConnectionRequestSchema = z.object({
  deviceSecret: z.string().regex(/^yad_[A-Za-z0-9_-]{43}$/),
});
export const pollDeviceConnectionResponseSchema = z.discriminatedUnion(
  "status",
  [
    z.object({ status: z.literal("pending") }),
    z.object({ status: z.literal("denied") }),
    z.object({ apiKeyId: z.uuid(), status: z.literal("approved") }),
  ],
);
export const pendingDeviceConnectionSchema = z.object({
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  id: z.uuid(),
  keyPrefix: apiKeyPrefixSchema,
  label: apiKeyLabelSchema,
  status: z.literal("pending"),
  userCode: z.string().regex(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/),
});
export const decideDeviceConnectionRequestSchema = z.object({
  userCode: deviceConnectionUserCodeSchema,
});
export const approveDeviceConnectionResponseSchema = z.object({
  apiKey: z.object({
    createdAt: z.iso.datetime(),
    id: z.uuid(),
    label: apiKeyLabelSchema,
    lastUsedAt: z.null(),
    prefix: apiKeyPrefixSchema,
  }),
  status: z.literal("approved"),
});
export const createInvitationRequestSchema = z.object({
  lifetimeSeconds: z
    .number()
    .int()
    .min(300)
    .max(7 * 24 * 60 * 60),
  role: userRoleSchema,
});
export const authenticatedUserSchema = z.object({
  id: z.uuid(),
  role: userRoleSchema,
});
export const browserSessionResponseSchema = z.object({
  recoveryCodes: z.array(z.string().min(1)).optional(),
  user: authenticatedUserSchema,
});
export const authenticationStateResponseSchema = z.object({
  initialized: z.boolean(),
  openRegistration: z.boolean(),
});
export const createdApiKeyResponseSchema = z.object({
  id: z.uuid(),
  key: z.string().startsWith("yaaps_"),
  prefix: z.string().startsWith("yaaps_"),
});
export const apiKeySummarySchema = z.object({
  createdAt: z.iso.datetime(),
  id: z.uuid(),
  label: z.string().min(1).max(100),
  lastUsedAt: z.iso.datetime().nullable(),
  prefix: z.string().startsWith("yaaps_"),
});
export const apiKeyListResponseSchema = z.object({
  items: z.array(apiKeySummarySchema),
});
export const createdInvitationResponseSchema = z.object({
  expiresAt: z.iso.datetime(),
  id: z.uuid(),
  token: z.string().startsWith("yai_"),
});
export const adminUserSummarySchema = z.object({
  createdAt: z.iso.datetime(),
  disabledAt: z.iso.datetime().nullable(),
  displayName: displayNameSchema,
  draftCount: z.number().int().nonnegative(),
  id: z.uuid(),
  role: userRoleSchema,
  status: userStatusSchema,
});
export const adminUserListResponseSchema = z.object({
  items: z.array(adminUserSummarySchema),
});
export const invitationStatusSchema = z.enum([
  "accepted",
  "expired",
  "pending",
  "revoked",
]);
export const invitationSummarySchema = z.object({
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  id: z.uuid(),
  role: userRoleSchema,
  status: invitationStatusSchema,
});
export const invitationListResponseSchema = z.object({
  items: z.array(invitationSummarySchema),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type CreateDeviceConnectionResponse = z.infer<
  typeof createDeviceConnectionResponseSchema
>;
export type PollDeviceConnectionResponse = z.infer<
  typeof pollDeviceConnectionResponseSchema
>;
export type PendingDeviceConnection = z.infer<
  typeof pendingDeviceConnectionSchema
>;
export type ApproveDeviceConnectionResponse = z.infer<
  typeof approveDeviceConnectionResponseSchema
>;
export type ApiKeyListResponse = z.infer<typeof apiKeyListResponseSchema>;
export type CreatedApiKeyResponse = z.infer<typeof createdApiKeyResponseSchema>;
export type CreatedInvitationResponse = z.infer<
  typeof createdInvitationResponseSchema
>;
export type ApiKeySummary = z.infer<typeof apiKeySummarySchema>;
export type AdminUserSummary = z.infer<typeof adminUserSummarySchema>;
export type AdminDraftSummary = z.infer<typeof adminDraftSummarySchema>;
export type CategoryListResponse = z.infer<typeof categoryListResponseSchema>;
export type CategorySummary = z.infer<typeof categorySummarySchema>;
export type DraftListQuery = z.infer<typeof draftListQuerySchema>;
export type DraftListResponse = z.infer<typeof draftListResponseSchema>;
export type DraftStatus = z.infer<typeof draftStatusSchema>;
export type ReportResourcePolicy = z.infer<typeof reportResourcePolicySchema>;
export type DraftSummary = z.infer<typeof draftSummarySchema>;
export type DraftVersionListResponse = z.infer<
  typeof draftVersionListResponseSchema
>;
export type DraftVersionSummary = z.infer<typeof draftVersionSummarySchema>;
export type InvitationSummary = z.infer<typeof invitationSummarySchema>;
export type PublishDraftResponse = z.infer<typeof publishDraftResponseSchema>;
export interface RetentionPolicy {
  defaultTtlSeconds: number;
  maximumTtlSeconds: number;
  minimumTtlSeconds: number;
}
export type PublicError = z.infer<typeof publicErrorSchema>;
export type PublicServiceMetadata = z.infer<typeof publicServiceMetadataSchema>;
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
export type UserRole = z.infer<typeof userRoleSchema>;
