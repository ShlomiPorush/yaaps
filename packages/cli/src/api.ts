import {
  draftListResponseSchema,
  draftSummarySchema,
  draftVersionListResponseSchema,
  publishDraftResponseSchema,
  type DraftListResponse,
  type DraftStatus,
  type DraftSummary,
  type DraftVersionListResponse,
  type PublishDraftResponse,
} from "@yaaps/contracts";

import { raiseRequestError, requestUrl } from "./http.js";
import type { ResourcePolicy } from "./normalize.js";

interface Parser<T> {
  parse(value: unknown): T;
}

export interface YaapsCredentials {
  apiKey: string;
  apiUrl: string;
}

export interface PublishOptions {
  category?: string;
  draftId?: string;
  html: Uint8Array;
  resourcePolicy: ResourcePolicy;
  title?: string;
  ttlSeconds?: number;
}

async function request<T>(
  credentials: YaapsCredentials,
  route: string,
  init: RequestInit,
  parser: Parser<T> | undefined,
  fetchImplementation: typeof fetch,
): Promise<T> {
  const response = await fetchImplementation(
    requestUrl(credentials.apiUrl, route),
    {
      ...init,
      headers: {
        authorization: `Bearer ${credentials.apiKey}`,
        ...init.headers,
      },
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    await raiseRequestError(response);
  }
  if (parser === undefined) {
    return undefined as T;
  }
  return parser.parse(await response.json());
}

function publishRoute(options: PublishOptions): string {
  const path = options.draftId
    ? `/api/drafts/${options.draftId}/versions`
    : "/api/drafts";
  const query = new URLSearchParams();
  query.set("resourcePolicy", options.resourcePolicy);
  if (options.category !== undefined) query.set("category", options.category);
  if (options.title !== undefined) query.set("title", options.title);
  if (options.ttlSeconds !== undefined) {
    query.set("ttlSeconds", String(options.ttlSeconds));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return `${path}${suffix}`;
}

export async function publishReport(
  credentials: YaapsCredentials,
  options: PublishOptions,
  fetchImplementation: typeof fetch = fetch,
): Promise<PublishDraftResponse> {
  return request(
    credentials,
    publishRoute(options),
    {
      body: new Blob([Uint8Array.from(options.html)], {
        type: "text/html; charset=utf-8",
      }),
      headers: { "content-type": "text/html; charset=utf-8" },
      method: "POST",
    },
    publishDraftResponseSchema,
    fetchImplementation,
  );
}

export async function listDrafts(
  credentials: YaapsCredentials,
  selection: { category?: string; limit?: number; offset?: number } = {},
  fetchImplementation: typeof fetch = fetch,
): Promise<DraftListResponse> {
  const query = new URLSearchParams();
  if (selection.limit !== undefined) {
    query.set("limit", String(selection.limit));
  }
  if (selection.offset !== undefined) {
    query.set("offset", String(selection.offset));
  }
  if (selection.category !== undefined) {
    query.set("category", selection.category);
  }
  return request(
    credentials,
    `/api/drafts${query.size > 0 ? `?${query}` : ""}`,
    { method: "GET" },
    draftListResponseSchema,
    fetchImplementation,
  );
}

export async function getDraft(
  credentials: YaapsCredentials,
  draftId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<DraftSummary> {
  return request(
    credentials,
    `/api/drafts/${draftId}`,
    { method: "GET" },
    draftSummarySchema,
    fetchImplementation,
  );
}

export async function listDraftVersions(
  credentials: YaapsCredentials,
  draftId: string,
  pagination: { limit?: number; offset?: number } = {},
  fetchImplementation: typeof fetch = fetch,
): Promise<DraftVersionListResponse> {
  const query = new URLSearchParams();
  if (pagination.limit !== undefined)
    query.set("limit", String(pagination.limit));
  if (pagination.offset !== undefined) {
    query.set("offset", String(pagination.offset));
  }
  return request(
    credentials,
    `/api/drafts/${draftId}/versions${query.size > 0 ? `?${query}` : ""}`,
    { method: "GET" },
    draftVersionListResponseSchema,
    fetchImplementation,
  );
}

export async function updateDraft(
  credentials: YaapsCredentials,
  draftId: string,
  update: {
    category?: string | null;
    status?: DraftStatus;
    title?: string | null;
  },
  fetchImplementation: typeof fetch = fetch,
): Promise<DraftSummary> {
  return request(
    credentials,
    `/api/drafts/${draftId}`,
    {
      body: JSON.stringify(update),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    },
    draftSummarySchema,
    fetchImplementation,
  );
}

export async function deleteDraft(
  credentials: YaapsCredentials,
  draftId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  await request(
    credentials,
    `/api/drafts/${draftId}`,
    { method: "DELETE" },
    undefined,
    fetchImplementation,
  );
}
