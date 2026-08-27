import { describe, expect, it } from "vitest";

import {
  addDraftVersionQuerySchema,
  apiKeyListResponseSchema,
  browserSessionResponseSchema,
  categoryListResponseSchema,
  createApiKeyRequestSchema,
  createDeviceConnectionRequestSchema,
  createDeviceConnectionResponseSchema,
  createDraftQuerySchema,
  createInvitationRequestSchema,
  DOCUMENT_LIMITS,
  draftCategorySchema,
  draftListQuerySchema,
  draftSummarySchema,
  draftVersionSummarySchema,
  PRODUCT_NAME,
  RETENTION_LIMITS_SECONDS,
  healthResponseSchema,
  publicErrorSchema,
  publicServiceMetadataSchema,
  reportResourcePolicySchema,
  pollDeviceConnectionResponseSchema,
  updateDraftRequestSchema,
} from "./index.js";

describe("public contracts", () => {
  it("accepts the stable health response", () => {
    expect(
      healthResponseSchema.parse({
        name: PRODUCT_NAME,
        status: "ok",
        version: "0.0.0",
      }),
    ).toEqual({ name: PRODUCT_NAME, status: "ok", version: "0.0.0" });
  });

  it("rejects unstable lowercase error codes", () => {
    expect(() =>
      publicErrorSchema.parse({
        error: { code: "not_ready", message: "Not ready." },
      }),
    ).toThrow();
  });

  it("keeps the approved retention and document limits in public metadata", () => {
    const metadata = publicServiceMetadataSchema.parse({
      limits: {
        defaultTtlSeconds: RETENTION_LIMITS_SECONDS.default,
        maximumHtmlBytes: DOCUMENT_LIMITS.maximumHtmlBytes,
        maximumTtlSeconds: RETENTION_LIMITS_SECONDS.maximum,
        minimumTtlSeconds: RETENTION_LIMITS_SECONDS.minimum,
      },
      name: PRODUCT_NAME,
      stage: "foundation",
    });

    expect(metadata.limits).toEqual({
      defaultTtlSeconds: 604_800,
      maximumHtmlBytes: 10_485_760,
      maximumTtlSeconds: 2_592_000,
      minimumTtlSeconds: 3_600,
    });
    expect(() =>
      publicServiceMetadataSchema.parse({
        limits: {
          defaultTtlSeconds: 100,
          maximumHtmlBytes: DOCUMENT_LIMITS.maximumHtmlBytes,
          maximumTtlSeconds: 1000,
          minimumTtlSeconds: 200,
        },
        name: PRODUCT_NAME,
        stage: "foundation",
      }),
    ).toThrow();
  });

  it("validates browser authentication and secret-creation contracts", () => {
    expect(
      browserSessionResponseSchema.parse({
        recoveryCodes: ["yar_once"],
        user: { id: "8f7c1ca3-edbc-4b4b-b349-d45322728936", role: "admin" },
      }),
    ).toMatchObject({ user: { role: "admin" } });
    expect(createApiKeyRequestSchema.parse({ label: "Local agent" })).toEqual({
      label: "Local agent",
    });
    expect(
      apiKeyListResponseSchema.parse({
        items: [
          {
            createdAt: "2026-08-24T08:00:00.000Z",
            id: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
            key: "yaaps_must_not_escape",
            label: "Local agent",
            lastUsedAt: null,
            prefix: "yaaps_prefix",
          },
        ],
      }),
    ).toEqual({
      items: [
        {
          createdAt: "2026-08-24T08:00:00.000Z",
          id: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
          label: "Local agent",
          lastUsedAt: null,
          prefix: "yaaps_prefix",
        },
      ],
    });
    expect(() =>
      createInvitationRequestSchema.parse({
        lifetimeSeconds: 30,
        role: "owner",
      }),
    ).toThrow();
  });

  it("validates provider-neutral device authorization contracts", () => {
    expect(
      createDeviceConnectionRequestSchema.parse({
        keyHash: "a".repeat(64),
        keyPrefix: "yaaps_abcdefghij",
        label: "Claude on laptop",
      }),
    ).toMatchObject({ keyPrefix: "yaaps_abcdefghij" });
    expect(
      createDeviceConnectionResponseSchema.parse({
        deviceSecret: `yad_${"a".repeat(43)}`,
        expiresAt: "2026-08-24T08:10:00.000Z",
        intervalSeconds: 2,
        userCode: "ABCD-EFGH",
        verificationUrl: "https://share.example/dashboard/connect/approve",
        verificationUrlComplete:
          "https://share.example/dashboard/connect/approve?code=ABCD-EFGH",
      }),
    ).toMatchObject({ userCode: "ABCD-EFGH" });
    expect(
      pollDeviceConnectionResponseSchema.parse({
        apiKeyId: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
        status: "approved",
      }),
    ).toMatchObject({ status: "approved" });
    expect(() =>
      createDeviceConnectionRequestSchema.parse({
        keyHash: "plaintext-key",
        keyPrefix: "yaaps_too-short",
        label: "Agent",
      }),
    ).toThrow();
  });
});

