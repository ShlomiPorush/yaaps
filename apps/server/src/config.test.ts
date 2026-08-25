import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfiguration } from "./config.js";

describe("server authentication configuration", () => {
  it("uses safe localhost defaults", () => {
    const configuration = loadConfiguration({});
    expect(configuration).toMatchObject({
      cleanupIntervalSeconds: 300,
      publicOrigin: "http://localhost:3000",
      retention: {
        defaultTtlSeconds: 604_800,
        maximumTtlSeconds: 2_592_000,
        minimumTtlSeconds: 3_600,
      },
      rpId: "localhost",
      secureCookies: false,
    });
    expect(configuration.skillDistributionDirectory).toBe(
      path.resolve(process.cwd(), "apps/server/dist/skill-distribution"),
    );
  });

  it("allows an operator to override the generated skill distribution", () => {
    expect(
      loadConfiguration({ YAAPS_SKILL_DISTRIBUTION_DIR: "custom-skill-bundle" })
        .skillDistributionDirectory,
    ).toBe("custom-skill-bundle");
  });

  it("accepts operator retention limits only in a valid order", () => {
    expect(
      loadConfiguration({
        YAAPS_DEFAULT_TTL_SECONDS: "7200",
        YAAPS_MAX_TTL_SECONDS: "86400",
        YAAPS_MIN_TTL_SECONDS: "600",
      }).retention,
    ).toEqual({
      defaultTtlSeconds: 7200,
      maximumTtlSeconds: 86400,
      minimumTtlSeconds: 600,
    });
    expect(() =>
      loadConfiguration({
        YAAPS_DEFAULT_TTL_SECONDS: "100",
        YAAPS_MAX_TTL_SECONDS: "1000",
        YAAPS_MIN_TTL_SECONDS: "200",
      }),
    ).toThrow("minimum <= default <= maximum");
    expect(() =>
      loadConfiguration({ YAAPS_CLEANUP_INTERVAL_SECONDS: "30" }),
    ).toThrow();
  });

  it("requires HTTPS for non-local origins and a strong bootstrap secret", () => {
    expect(() =>
      loadConfiguration({ YAAPS_PUBLIC_ORIGIN: "http://share.yaaps.net" }),
    ).toThrow();
    expect(() =>
      loadConfiguration({ YAAPS_BOOTSTRAP_SECRET: "too-short" }),
    ).toThrow();
  });

  it("derives production cookie and RP settings from the final origin", () => {
    expect(
      loadConfiguration({
        YAAPS_BOOTSTRAP_SECRET: "a".repeat(32),
        YAAPS_PUBLIC_ORIGIN: "https://share.yaaps.net",
      }),
    ).toMatchObject({
      bootstrapSecret: "a".repeat(32),
      publicOrigin: "https://share.yaaps.net",
      rpId: "share.yaaps.net",
      secureCookies: true,
    });
  });
});
