import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  healthResponseSchema,
  publicErrorSchema,
  publicServiceMetadataSchema,
  readinessResponseSchema,
} from "@yaaps/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication } from "./app.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-server-test-"));
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

describe("foundation server", () => {
  it("serves stable health and public metadata contracts", async () => {
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory(),
      version: "1.2.3-test",
    });

    const health = await application.inject({ method: "GET", url: "/healthz" });
    const metadata = await application.inject({
      method: "GET",
      url: "/api/meta",
    });

    expect(health.statusCode).toBe(200);
    expect(healthResponseSchema.parse(health.json())).toMatchObject({
      status: "ok",
      version: "1.2.3-test",
    });
    expect(metadata.statusCode).toBe(200);
    expect(publicServiceMetadataSchema.parse(metadata.json()).stage).toBe(
      "foundation",
    );

    await application.close();
  });

  it("publishes an OpenAPI 3.1 document for the agent-facing API", async () => {
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory(),
      publicOrigin: "https://share.example.com",
      version: "1.2.3-test",
    });

    const response = await application.inject({
      method: "GET",
      url: "/openapi.json",
    });
    const document = response.json();

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(document).toMatchObject({
      info: { title: "YAAPS API", version: "1.2.3-test" },
      openapi: "3.1.0",
      servers: [{ url: "https://share.example.com" }],
    });
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/api/drafts",
        "/auth/device-connections",
        "/auth/device-connections/token",
        "/api/drafts/{draftId}",
        "/api/drafts/{draftId}/versions",
        "/d/{draftId}",
      ]),
    );
    expect(document.paths["/api/drafts"].post.security).toEqual([
      { bearerAuth: [] },
    ]);
    expect(document.paths["/api/drafts"].post.parameters).toContainEqual(
      expect.objectContaining({
        name: "resourcePolicy",
        schema: expect.objectContaining({
          default: "connected",
          enum: ["isolated", "connected"],
        }),
      }),
    );
    expect(
      document.components.schemas.PublishDraftResponse.properties.version
        .properties.resourcePolicy.enum,
    ).toEqual(["isolated", "connected"]);
    expect(document.paths["/auth/device-connections"].post.security).toBe(
      undefined,
    );
    expect(
      Object.keys(document.paths).some(
        (route) =>
          route.startsWith("/auth") &&
          !route.startsWith("/auth/device-connections"),
      ),
    ).toBe(false);

    await application.close();
  });

  it("serves the Scalar API reference entirely from local assets", async () => {
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory(),
    });

    const response = await application.inject({
      method: "GET",
      url: "/docs/reference",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    const csp = response.headers["content-security-policy"];
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("script-src-attr 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(response.body).not.toMatch(/(?:https?:)?\/\//u);
    expect(response.body).not.toMatch(/<script(?![^>]*\ssrc=)/u);
    // Scalar auto-mounts a second, default-configured instance on this id.
    expect(response.body).not.toContain('id="api-reference"');

    for (const assetUrl of [
      "/docs/assets/shell.css",
      "/docs/assets/scalar-api-reference.js",
      "/docs/assets/scalar-initializer.js",
    ]) {
      expect(response.body).toContain(assetUrl);
      const asset = await application.inject({ method: "GET", url: assetUrl });
      expect(asset.statusCode).toBe(200);
      expect(asset.body.length).toBeGreaterThan(20);
    }

    const bundle = await application.inject({
      method: "GET",
      url: "/docs/assets/scalar-api-reference.js",
    });
    expect(bundle.headers["content-type"]).toContain("text/javascript");
    expect(bundle.body).toContain("createApiReference");

    const initializer = await application.inject({
      method: "GET",
      url: "/docs/assets/scalar-initializer.js",
    });
    expect(initializer.body).toContain('url: "/openapi.json"');
    expect(initializer.body).toContain("withDefaultFonts: false");
    expect(initializer.body).toContain("telemetry: false");
    expect(initializer.body).toContain("agent: { disabled: true }");
    expect(initializer.body).toContain("persistAuth: false");
    expect(initializer.body).not.toMatch(/(?:https?:)?\/\//u);

    for (const retiredUrl of ["/docs/swagger", "/docs/redoc"]) {
      const retired = await application.inject({
        method: "GET",
        url: retiredUrl,
      });
      expect(retired.statusCode).toBe(301);
      expect(retired.headers.location).toBe("/docs/reference");
    }

    const ordinaryRoute = await application.inject({
      method: "GET",
      url: "/healthz",
    });
    expect(ordinaryRoute.headers["content-security-policy"]).toContain(
      "style-src 'self'",
    );
    expect(ordinaryRoute.headers["content-security-policy"]).not.toContain(
      "style-src 'self' 'unsafe-inline'",
    );

    await application.close();
  });

  it("serves the dashboard application at every public page route", async () => {
    const dataDirectory = await temporaryDirectory();
    const dashboardDirectory = await temporaryDirectory();
    await mkdir(path.join(dashboardDirectory, "assets"));
    await writeFile(
      path.join(dashboardDirectory, "index.html"),
      "<!doctype html><title>YAAPS dashboard</title>",
      "utf8",
    );
    for (const imageName of ["og-site.png", "og-report.png"]) {
      await writeFile(
        path.join(dashboardDirectory, imageName),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      );
    }
    const application = await buildApplication({
      dashboardDirectory,
      dataDirectory,
    });

    for (const url of [
      "/connect",
      "/docs",
      "/login",
      "/dashboard/connect/approve",
      "/dashboard/settings",
      "/dashboard/admin",
    ]) {
      const response = await application.inject({ method: "GET", url });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toContain("YAAPS dashboard");
      expect(response.headers["x-robots-tag"]).toBeUndefined();
    }

    for (const imageName of ["og-site.png", "og-report.png"]) {
      const image = await application.inject({
        method: "GET",
        url: `/${imageName}`,
      });

      expect(image.statusCode).toBe(200);
      expect(image.headers["content-type"]).toBe("image/png");
      expect(image.headers["cross-origin-resource-policy"]).toBe(
        "cross-origin",
      );
    }

    const robots = await application.inject({
      method: "GET",
      url: "/robots.txt",
    });
    expect(robots.statusCode).toBe(200);
    expect(robots.body).toBe("User-agent: *\nDisallow: /d/\n");

    const retiredConnectRoute = await application.inject({
      method: "GET",
      url: "/dashboard/connect",
    });
    expect(retiredConnectRoute.statusCode).toBe(404);

    await application.close();
  });

  it("checks that the data directory is writable", async () => {
    const directory = await temporaryDirectory();
    const application = await buildApplication({ dataDirectory: directory });

    const response = await application.inject({
      method: "GET",
      url: "/readyz",
    });

    expect(response.statusCode).toBe(200);
    expect(readinessResponseSchema.parse(response.json()).checks).toEqual({
      dataDirectory: "ok",
    });
    await expect(access(path.join(directory, "yaaps.sqlite"))).resolves.toBe(
      undefined,
    );

    await application.close();
  });

  it("fails readiness without leaking the filesystem path", async () => {
    const directory = await temporaryDirectory();
    const filePath = path.join(directory, "not-a-directory");
    await writeFile(filePath, "occupied", "utf8");
    const application = await buildApplication({ dataDirectory: filePath });

    const response = await application.inject({
      method: "GET",
      url: "/readyz",
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain(filePath);
    expect(readinessResponseSchema.parse(response.json()).status).toBe(
      "not_ready",
    );

    await application.close();
  });

  it("returns a stable public error for unknown routes", async () => {
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory(),
    });

    const response = await application.inject({
      method: "GET",
      url: "/missing",
    });

    expect(response.statusCode).toBe(404);
    expect(publicErrorSchema.parse(response.json()).error.code).toBe(
      "NOT_FOUND",
    );

    await application.close();
  });
});