describe("draft category contracts", () => {
  it("trims accepted category labels and rejects unusable values", () => {
    expect(draftCategorySchema.parse("  Quarterly reviews  ")).toBe(
      "Quarterly reviews",
    );
    expect(draftCategorySchema.parse("a".repeat(100))).toHaveLength(100);
    for (const invalid of [
      "",
      "   ",
      "a".repeat(101),
      "Two\nlines",
      "Alarm\u0007",
    ]) {
      expect(() => draftCategorySchema.parse(invalid)).toThrow();
    }
  });

  it("carries the category through publish, version, and list queries", () => {
    expect(
      createDraftQuerySchema.parse({ category: " Ops ", ttlSeconds: "3600" }),
    ).toEqual({ category: "Ops", ttlSeconds: 3600 });
    expect(addDraftVersionQuerySchema.parse({ category: "Ops" })).toEqual({
      category: "Ops",
    });
    expect(createDraftQuerySchema.parse({})).toEqual({});
    expect(
      draftListQuerySchema.parse({ category: "Ops", limit: "10" }),
    ).toEqual({ category: "Ops", limit: 10 });
    expect(() => draftListQuerySchema.parse({ category: "" })).toThrow();
  });

  it("accepts clearing a category but still rejects an empty update", () => {
    expect(updateDraftRequestSchema.parse({ category: null })).toEqual({
      category: null,
    });
    expect(updateDraftRequestSchema.parse({ category: " Ops " })).toEqual({
      category: "Ops",
    });
    expect(() => updateDraftRequestSchema.parse({})).toThrow();
    expect(() => updateDraftRequestSchema.parse({ category: "  " })).toThrow();
  });

  it("describes an owner's categories with positive draft counts", () => {
    expect(
      categoryListResponseSchema.parse({
        items: [
          { category: "Ops", draftCount: 2 },
          { category: "Reviews", draftCount: 1 },
        ],
      }).items,
    ).toHaveLength(2);
    expect(() =>
      categoryListResponseSchema.parse({
        items: [{ category: "Ops", draftCount: 0 }],
      }),
    ).toThrow();
  });
});

describe("report resource policy contracts", () => {
  it("accepts the two immutable policies on publish queries", () => {
    expect(reportResourcePolicySchema.parse("isolated")).toBe("isolated");
    expect(reportResourcePolicySchema.parse("connected")).toBe("connected");
    expect(
      createDraftQuerySchema.parse({ resourcePolicy: "connected" }),
    ).toEqual({ resourcePolicy: "connected" });
    expect(
      addDraftVersionQuerySchema.parse({ resourcePolicy: "isolated" }),
    ).toEqual({ resourcePolicy: "isolated" });
    expect(() =>
      createDraftQuerySchema.parse({ resourcePolicy: "permissive" }),
    ).toThrow();
  });
});

describe("report view count contracts", () => {
  const draft = {
    category: null,
    createdAt: "2026-08-24T08:00:00.000Z",
    expiresAt: "2026-08-31T08:00:00.000Z",
    id: "A".repeat(32),
    latestVersionNumber: 1,
    publicUrl: `https://share.example.test/d/${"A".repeat(32)}`,
    resourcePolicy: "isolated",
    status: "enabled",
    title: null,
    updatedAt: "2026-08-24T08:00:00.000Z",
    viewCount: 12,
  };

  it("requires nonnegative integer counts on reports and versions", () => {
    expect(draftSummarySchema.parse(draft).viewCount).toBe(12);
    expect(
      draftVersionSummarySchema.parse({
        byteLength: 128,
        createdAt: draft.createdAt,
        publicUrl: `${draft.publicUrl}/v/1`,
        resourcePolicy: "isolated",
        sha256: "a".repeat(64),
        versionNumber: 1,
        viewCount: 7,
      }).viewCount,
    ).toBe(7);
    expect(() =>
      draftSummarySchema.parse({ ...draft, viewCount: -1 }),
    ).toThrow();
  });
});
