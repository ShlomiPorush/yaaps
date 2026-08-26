import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import {
  DOCUMENT_LIMITS,
  FOUNDATION_VERSION,
  PRODUCT_NAME,
  RETENTION_LIMITS_SECONDS,
  type ReadinessResponse,
  type RetentionPolicy,
} from "@yaaps/contracts";
import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import { sql } from "kysely";
import { ZodError } from "zod";

import {
  AuthenticationConflictError,
  AuthenticationError,
  AuthenticationRepository,
  AuthorizationError,
} from "./auth/repository.js";
import { registerApiDocumentationRoutes } from "./api-docs/routes.js";
import { registerDeviceConnectionRoutes } from "./auth/device-connection-routes.js";
import {
  DeviceConnectionConflictError,
  DeviceConnectionDecidedError,
  DeviceConnectionExpiredError,
  DeviceConnectionNotFoundError,
  DeviceConnectionRepository,
} from "./auth/device-connections.js";
import { registerAuthenticationRoutes } from "./auth/routes.js";
import { WebAuthnService } from "./auth/webauthn-service.js";
import { registerDashboardManagementRoutes } from "./dashboard/routes.js";
import { registerDistributionRoutes } from "./downloads/routes.js";
import { createOpenApiDocument } from "./openapi.js";
import { HtmlPolicyError } from "./reports/html-policy.js";
import {
  InvalidTtlError,
  registerReportApiRoutes,
} from "./reports/api-routes.js";
import { registerPublicReportRoutes } from "./reports/routes.js";
import { RetentionCleanupWorker } from "./retention/cleanup-worker.js";
import { HtmlBlobStore } from "./storage/blob-store.js";
import { openDatabase, type YaapsDatabase } from "./storage/database.js";
import { DraftNotFoundError, DraftStorage } from "./storage/draft-storage.js";

export interface YaapsDataLayer {
  authentication: AuthenticationRepository;
  blobs: HtmlBlobStore;
  database: YaapsDatabase;
  drafts: DraftStorage;
}

declare module "fastify" {
  interface FastifyInstance {
    yaapsData: YaapsDataLayer | null;
  }
}

export interface BuildApplicationOptions {
  authentication?: {
    bootstrapSecret?: string;
    openRegistration?: boolean;
    origin: string;
    rpId: string;
    secureCookies: boolean;
  };
  dashboardDirectory?: string;
  skillDistributionDirectory?: string;
  cleanupIntervalSeconds?: number;
  dataDirectory: string;
  logger?: boolean;
  publicOrigin?: string;
  retention?: RetentionPolicy;
  trustProxy?: boolean | string | string[];
  version?: string;
}

async function probeDataDirectory(dataDirectory: string): Promise<boolean> {
  const probePath = path.join(
    dataDirectory,
    `.yaaps-readiness-${process.pid}-${Date.now()}-${randomUUID()}`,
  );

  try {
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(probePath, "ready", { encoding: "utf8", flag: "wx" });
    await unlink(probePath);
    return true;
  } catch {
    await unlink(probePath).catch(() => undefined);
    return false;
  }
}

