import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import type { FastifyInstance, FastifyReply } from "fastify";

const require = createRequire(import.meta.url);
const externalRedocLogo = "https://cdn.redoc.ly/redoc/logo-mini.svg";

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
:root { color-scheme: light; font-family: system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: #17202a; }
.docs-bar {
  align-items: center;
  background: #17202a;
  color: #fff;
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  justify-content: space-between;
  min-height: 3.5rem;
  padding: .75rem clamp(1rem, 3vw, 2rem);
}
.docs-bar strong { letter-spacing: .04em; }
.docs-bar nav { display: flex; flex-wrap: wrap; gap: 1rem; }
.docs-bar a { color: #fff; font-weight: 700; text-decoration: none; }
.docs-bar a:hover, .docs-bar a:focus-visible { text-decoration: underline; }
#swagger-ui, #redoc-container { min-height: calc(100vh - 3.5rem); }
.loading { padding: 2rem; }
`;

const swaggerInitializer = `
globalThis.addEventListener("load", () => {
  globalThis.ui = SwaggerUIBundle({
    deepLinking: true,
    displayRequestDuration: true,
    dom_id: "#swagger-ui",
    persistAuthorization: false,
    tryItOutEnabled: false,
    url: "/openapi.json"
  });
});
`;

const redocInitializer = `
globalThis.addEventListener("load", () => {
  Redoc.init("/openapi.json", {
    hideDownloadButtons: false,
    nativeScrollbars: true,
    theme: {
      typography: {
        fontFamily: "system-ui, sans-serif",
        headings: { fontFamily: "system-ui, sans-serif" },
        code: { fontFamily: "monospace" }
      }
    }
  }, document.getElementById("redoc-container"));
});
`;

const redocLogo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" role="img" aria-label="ReDoc">
  <rect width="48" height="48" rx="8" fill="#17202a"/>
  <path d="M13 12h12c7 0 11 4 11 10 0 4-2 7-6 9l7 9h-9l-6-8h-1v8h-8V12zm8 7v7h4c2 0 3-1 3-4 0-2-1-3-3-3h-4z" fill="#fff"/>
</svg>`;

function pageShell(options: {
  body: string;
  rendererName: string;
  scripts: string[];
  stylesheets?: string[];
}): string {
  const stylesheets = (options.stylesheets ?? [])
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join("\n    ");
  const scripts = options.scripts
    .map((src) => `<script src="${src}" defer></script>`)
    .join("\n    ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>YAAPS API - ${options.rendererName}</title>
    <link rel="stylesheet" href="/docs/assets/shell.css">
    ${stylesheets}
    ${scripts}
  </head>
  <body>
    <header class="docs-bar">
      <strong>YAAPS API</strong>
      <nav aria-label="API documentation">
        <a href="/docs">Guide</a>
        <a href="/docs/swagger">Swagger UI</a>
        <a href="/docs/redoc">ReDoc</a>
        <a href="/openapi.json">OpenAPI 3.1</a>
      </nav>
    </header>
    ${options.body}
  </body>
</html>`;
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
  const [swaggerBundle, swaggerStyles, redocBundleSource] = await Promise.all([
    readFile(require.resolve("swagger-ui-dist/swagger-ui-bundle.js")),
    readFile(require.resolve("swagger-ui-dist/swagger-ui.css")),
    readFile(require.resolve("redoc/bundles/redoc.standalone.js")),
  ]);
  const redocBundle = Buffer.from(
    redocBundleSource
      .toString("utf8")
      .replaceAll(externalRedocLogo, "/docs/assets/redoc-logo.svg"),
  );

  const swaggerPage = pageShell({
    body: '<div id="swagger-ui"><p class="loading">Loading Swagger UI...</p></div>',
    rendererName: "Swagger UI",
    scripts: [
      "/docs/assets/swagger-ui-bundle.js",
      "/docs/assets/swagger-initializer.js",
    ],
    stylesheets: ["/docs/assets/swagger-ui.css"],
  });
  const redocPage = pageShell({
    body: '<div id="redoc-container"><p class="loading">Loading ReDoc...</p></div>',
    rendererName: "ReDoc",
    scripts: [
      "/docs/assets/redoc.standalone.js",
      "/docs/assets/redoc-initializer.js",
    ],
  });

  application.get("/docs/swagger", async (_request, reply) =>
    sendPage(reply, swaggerPage),
  );
  application.get("/docs/redoc", async (_request, reply) =>
    sendPage(reply, redocPage),
  );
  application.get("/docs/assets/shell.css", async (_request, reply) =>
    sendAsset(reply, shellStyles, "text/css; charset=utf-8"),
  );
  application.get("/docs/assets/swagger-ui.css", async (_request, reply) =>
    sendAsset(reply, swaggerStyles, "text/css; charset=utf-8"),
  );
  application.get(
    "/docs/assets/swagger-ui-bundle.js",
    async (_request, reply) =>
      sendAsset(reply, swaggerBundle, "text/javascript; charset=utf-8"),
  );
  application.get(
    "/docs/assets/swagger-initializer.js",
    async (_request, reply) =>
      sendAsset(reply, swaggerInitializer, "text/javascript; charset=utf-8"),
  );
  application.get("/docs/assets/redoc.standalone.js", async (_request, reply) =>
    sendAsset(reply, redocBundle, "text/javascript; charset=utf-8"),
  );
  application.get(
    "/docs/assets/redoc-initializer.js",
    async (_request, reply) =>
      sendAsset(reply, redocInitializer, "text/javascript; charset=utf-8"),
  );
  application.get("/docs/assets/redoc-logo.svg", async (_request, reply) =>
    sendAsset(reply, redocLogo, "image/svg+xml; charset=utf-8"),
  );
}
