import type {
  AdminUserSummary,
  AdminDraftSummary,
  ApiKeyListResponse,
  ApiKeySummary,
  ApproveDeviceConnectionResponse,
  CreatedApiKeyResponse,
  CreatedInvitationResponse,
  DraftListResponse,
  DraftSummary,
  DraftVersionListResponse,
  InvitationSummary,
  PendingDeviceConnection,
  PublicServiceMetadata,
  UserRole,
} from "@yaaps/contracts";

// Response shapes come from the shared contracts package so a server change
// breaks the dashboard build instead of drifting silently.
export type CreatedApiKey = CreatedApiKeyResponse;
export type CreatedInvitation = CreatedInvitationResponse;
export type ApprovedDeviceConnection = ApproveDeviceConnectionResponse;
export type { PendingDeviceConnection };

interface ErrorBody {
  error?: { code?: string; message?: string };
}

export class DashboardRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DashboardRequestError";
  }
}

export async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ErrorBody;
  if (!response.ok) {
    throw new DashboardRequestError(
      body.error?.code ?? "REQUEST_FAILED",
      body.error?.message ?? "The request failed.",
    );
  }
  return body;
}

export function browserCsrfToken(): string | undefined {
  return document.cookie
    .split(";")
    .map((entry) => entry.trim())
    .find(
      (entry) =>
        entry.startsWith("yaaps_csrf=") ||
        entry.startsWith("__Host-yaaps-csrf="),
    )
    ?.split("=")
    .slice(1)
    .join("=");
}

export class DashboardApi {
  constructor(private readonly fetchImplementation: typeof fetch) {}

  async listDrafts(): Promise<DraftListResponse> {
    return this.#get("/dashboard/api/drafts?limit=100&offset=0");
  }

  async listVersions(draftId: string): Promise<DraftVersionListResponse> {
    return this.#get(
      `/dashboard/api/drafts/${encodeURIComponent(draftId)}/versions?limit=100&offset=0`,
    );
  }

  async updateDraft(
    draftId: string,
    update: {
      status?: "disabled" | "enabled";
      title?: string | null;
      ttlSeconds?: number;
    },
  ): Promise<DraftSummary> {
    return this.#mutate(
      `/dashboard/api/drafts/${encodeURIComponent(draftId)}`,
      "PATCH",
      update,
    );
  }

  async serviceMetadata(): Promise<PublicServiceMetadata> {
    return this.#get("/api/meta");
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.#mutate(
      `/dashboard/api/drafts/${encodeURIComponent(draftId)}`,
      "DELETE",
    );
  }

  async listApiKeys(): Promise<ApiKeyListResponse> {
    return this.#get("/auth/api-keys");
  }

  async createApiKey(label: string): Promise<CreatedApiKey> {
    return this.#mutate("/auth/api-keys", "POST", { label });
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.#mutate(`/auth/api-keys/${encodeURIComponent(id)}`, "DELETE");
  }

  async renameApiKey(id: string, label: string): Promise<ApiKeySummary> {
    return this.#mutate(`/auth/api-keys/${encodeURIComponent(id)}`, "PATCH", {
      label,
    });
  }

  async regenerateRecoveryCodes(): Promise<{ recoveryCodes: string[] }> {
    return this.#mutate("/auth/recovery-codes", "POST");
  }

  async getDeviceConnection(
    userCode: string,
  ): Promise<PendingDeviceConnection> {
    // POST body keeps the approval capability out of URLs, logs, and history.
    return this.#mutate("/auth/device-connections/lookup", "POST", {
      userCode,
    });
  }

  async approveDeviceConnection(
    id: string,
    userCode: string,
  ): Promise<ApprovedDeviceConnection> {
    return this.#mutate(
      `/auth/device-connections/${encodeURIComponent(id)}/approve`,
      "POST",
      { userCode },
    );
  }

  async denyDeviceConnection(id: string, userCode: string): Promise<void> {
    await this.#mutate(
      `/auth/device-connections/${encodeURIComponent(id)}/deny`,
      "POST",
      { userCode },
    );
  }

  async listUsers(): Promise<{ items: AdminUserSummary[] }> {
    return this.#get("/dashboard/api/admin/users");
  }

  async listAdminDrafts(): Promise<{ items: AdminDraftSummary[] }> {
    return this.#get("/dashboard/api/admin/drafts?limit=100&offset=0");
  }

  async updateAdminDraft(
    id: string,
    status: "disabled" | "enabled",
  ): Promise<AdminDraftSummary> {
    return this.#mutate(
      `/dashboard/api/admin/drafts/${encodeURIComponent(id)}`,
      "PATCH",
      { status },
    );
  }

  async deleteAdminDraft(id: string): Promise<void> {
    await this.#mutate(
      `/dashboard/api/admin/drafts/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }

  async listInvitations(): Promise<{ items: InvitationSummary[] }> {
    return this.#get("/dashboard/api/admin/invitations");
  }

  async createInvitation(
    role: UserRole,
    lifetimeSeconds: number,
  ): Promise<CreatedInvitation> {
    return this.#mutate("/auth/invitations", "POST", {
      lifetimeSeconds,
      role,
    });
  }

  async revokeInvitation(id: string): Promise<void> {
    await this.#mutate(
      `/dashboard/api/admin/invitations/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }

  async disableUser(id: string): Promise<void> {
    await this.#mutate(`/auth/users/${encodeURIComponent(id)}/disable`, "POST");
  }

  async enableUser(id: string): Promise<void> {
    await this.#mutate(
      `/dashboard/api/admin/users/${encodeURIComponent(id)}/enable`,
      "POST",
    );
  }

  async #get<T>(url: string): Promise<T> {
    const fetchImplementation = this.fetchImplementation;
    const response = await fetchImplementation(url, {
      credentials: "same-origin",
    });
    return readJson<T>(response);
  }

  async #mutate<T>(
    url: string,
    method: "DELETE" | "PATCH" | "POST",
    body?: unknown,
  ): Promise<T> {
    const csrf = browserCsrfToken();
    const fetchImplementation = this.fetchImplementation;
    const response = await fetchImplementation(url, {
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(csrf ? { "x-csrf-token": csrf } : {}),
      },
      method,
    });
    if (response.status === 204) {
      return undefined as T;
    }
    return readJson<T>(response);
  }
}
