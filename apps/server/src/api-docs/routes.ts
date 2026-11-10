import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyReply } from "fastify";

const require = createRequire(import.meta.url);

const documentationCsp = [
  "base-uri 'none'",
  "connect-src 'self'",
  "default-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "upgrade-insecure-requests",
  "worker-src 'self' blob:",
].join("; ");

const shellStyles = `
:root {
  color-scheme: light;
  font-family: system-ui, sans-serif;
}
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: #17202a; }
.docs-bar {
  align-items: center;
  background: #17202a;
  color: #fff;
  display: flex;
  gap: 1rem;
  height: 3.5rem;
  justify-content: space-between;
  padding: 0 clamp(1rem, 3vw, 2rem);
}
.docs-bar strong { letter-spacing: .04em; white-space: nowrap; }
.docs-bar nav { display: flex; gap: 1rem; overflow-x: auto; }
.docs-bar a { color: #fff; font-weight: 700; text-decoration: none; white-space: nowrap; }
.docs-bar a:hover, .docs-bar a:focus-visible { text-decoration: underline; }
#yaaps-api-reference { min-height: calc(100vh - 3.5rem); }
@media (max-width: 30rem) {
  .docs-bar, .docs-bar nav { gap: .75rem; }
  .docs-bar { font-size: .875rem; }
}
`;

// Every option keeps the page on local assets: no hosted fonts, telemetry, or
// AI agent, and credentials entered in the test-request client are not stored.
// The container must not use the id "api-reference": the Scalar bundle mounts
// a second instance with default options on that id, which loads hosted fonts.
const scalarInitializer = `
globalThis.addEventListener("load", () => {
  Scalar.createApiReference("#yaaps-api-reference", {
    agent: { disabled: true },
    persistAuth: false,
    showDeveloperTools: "never",
    telemetry: false,
    url: "/openapi.json",
    withDefaultFonts: false
  });
});
`;

const referencePage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>YAAPS API - Reference</title>
    <link rel="stylesheet" href="/docs/assets/shell.css">
    <script src="/docs/assets/scalar-api-reference.js" defer></script>
    <script src="/docs/assets/scalar-initializer.js" defer></script>
  </head>
  <body>
    <header class="docs-bar">
      <strong>YAAPS API</strong>
      <nav aria-label="API documentation">
        <a href="/docs">Guide</a>
        <a href="/docs/reference">API reference</a>
        <a href="/openapi.json">OpenAPI 3.1</a>
      </nav>
    </header>
    <div id="yaaps-api-reference"></div>
  </body>
</html>`;

// The build copies the Scalar browser bundle into dist/vendor (see
// scripts/copy-api-reference.mjs) because the package is a development
// dependency. Source runs (tsx, Vitest, Playwright) read it from the package.
async function readScalarBundle(): Promise<Buffer> {
  const modulePath = fileURLToPath(import.meta.url);
  if (modulePath.endsWith(".js")) {
    return readFile(
      path.join(
        path.dirname(modulePath),
        "..",
        "vendor",
        "scalar-api-reference.js",
      ),
    );
  }
  return readFile(
    path.join(
      path.dirname(require.resolve("@scalar/api-reference")),
      "browser",
      "standalone.js",
    ),
  );
}

function sendPage(reply: FastifyReply, body: string) {
  return reply
    .header("Cache-Control", "no-store")
    .header("Content-Security-Policy", documentationCsp)
    .type("text/html; charset=utf-8")
    .send(body);
}

function sendAsset(
  reply: FastifyReply,
  body: Buffer | string,
  contentType: string,
) {
  return reply
    .header("Cache-Control", "public, max-age=3600")
    .type(contentType)
    .send(body);
}

export async function registerApiDocumentationRoutes(
  application: FastifyInstance,
): Promise<void> {
  const scalarBundle = await readScalarBundle();

  application.get("/docs/reference", async (_request, reply) =>
    sendPage(reply, referencePage),
  );
  // Swagger UI and ReDoc lived at these paths; keep old links working.
  for (const retiredPath of ["/docs/swagger", "/docs/redoc"]) {
    application.get(retiredPath, async (_request, reply) =>
      reply.redirect("/docs/reference", 301),
    );
  }
  application.get("/docs/assets/shell.css", async (_request, reply) =>
    sendAsset(reply, shellStyles, "text/css; charset=utf-8"),
  );
  application.get(
    "/docs/assets/scalar-api-reference.js",
    async (_request, reply) =>
      sendAsset(reply, scalarBundle, "text/javascript; charset=utf-8"),
  );
  application.get(
    "/docs/assets/scalar-initializer.js",
    async (_request, reply) =>
      sendAsset(reply, scalarInitializer, "text/javascript; charset=utf-8"),
  );
}
