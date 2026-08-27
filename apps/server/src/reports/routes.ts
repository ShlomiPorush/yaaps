import { draftIdSchema, type ReportResourcePolicy } from "@yaaps/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type {
  DraftStorage,
  PublicReportResolution,
} from "../storage/draft-storage.js";

export const ISOLATED_REPORT_CONTENT_SECURITY_POLICY = [
  "sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation",
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "img-src data:",
  "font-src data:",
  "style-src 'unsafe-inline'",
  "frame-ancestors 'none'",
].join("; ");

export const CONNECTED_REPORT_CONTENT_SECURITY_POLICY = [
  "sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation",
  "default-src 'none'",
  "script-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "img-src data: https:",
  "font-src data: https:",
  "style-src 'unsafe-inline' https:",
  "frame-ancestors 'none'",
].join("; ");

// Retain the original export for callers that mean the default policy.
export const REPORT_CONTENT_SECURITY_POLICY =
  ISOLATED_REPORT_CONTENT_SECURITY_POLICY;

const draftParametersSchema = z.object({
  draftId: draftIdSchema,
});

const versionParametersSchema = draftParametersSchema.extend({
  version: z.coerce.number().int().positive().safe(),
});

function applyReportHeaders(
  reply: FastifyReply,
  resourcePolicy: ReportResourcePolicy,
): void {
  void reply
    .header("Cache-Control", "private, no-store")
    .header(
      "Content-Security-Policy",
      resourcePolicy === "connected"
        ? CONNECTED_REPORT_CONTENT_SECURITY_POLICY
        : ISOLATED_REPORT_CONTENT_SECURITY_POLICY,
    )
    .header(
      "Permissions-Policy",
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
    )
    .header("Referrer-Policy", "no-referrer")
    .header("X-Content-Type-Options", "nosniff")
    .header(
      "X-Robots-Tag",
      "noindex, nofollow, noarchive, nosnippet, noimageindex",
    );
}

function unavailable(reply: FastifyReply) {
  return reply.code(404).send({
    error: {
      code: "REPORT_UNAVAILABLE",
      message: "This report is unavailable.",
    },
  });
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// Injected at serve time only: the stored document and its recorded sha256
// stay untouched. Link-preview crawlers otherwise scrape arbitrary report
// text, so every shared report presents the branded card instead.
function injectSharePreview(
  html: Buffer,
  title: string | null,
  publicOrigin: string,
): Buffer {
  const source = html.toString("utf8");
  const headMatch = /<head(?:\s[^>]*)?>/iu.exec(source);
  if (!headMatch || headMatch.index < 0) {
    return html;
  }
  const shareTitle = escapeAttribute(
    title?.trim() || "A report shared with YAAPS",
  );
  const imageUrl = `${publicOrigin.replace(/\/$/u, "")}/og-report.png`;
  const metadata = [
    `<meta property="og:title" content="${shareTitle}">`,
    '<meta property="og:description" content="A temporary report link shared with YAAPS.">',
    '<meta property="og:type" content="website">',
    `<meta property="og:image" content="${escapeAttribute(imageUrl)}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:image" content="${escapeAttribute(imageUrl)}">`,
  ].join("");
  const insertAt = headMatch.index + headMatch[0].length;
  return Buffer.from(
    `${source.slice(0, insertAt)}${metadata}${source.slice(insertAt)}`,
    "utf8",
  );
}

function sendResolution(
  reply: FastifyReply,
  resolution: PublicReportResolution,
  publicOrigin: string,
) {
  if (resolution.status === "unavailable") {
    return unavailable(reply);
  }
  if (resolution.status === "expired") {
    return reply.code(410).send({
      error: {
        code: "REPORT_EXPIRED",
        message: "This report has expired.",
      },
    });
  }

  applyReportHeaders(reply, resolution.resourcePolicy);
  return reply
    .type("text/html; charset=utf-8")
    .send(injectSharePreview(resolution.html, resolution.title, publicOrigin));
}

async function serveResolution(
  request: FastifyRequest,
  reply: FastifyReply,
  drafts: DraftStorage,
  draftId: string,
  resolution: PublicReportResolution,
  publicOrigin: string,
) {
  if (resolution.status === "available" && request.method === "GET") {
    try {
      await drafts.recordPublicView(draftId, resolution.versionNumber);
    } catch (error) {
      request.log.error(
        {
          draftId,
          err: error,
          event: "public_report_view_count_failed",
          versionNumber: resolution.versionNumber,
        },
        "Failed to record a public report view.",
      );
    }
  }
  return sendResolution(reply, resolution, publicOrigin);
}

export async function registerPublicReportRoutes(
  application: FastifyInstance,
  options: { drafts: DraftStorage; publicOrigin: string },
): Promise<void> {
  const publicOrigin = options.publicOrigin.replace(/\/$/u, "");
  application.get("/d/:draftId", async (request, reply) => {
    const { draftId } = draftParametersSchema.parse(request.params);
    return serveResolution(
      request,
      reply,
      options.drafts,
      draftId,
      await options.drafts.resolvePublic(draftId),
      publicOrigin,
    );
  });

  application.get("/d/:draftId/v/:version", async (request, reply) => {
    const { draftId, version } = versionParametersSchema.parse(request.params);
    return serveResolution(
      request,
      reply,
      options.drafts,
      draftId,
      await options.drafts.resolvePublic(draftId, version),
      publicOrigin,
    );
  });
}