function configureRequestErrors(application: FastifyInstance): void {
  application.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "INVALID_REQUEST", message: "The request is invalid." },
      });
    }
    if (error instanceof AuthenticationError) {
      return reply.code(401).send({
        error: {
          code: "AUTHENTICATION_FAILED",
          message: "Authentication failed or expired.",
        },
      });
    }
    if (error instanceof AuthorizationError) {
      return reply.code(403).send({
        error: {
          code: "FORBIDDEN",
          message: "You are not allowed to perform this operation.",
        },
      });
    }
    if (error instanceof AuthenticationConflictError) {
      return reply.code(409).send({
        error: { code: "AUTH_CONFLICT", message: error.message },
      });
    }
    if (error instanceof DeviceConnectionNotFoundError) {
      return reply.code(404).send({
        error: {
          code: "DEVICE_CONNECTION_NOT_FOUND",
          message: "The device connection was not found.",
        },
      });
    }
    if (error instanceof DeviceConnectionExpiredError) {
      return reply.code(410).send({
        error: {
          code: "DEVICE_CONNECTION_EXPIRED",
          message:
            "The device connection has expired. Start again from the CLI.",
        },
      });
    }
    if (error instanceof DeviceConnectionDecidedError) {
      return reply.code(409).send({
        error: {
          code: "DEVICE_CONNECTION_DECIDED",
          message: "The device connection was already approved or denied.",
        },
      });
    }
    if (error instanceof DeviceConnectionConflictError) {
      return reply.code(409).send({
        error: {
          code: "DEVICE_CONNECTION_CONFLICT",
          message: "The proposed API key is already registered.",
        },
      });
    }
    if (error instanceof HtmlPolicyError) {
      return reply.code(400).send({
        error: {
          code: "HTML_POLICY_VIOLATION",
          message: "The HTML document violates the publishing policy.",
        },
      });
    }
    if (error instanceof DraftNotFoundError) {
      return reply.code(404).send({
        error: {
          code: "DRAFT_NOT_FOUND",
          message: "The draft was not found.",
        },
      });
    }
    if (error instanceof InvalidTtlError) {
      return reply.code(400).send({
        error: {
          code: "INVALID_TTL",
          message: `TTL must be between ${error.retention.minimumTtlSeconds} and ${error.retention.maximumTtlSeconds} seconds.`,
        },
      });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 413
    ) {
      return reply.code(413).send({
        error: {
          code: "HTML_TOO_LARGE",
          message: "The HTML document exceeds the configured size limit.",
        },
      });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 415
    ) {
      return reply.code(415).send({
        error: {
          code: "UNSUPPORTED_MEDIA_TYPE",
          message: "Report uploads require text/html content.",
        },
      });
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 429
    ) {
      return reply.code(429).send({
        error: {
          code: "RATE_LIMITED",
          message: "Too many attempts. Try again later.",
        },
      });
    }
    application.log.error({ err: error }, "Request failed.");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
      },
    });
  });

  application.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
      },
    }),
  );
}

