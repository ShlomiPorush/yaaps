import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app.js";
import {
  CONNECTED_REPORT_CONTENT_SECURITY_POLICY,
  REPORT_CONTENT_SECURITY_POLICY,
} from "./routes.js";

let application: FastifyInstance;
let directory: string;

function html(body: string): Buffer {
  return Buffer.from(
    `<!doctype html><html><head><title>Report</title></head><body>${body}</body></html>`,
  );
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "yaaps-report-routes-test-"));
  application = await buildApplication({ dataDirectory: directory });
  await application.yaapsData?.database.connection
    .insertInto("users")
    .values({
      created_at: new Date().toISOString(),
      disabled_at: null,
      display_name: "Report owner",
      id: "report-owner",
      role: "user",
      status: "active",
      webauthn_user_id: null,
    })
    .execute();
});

afterEach(async () => {
  await application.close();
  await rm(directory, { force: true, recursive: true });
});

describe("public report routes", () => {
  it("serves canonical and numbered versions with server-controlled isolation", async () => {
    const firstHtml = html("<h1>First immutable version</h1>");
    const latestHtml = html("<h1>Latest version</h1>");
    const draft = await application.yaapsData!.drafts.createDraft({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      html: firstHtml,
      ownerId: "report-owner",
    });
    await application.yaapsData!.drafts.addVersion({
      draftId: draft.draftId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      html: latestHtml,
      ownerId: "report-owner",
    });

    const canonical = await application.inject({
      method: "GET",
      url: `/d/${draft.draftId}`,
    });
    const version = await application.inject({
      method: "GET",
      url: `/d/${draft.draftId}/v/1`,
    });

    expect(canonical.statusCode).toBe(200);
    expect(canonical.body).toContain("<h1>Latest version</h1>");
    expect(version.statusCode).toBe(200);
    expect(version.body).toContain("<h1>First immutable version</h1>");
    // Share-preview metadata is injected at serve time so link crawlers show
    // the branded card instead of scraping report text.
    expect(canonical.body).toContain('property="og:image"');
    expect(canonical.body).toContain("/og-report.png");
    expect(canonical.body).toContain('name="twitter:card"');
    expect(canonical.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(canonical.headers["content-security-policy"]).toBe(
      REPORT_CONTENT_SECURITY_POLICY,
    );
    expect(canonical.headers["content-security-policy"]).toContain(
      "allow-popups",
    );
    expect(canonical.headers["content-security-policy"]).not.toContain(
      "allow-scripts",
    );
    expect(canonical.headers["content-security-policy"]).not.toContain(
      "allow-same-origin",
    );
    expect(canonical.headers["cache-control"]).toBe("private, no-store");
    expect(canonical.headers["referrer-policy"]).toBe("no-referrer");
    expect(canonical.headers["x-content-type-options"]).toBe("nosniff");
    expect(canonical.headers["x-robots-tag"]).toContain("noindex");
    expect(canonical.headers["permissions-policy"]).toContain("camera=()");
  });

  it("serves each immutable version with its recorded resource-policy CSP", async () => {
    const first = await application.yaapsData!.drafts.createDraft({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      html: html('<a href="https://example.com">Source</a>'),
      ownerId: "report-owner",
    });
    await application.yaapsData!.drafts.addVersion({
      draftId: first.draftId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      html: html('<img src="https://cdn.example.com/chart.png">'),
      ownerId: "report-owner",
      resourcePolicy: "connected",
    });

    const latest = await application.inject({
      method: "GET",
      url: `/d/${first.draftId}`,
    });
    const original = await application.inject({
      method: "GET",
      url: `/d/${first.draftId}/v/1`,
    });

    expect(latest.headers["content-security-policy"]).toBe(
      CONNECTED_REPORT_CONTENT_SECURITY_POLICY,
    );
    expect(latest.headers["content-security-policy"]).toContain(
      "img-src data: https:",
    );
    expect(latest.headers["content-security-policy"]).toContain(
      "connect-src 'none'",
    );
    expect(original.headers["content-security-policy"]).toBe(
      REPORT_CONTENT_SECURITY_POLICY,
    );
  });

  it("injects the escaped draft title into the share-preview metadata", async () => {
    const hostileTitle = 'Weekly "report" <script>alert(1)</script>';
    const draft = await application.yaapsData!.drafts.createDraft({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      html: html("<p>Body</p>"),
      ownerId: "report-owner",
      title: hostileTitle,
    });

    const served = await application.inject({
      method: "GET",
      url: `/d/${draft.draftId}`,
    });

    expect(served.statusCode).toBe(200);
    expect(served.body).toContain(
      'content="Weekly &quot;report&quot; &lt;script&gt;alert(1)&lt;/script&gt;"',
    );
    expect(served.body).not.toContain("<script>alert(1)</script></head>");
    // A title-less draft falls back to the generic share title.
    const untitled = await application.yaapsData!.drafts.createDraft({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      html: html("<p>Body</p>"),
      ownerId: "report-owner",
    });
    const untitledServed = await application.inject({
      method: "GET",
      url: `/d/${untitled.draftId}`,
    });
    expect(untitledServed.body).toContain(
      'content="A report shared with YAAPS"',
    );
  });

  it("does not distinguish disabled, missing, or missing-version capability URLs", async () => {
    const draft = await application.yaapsData!.drafts.createDraft({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      html: html("<p>Private report metadata</p>"),
      ownerId: "report-owner",
      title: "Private report title",
    });
    const missingVersion = await application.inject({
      method: "GET",
      url: `/d/${draft.draftId}/v/99`,
    });
    await application
      .yaapsData!.database.connection.updateTable("drafts")
      .set({ status: "disabled" })
      .where("id", "=", draft.draftId)
      .executeTakeFirstOrThrow();
    const disabled = await application.inject({
      method: "GET",
      url: `/d/${draft.draftId}`,
    });
    const missing = await application.inject({
      method: "GET",
      url: `/d/${"A".repeat(32)}`,
    });

    expect(disabled.statusCode).toBe(404);
    expect(disabled.body).toBe(missing.body);
    expect(missingVersion.body).toBe(missing.body);
    expect(disabled.body).not.toContain("Private report");
    expect(disabled.json()).toEqual({
      error: {
        code: "REPORT_UNAVAILABLE",
        message: "This report is unavailable.",
      },
    });
  });

  it("returns an intentional expiry response without report metadata", async () => {
    const draft = await application.yaapsData!.drafts.createDraft({
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      html: html("<p>Expired private content</p>"),
      ownerId: "report-owner",
      title: "Expired private title",
    });

    const response = await application.inject({
      method: "GET",
      url: `/d/${draft.draftId}`,
    });

    expect(response.statusCode).toBe(410);
    expect(response.body).not.toContain("Expired private");
    expect(response.json()).toEqual({
      error: {
        code: "REPORT_EXPIRED",
        message: "This report has expired.",
      },
    });
  });

  it("fails safely when referenced immutable content is missing", async () => {
    const privateBody = "Content that must not leak from a failed read";
    const draft = await application.yaapsData!.drafts.createDraft({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      html: html(`<p>${privateBody}</p>`),
      ownerId: "report-owner",
      title: "Private missing-blob title",
    });
    await application.yaapsData!.blobs.remove(draft.blobKey);

    const response = await application.inject({
      method: "GET",
      url: `/d/${draft.draftId}`,
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
      },
    });
    expect(response.body).not.toContain(privateBody);
    expect(response.body).not.toContain(draft.blobKey);
    expect(response.body).not.toContain(directory);
  });
});
