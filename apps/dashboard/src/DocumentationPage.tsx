import type { ReactNode } from "react";

import type { LocaleDocument } from "./localization.js";

interface DocumentationPageProps {
  copy: LocaleDocument;
}

const endpoints = [
  { description: "create", method: "POST", path: "/api/drafts" },
  { description: "list", method: "GET", path: "/api/drafts" },
  { description: "categories", method: "GET", path: "/api/categories" },
  { description: "inspect", method: "GET", path: "/api/drafts/{draftId}" },
  {
    description: "addVersion",
    method: "POST",
    path: "/api/drafts/{draftId}/versions",
  },
  {
    description: "versions",
    method: "GET",
    path: "/api/drafts/{draftId}/versions",
  },
  { description: "update", method: "PATCH", path: "/api/drafts/{draftId}" },
  { description: "delete", method: "DELETE", path: "/api/drafts/{draftId}" },
] as const;

function CodeBlock({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="code-block" dir="ltr">
      <div className="code-label">{label}</div>
      <pre>
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function DocumentationPage({ copy }: DocumentationPageProps) {
  return (
    <div className="docs-page">
      <section className="docs-hero" aria-labelledby="docs-heading">
        <div>
          <p className="eyebrow">{copy.docs.eyebrow}</p>
          <h1 id="docs-heading">{copy.docs.heading}</h1>
          <p className="intro">{copy.docs.intro}</p>
        </div>
        <div className="api-docs-links">
          <a className="openapi-card" href="/docs/swagger">
            <span className="openapi-mark" aria-hidden="true">
              SW
            </span>
            <span>
              <strong>{copy.docs.swaggerAction}</strong>
              <small>{copy.docs.swaggerText}</small>
            </span>
          </a>
          <a className="openapi-card" href="/docs/redoc">
            <span className="openapi-mark" aria-hidden="true">
              RD
            </span>
            <span>
              <strong>{copy.docs.redocAction}</strong>
              <small>{copy.docs.redocText}</small>
            </span>
          </a>
          <a className="openapi-card" href="/openapi.json">
            <span className="openapi-mark" aria-hidden="true">
              {"{}"}
            </span>
            <span>
              <strong>{copy.docs.openApiAction}</strong>
              <small>{copy.docs.openApiText}</small>
            </span>
          </a>
        </div>
      </section>

      <div className="docs-layout">
        <aside className="docs-toc">
          <strong>{copy.docs.tocLabel}</strong>
          <a href="#quick-start">{copy.docs.quickStartHeading}</a>
          <a href="#authentication">{copy.docs.authenticationHeading}</a>
          <a href="#endpoints">{copy.docs.endpointsHeading}</a>
          <a href="#limits">{copy.docs.limitsHeading}</a>
          <a href="#security">{copy.docs.securityHeading}</a>
        </aside>

        <div className="docs-content">
          <section id="quick-start" className="docs-section">
            <p className="eyebrow">01</p>
            <h2>{copy.docs.quickStartHeading}</h2>
            <p>{copy.docs.quickStartIntro}</p>
            <CodeBlock label="cURL">
              {`curl --fail-with-body \\
  --request POST \\
  --url "$YAAPS_API_URL/api/drafts?category=Weekly&title=Weekly%20report&ttlSeconds=86400&resourcePolicy=connected" \\
  --header "Authorization: Bearer $YAAPS_API_KEY" \\
  --header "Content-Type: text/html" \\
  --data-binary @report.html`}
            </CodeBlock>
            <h3>{copy.docs.responseHeading}</h3>
            <CodeBlock label="201 Created">
              {`{
  "draft": {
    "id": "8K2vM4...Qp",
    "publicUrl": "https://share.example.com/d/8K2vM4...Qp",
    "resourcePolicy": "connected",
    "status": "enabled",
    "latestVersionNumber": 1
  },
  "version": {
    "versionNumber": 1,
    "publicUrl": "https://share.example.com/d/8K2vM4...Qp/v/1",
    "resourcePolicy": "connected"
  }
}`}
            </CodeBlock>
          </section>

          <section id="authentication" className="docs-section">
            <p className="eyebrow">02</p>
            <h2>{copy.docs.authenticationHeading}</h2>
            <p>{copy.docs.authenticationText}</p>
            <CodeBlock label="Shell">
              {`export YAAPS_API_URL=https://share.example.com
export YAAPS_API_KEY=yaaps_...`}
            </CodeBlock>
            <CodeBlock label="HTTP">Authorization: Bearer yaaps_...</CodeBlock>
          </section>

          <section id="endpoints" className="docs-section">
            <p className="eyebrow">03</p>
            <h2>{copy.docs.endpointsHeading}</h2>
            <p>{copy.docs.endpointsIntro}</p>
            <div className="endpoint-list">
              {endpoints.map((endpoint) => (
                <article
                  className="endpoint-row"
                  key={`${endpoint.method}-${endpoint.path}`}
                >
                  <span
                    className={`method-badge ${endpoint.method.toLowerCase()}`}
                    dir="ltr"
                  >
                    {endpoint.method}
                  </span>
                  <div>
                    <code dir="ltr">{endpoint.path}</code>
                    <p>
                      {copy.docs.endpointDescriptions[endpoint.description]}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section id="limits" className="docs-section docs-split">
            <div>
              <p className="eyebrow">04</p>
              <h2>{copy.docs.limitsHeading}</h2>
              <ul className="docs-list">
                {copy.docs.limitsItems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="error-example">
              <h3>{copy.docs.errorHeading}</h3>
              <p>{copy.docs.errorText}</p>
              <CodeBlock label="400 Bad Request">
                {`{
  "error": {
    "code": "INVALID_TTL",
    "message": "TTL must be between 3600 and 2592000 seconds."
  }
}`}
              </CodeBlock>
            </div>
          </section>

          <section id="security" className="docs-section security-docs-card">
            <p className="eyebrow">05</p>
            <h2>{copy.docs.securityHeading}</h2>
            <p>{copy.docs.securityText}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