export async function buildApplication(
  options: BuildApplicationOptions,
): Promise<FastifyInstance> {
  const version = options.version ?? FOUNDATION_VERSION;
  const retention = options.retention ?? {
    defaultTtlSeconds: RETENTION_LIMITS_SECONDS.default,
    maximumTtlSeconds: RETENTION_LIMITS_SECONDS.maximum,
    minimumTtlSeconds: RETENTION_LIMITS_SECONDS.minimum,
  };
  const publicOrigin =
    options.publicOrigin ??
    options.authentication?.origin ??
    "http://localhost:3000";
  const serverOptions: FastifyServerOptions = {
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? false,
  };
  const application = Fastify(serverOptions);
  let cleanupWorker: RetentionCleanupWorker | null = null;
  application.decorate("yaapsData", null);
  configureRequestErrors(application);

  if (await probeDataDirectory(options.dataDirectory)) {
    let openedDatabase: YaapsDatabase | null = null;
    try {
      const database = await openDatabase(options.dataDirectory);
      openedDatabase = database;
      const blobs = new HtmlBlobStore(options.dataDirectory);
      await blobs.initialize();
      const drafts = new DraftStorage(database.connection, blobs);
      const authentication = new AuthenticationRepository(database.connection);
      await blobs.cleanupTemporaryFiles();
      await drafts.cleanupOrphanedBlobs();
      application.yaapsData = { authentication, blobs, database, drafts };
      cleanupWorker = new RetentionCleanupWorker(
        drafts,
        options.cleanupIntervalSeconds ?? 300,
        application.log,
      );
      cleanupWorker.start();
    } catch (error) {
      application.log.error({ error }, "YAAPS data initialization failed.");
      // onClose only closes a connection reachable via yaapsData; if init threw
      // before that assignment, close the opened connection here to avoid a leak.
      if (!application.yaapsData && openedDatabase) {
        await openedDatabase.connection.destroy().catch(() => undefined);
      }
    }
  }

  application.addHook("onClose", async () => {
    await cleanupWorker?.stop();
    await application.yaapsData?.database.connection.destroy();
  });

  await application.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        baseUri: ["'none'"],
        connectSrc: ["'self'"],
        defaultSrc: ["'self'"],
        fontSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  // Published reports are user content and stay out of search indexes (their
  // routes send their own X-Robots-Tag); the product site itself is indexable.
  application.get("/robots.txt", async (_request, reply) =>
    reply
      .type("text/plain; charset=utf-8")
      .send("User-agent: *\nDisallow: /d/\n"),
  );

  await registerDistributionRoutes(application, {
    directory: options.skillDistributionDirectory,
    publicOrigin,
  });

  if (application.yaapsData) {
    const authentication = options.authentication ?? {
      origin: "http://localhost:3000",
      rpId: "localhost",
      secureCookies: false,
    };
    // Registered here, not inside a route module: per-route rateLimit configs
    // on the device-connection routes must not depend on which route module
    // happens to register the plugin first.
    await application.register(cookie);
    await application.register(rateLimit, { global: false });
    await registerAuthenticationRoutes(application, {
      openRegistration: authentication.openRegistration ?? false,
      repository: application.yaapsData.authentication,
      secureCookies: authentication.secureCookies,
      service: new WebAuthnService(application.yaapsData.authentication, {
        bootstrapSecret: authentication.bootstrapSecret,
        openRegistration: authentication.openRegistration ?? false,
        origin: authentication.origin,
        rpId: authentication.rpId,
      }),
    });
    await registerDeviceConnectionRoutes(application, {
      authentication: application.yaapsData.authentication,
      connections: new DeviceConnectionRepository(
        application.yaapsData.database.connection,
      ),
      publicOrigin,
      secureCookies: authentication.secureCookies,
    });
    await registerDashboardManagementRoutes(application, {
      authentication: application.yaapsData.authentication,
      drafts: application.yaapsData.drafts,
      publicOrigin,
      retention,
      secureCookies: authentication.secureCookies,
    });
    await registerPublicReportRoutes(application, {
      drafts: application.yaapsData.drafts,
      publicOrigin,
    });
    await registerReportApiRoutes(application, {
      authentication: application.yaapsData.authentication,
      drafts: application.yaapsData.drafts,
      publicOrigin,
      retention,
    });
  }

  application.get("/healthz", async () => ({
    name: PRODUCT_NAME,
    status: "ok" as const,
    version,
  }));

  application.get("/readyz", async (_request, reply) => {
    let databaseReady = false;
    if (application.yaapsData) {
      try {
        await sql`select 1`.execute(application.yaapsData.database.connection);
        databaseReady = true;
      } catch {
        databaseReady = false;
      }
    }
    const ready =
      databaseReady && (await probeDataDirectory(options.dataDirectory));
    const response: ReadinessResponse = {
      checks: { dataDirectory: ready ? "ok" : "failed" },
      name: PRODUCT_NAME,
      status: ready ? "ready" : "not_ready",
      version,
    };

    return reply.code(ready ? 200 : 503).send(response);
  });

  application.get("/api/meta", async () => ({
    limits: {
      defaultTtlSeconds: retention.defaultTtlSeconds,
      maximumHtmlBytes: DOCUMENT_LIMITS.maximumHtmlBytes,
      maximumTtlSeconds: retention.maximumTtlSeconds,
      minimumTtlSeconds: retention.minimumTtlSeconds,
    },
    name: PRODUCT_NAME,
    stage: "foundation" as const,
  }));

  application.get("/openapi.json", async (_request, reply) =>
    reply.type("application/json").send(
      createOpenApiDocument({
        publicOrigin,
        retention,
        version,
      }),
    ),
  );

  await registerApiDocumentationRoutes(application);

  if (options.dashboardDirectory) {
    const assetsDirectory = path.join(options.dashboardDirectory, "assets");
    const indexPath = path.join(options.dashboardDirectory, "index.html");

    try {
      await access(indexPath);
      const indexDocument = await readFile(indexPath, "utf8");

      await application.register(fastifyStatic, {
        prefix: "/assets/",
        root: assetsDirectory,
      });

      // Share-preview images referenced by og:image live at the site root.
      // Link-preview tools embed them cross-origin in a browser, so helmet's
      // default same-origin Cross-Origin-Resource-Policy must be relaxed here.
      for (const imageName of ["og-site.png", "og-report.png"]) {
        try {
          const imageBody = await readFile(
            path.join(options.dashboardDirectory, imageName),
          );
          application.get(`/${imageName}`, async (_request, reply) =>
            reply
              .type("image/png")
              .header("cache-control", "public, max-age=86400")
              .header("cross-origin-resource-policy", "cross-origin")
              .send(imageBody),
          );
        } catch {
          application.log.warn(
            { imageName },
            "Share-preview image is missing from the dashboard build.",
          );
        }
      }

      const sendDashboard = async (
        _request: unknown,
        reply: { type: (value: string) => { send: (body: string) => unknown } },
      ) => reply.type("text/html; charset=utf-8").send(indexDocument);

      application.get("/", sendDashboard);
      application.get("/connect", sendDashboard);
      application.get("/login", sendDashboard);
      application.get("/dashboard", sendDashboard);
      application.get("/dashboard/connect/approve", sendDashboard);
      application.get("/dashboard/settings", sendDashboard);
      application.get("/dashboard/admin", sendDashboard);
      application.get("/docs", sendDashboard);
    } catch {
      application.log.warn(
        { dashboardDirectory: options.dashboardDirectory },
        "Dashboard build is unavailable; API and health routes remain active.",
      );
    }
  }

  return application;
}
