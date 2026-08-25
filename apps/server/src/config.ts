import path from "node:path";

import {
  RETENTION_LIMITS_SECONDS,
  type RetentionPolicy,
} from "@yaaps/contracts";
import { z } from "zod";

const portSchema = z.coerce.number().int().min(1).max(65_535);
const originSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || url.hostname === "localhost";
}, "The public origin must use HTTPS except on localhost.");
const rpIdSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !value.includes(":") && !value.includes("/"),
    "The WebAuthn RP ID must be a hostname.",
  );
const bootstrapSecretSchema = z.string().min(32).optional();

function parseTrustProxy(raw: string | undefined): boolean | string | string[] {
  if (raw === undefined || raw.trim() === "") return false;
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.includes(",")) {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }
  return value;
}
const retentionSchema = z
  .object({
    defaultTtlSeconds: z.coerce.number().int().positive().safe(),
    maximumTtlSeconds: z.coerce.number().int().positive().safe(),
    minimumTtlSeconds: z.coerce.number().int().positive().safe(),
  })
  .refine(
    (value) =>
      value.minimumTtlSeconds <= value.defaultTtlSeconds &&
      value.defaultTtlSeconds <= value.maximumTtlSeconds,
    "Retention TTLs must satisfy minimum <= default <= maximum.",
  );

export interface ServerConfiguration {
  cleanupIntervalSeconds: number;
  bootstrapSecret?: string;
  dashboardDirectory: string;
  dataDirectory: string;
  skillDistributionDirectory: string;
  host: string;
  port: number;
  publicOrigin: string;
  openRegistration: boolean;
  retention: RetentionPolicy;
  rpId: string;
  secureCookies: boolean;
  trustProxy: boolean | string | string[];
}

export function loadConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfiguration {
  const publicOrigin = originSchema.parse(
    environment.YAAPS_PUBLIC_ORIGIN ?? "http://localhost:3000",
  );
  const originUrl = new URL(publicOrigin);
  const retention = retentionSchema.parse({
    defaultTtlSeconds:
      environment.YAAPS_DEFAULT_TTL_SECONDS ?? RETENTION_LIMITS_SECONDS.default,
    maximumTtlSeconds:
      environment.YAAPS_MAX_TTL_SECONDS ?? RETENTION_LIMITS_SECONDS.maximum,
    minimumTtlSeconds:
      environment.YAAPS_MIN_TTL_SECONDS ?? RETENTION_LIMITS_SECONDS.minimum,
  });
  const cleanupIntervalSeconds = z.coerce
    .number()
    .int()
    .min(60)
    .default(300)
    .parse(environment.YAAPS_CLEANUP_INTERVAL_SECONDS);
  return {
    cleanupIntervalSeconds,
    bootstrapSecret: bootstrapSecretSchema.parse(
      environment.YAAPS_BOOTSTRAP_SECRET || undefined,
    ),
    dashboardDirectory:
      environment.YAAPS_DASHBOARD_DIR ??
      path.resolve(process.cwd(), "apps/dashboard/dist"),
    dataDirectory:
      environment.YAAPS_DATA_DIR ?? path.resolve(process.cwd(), ".local-data"),
    skillDistributionDirectory:
      environment.YAAPS_SKILL_DISTRIBUTION_DIR ??
      path.resolve(process.cwd(), "apps/server/dist/skill-distribution"),
    host: environment.YAAPS_HOST ?? "127.0.0.1",
    port: portSchema.parse(environment.YAAPS_PORT ?? "3000"),
    publicOrigin,
    retention,
    openRegistration: ["1", "true"].includes(
      (environment.YAAPS_OPEN_REGISTRATION ?? "").trim().toLowerCase(),
    ),
    rpId: rpIdSchema.parse(environment.YAAPS_RP_ID ?? originUrl.hostname),
    secureCookies: originUrl.protocol === "https:",
    trustProxy: parseTrustProxy(environment.YAAPS_TRUST_PROXY),
  };
}
