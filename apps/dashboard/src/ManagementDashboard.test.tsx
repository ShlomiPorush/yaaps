// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatDeviceDate,
  localeDocuments,
  type Locale,
  type LocaleDocument,
} from "./localization.js";
import { ManagementDashboard } from "./ManagementDashboard.js";

const draft = {
  category: null,
  createdAt: "2026-08-24T08:00:00.000Z",
  expiresAt: "2026-08-31T08:00:00.000Z",
  id: "abcdefghijabcdefghijabcdefghijab",
  latestVersionNumber: 2,
  publicUrl: "https://share.example.test/d/abcdefghijabcdefghijabcdefghijab",
  resourcePolicy: "isolated" as const,
  status: "enabled" as const,
  title: "Quarterly report",
  updatedAt: "2026-08-24T09:00:00.000Z",
  viewCount: 1_234,
};

const weeklyCategory = "Weekly reports";

const categorizedDraft = {
  ...draft,
  category: weeklyCategory,
  id: "bcdefghijbcdefghijbcdefghijbcdef",
  publicUrl: "https://share.example.test/d/bcdefghijbcdefghijbcdefghijbcdef",
  title: "Weekly summary",
};

const draftListUrl = "/dashboard/api/drafts?limit=100&offset=0";

function filterOptionName(category: string, count: number): string {
  return localeDocuments.en.management.categoryFilterOption
    .replace("{category}", category)
    .replace("{count}", String(count));
}

const serviceMetadata = {
  limits: {
    defaultTtlSeconds: 7 * 24 * 60 * 60,
    maximumHtmlBytes: 10 * 1024 * 1024,
    maximumTtlSeconds: 30 * 24 * 60 * 60,
    minimumTtlSeconds: 60 * 60,
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

interface RenderDashboardOptions {
  copy?: LocaleDocument;
  locale?: Locale;
  recoveryCodes?: string[];
  role?: "admin" | "user";
  actionError?: boolean;
}

function renderDashboard(
  fetchImplementation: typeof fetch,
  view: "admin" | "reports" | "settings",
  {
    copy = localeDocuments.en,
    locale = "en",
    recoveryCodes = [],
    role = "user",
    actionError = false,
  }: RenderDashboardOptions = {},
) {
  return render(
    <ManagementDashboard
      actionError={actionError}
      busy={false}
      copy={copy}
      fetchImplementation={fetchImplementation}
      locale={locale}
      onAddPasskey={vi.fn()}
      passkeyAdded={false}
      recoveryCodes={recoveryCodes}
      role={role}
      userId="8f7c1ca3-edbc-4b4b-b349-d45322728936"
      view={view}
    />,
  );
}

afterEach(() => {
  cleanup();
  document.cookie = "yaaps_csrf=; Max-Age=0; Path=/";
});

describe("signed-in management dashboard", () => {
  it("renders administration as a route surface with the shared heading composition", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (
        url === "/dashboard/api/admin/users" ||
        url === "/dashboard/api/admin/invitations" ||
        url.startsWith("/dashboard/api/admin/drafts?")
      ) {
        return json({ items: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { container } = renderDashboard(fetchImplementation, "admin", {
      role: "admin",
    });

    const heading = await screen.findByRole("heading", {
      level: 1,
      name: localeDocuments.en.management.adminHeading,
    });
    const routeRoot = container.querySelector<HTMLElement>(
      ".dashboard-view.administration-section",
    );
    expect(routeRoot).toBeInTheDocument();
    expect(routeRoot).toContainElement(heading);
    expect(heading.closest(".dashboard-heading")).toBeInTheDocument();
    expect(container.querySelectorAll(".dashboard-view")).toHaveLength(1);
    expect(container.querySelector(".administration-heading")).toBeNull();
  });

  it("withholds account counts until both initial requests have loaded", async () => {
    let resolveDrafts!: (response: Response) => void;
    let resolveKeys!: (response: Response) => void;
    const fetchImplementation = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?")) {
        return new Promise<Response>((resolve) => {
          resolveDrafts = resolve;
        });
      }
      if (url === "/auth/api-keys") {
        return new Promise<Response>((resolve) => {
          resolveKeys = resolve;
        });
      }
      if (url === "/dashboard/api/categories") {
        return Promise.resolve(json({ items: [] }));
      }
      if (url === "/api/meta") {
        return Promise.resolve(json(serviceMetadata));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    renderDashboard(fetchImplementation, "reports");

    expect(
      screen.getByText(localeDocuments.en.management.loading),
    ).toBeVisible();
    expect(
      screen.queryByLabelText(localeDocuments.en.management.summary),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(4));

    resolveDrafts(json({ items: [], limit: 100, offset: 0, total: 0 }));
    resolveKeys(json({ items: [] }));

    const summary = await screen.findByLabelText(
      localeDocuments.en.management.summary,
    );
    expect(
      screen.queryByText(localeDocuments.en.management.loading),
    ).not.toBeInTheDocument();
    expect(summary).toHaveTextContent(
      `0 ${localeDocuments.en.management.draftsCount}`,
    );
    expect(summary).toHaveTextContent(
      `0 ${localeDocuments.en.management.keysCount}`,
    );
  });

  it("reveals settled zero counts after an initial loading failure", async () => {
    let rejectDrafts!: (error: Error) => void;
    let rejectKeys!: (error: Error) => void;
    const fetchImplementation = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?")) {
        return new Promise<Response>((_resolve, reject) => {
          rejectDrafts = reject;
        });
      }
      if (url === "/auth/api-keys") {
        return new Promise<Response>((_resolve, reject) => {
          rejectKeys = reject;
        });
      }
      if (url === "/dashboard/api/categories") {
        return Promise.resolve(json({ items: [] }));
      }
      if (url === "/api/meta") {
        return Promise.resolve(json(serviceMetadata));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    renderDashboard(fetchImplementation, "reports");

    expect(
      screen.queryByLabelText(localeDocuments.en.management.summary),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(4));
    rejectDrafts(new Error("Draft request failed"));
    rejectKeys(new Error("Key request failed"));

    const errorAlert = await screen.findByRole("alert");
    expect(errorAlert).toBeVisible();
    expect(errorAlert).toHaveTextContent(localeDocuments.en.management.error);
    const summary = screen.getByLabelText(
      localeDocuments.en.management.summary,
    );
    expect(summary).toHaveTextContent(
      `0 ${localeDocuments.en.management.draftsCount}`,
    );
    expect(summary).toHaveTextContent(
      `0 ${localeDocuments.en.management.keysCount}`,
    );
  });

  it("loads reports and changes public availability with CSRF", async () => {
    document.cookie = "yaaps_csrf=csrf-token; Path=/";
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?") && !init?.method) {
        return json({ items: [draft], limit: 100, offset: 0, total: 1 });
      }
      if (url === "/auth/api-keys") {
        return json({
          items: [
            {
              createdAt: "2026-08-24T08:00:00.000Z",
              id: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
              label: "Local agent",
              lastUsedAt: null,
              prefix: "yaaps_prefix",
            },
          ],
        });
      }
      if (url === "/dashboard/api/categories") {
        return json({ items: [] });
      }
      if (url.endsWith(draft.id) && init?.method === "PATCH") {
        return json({ ...draft, status: "disabled" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { container } = renderDashboard(fetchImplementation, "reports");

    await screen.findByText(draft.title);
    expect(container.querySelector(".draft-meta")).toHaveTextContent(
      localeDocuments.en.management.views.replace("{count}", "1,234"),
    );
    const summary = screen.getByLabelText(
      localeDocuments.en.management.summary,
    );
    expect(summary).toHaveTextContent(
      `1 ${localeDocuments.en.management.draftCount}`,
    );
    expect(summary).toHaveTextContent(
      `1 ${localeDocuments.en.management.keyCount}`,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.disable,
      }),
    );

    await screen.findByText(localeDocuments.en.management.reportDisabled);
    expect(fetchImplementation).toHaveBeenCalledWith(
      `/dashboard/api/drafts/${draft.id}`,
      expect.objectContaining({
        headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }),
        method: "PATCH",
      }),
    );
  });

  it("opens the public report from its title as well as the dedicated link", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?")) {
        return json({ items: [draft], limit: 100, offset: 0, total: 1 });
      }
      if (url === "/auth/api-keys") return json({ items: [] });
      if (url === "/dashboard/api/categories") return json({ items: [] });
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDashboard(fetchImplementation, "reports");

    const titleLink = await screen.findByRole("link", { name: draft.title });
    expect(titleLink).toHaveAttribute("href", draft.publicUrl);
    expect(titleLink).toHaveAttribute("target", "_blank");
    const openLink = screen.getByRole("link", {
      name: localeDocuments.en.management.openReport,
    });
    expect(openLink).toHaveAttribute("href", draft.publicUrl);
    expect(
      screen.getByRole("heading", { level: 3, name: draft.title }),
    ).toContainElement(titleLink);
  });

  it("labels the latest report and every saved version with its resource policy in Hebrew", async () => {
    const connectedDraft = {
      ...draft,
      resourcePolicy: "connected" as const,
    };
    const savedVersions = [
      {
        byteLength: 8_192,
        createdAt: "2026-08-24T09:00:00.000Z",
        publicUrl: `${draft.publicUrl}/2`,
        resourcePolicy: "connected" as const,
        sha256: "a".repeat(64),
        versionNumber: 2,
        viewCount: 5_678,
      },
      {
        byteLength: 4_096,
        createdAt: "2026-08-24T08:00:00.000Z",
        publicUrl: `${draft.publicUrl}/1`,
        resourcePolicy: "isolated" as const,
        sha256: "b".repeat(64),
        versionNumber: 1,
        viewCount: 9,
      },
    ];
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?")) {
        return json({
          items: [connectedDraft],
          limit: 100,
          offset: 0,
          total: 1,
        });
      }
      if (
        url === `/dashboard/api/drafts/${draft.id}/versions?limit=100&offset=0`
      ) {
        return json({
          items: savedVersions,
          limit: 100,
          offset: 0,
          total: savedVersions.length,
        });
      }
      if (url === "/auth/api-keys") return json({ items: [] });
      if (url === "/dashboard/api/categories") return json({ items: [] });
      if (url === "/api/meta") return json(serviceMetadata);
      throw new Error(`Unexpected request: ${url}`);
    });
    const { container } = renderDashboard(fetchImplementation, "reports", {
      copy: localeDocuments.he,
      locale: "he",
    });

    expect(
      await screen.findByText(
        localeDocuments.he.management.resourcePolicyConnected,
      ),
    ).toHaveClass("connected");
    expect(container.querySelector(".draft-meta")).toHaveTextContent(
      localeDocuments.he.management.views.replace("{count}", "1,234"),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.he.management.showVersions,
      }),
    );

    await waitFor(() => {
      expect(
        screen.getAllByText(
          localeDocuments.he.management.resourcePolicyConnected,
        ),
      ).toHaveLength(2);
    });
    expect(
      screen.getByText(localeDocuments.he.management.resourcePolicyIsolated),
    ).toHaveClass("isolated");
    expect(container.querySelector(".version-list")).toHaveTextContent(
      localeDocuments.he.management.views.replace("{count}", "5,678"),
    );
  });

  it("extends a report's expiry with a preset TTL from now", async () => {
    document.cookie = "yaaps_csrf=csrf-token; Path=/";
    const extendedExpiry = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?") && !init?.method) {
        return json({ items: [draft], limit: 100, offset: 0, total: 1 });
      }
      if (url === "/auth/api-keys") return json({ items: [] });
      if (url === "/dashboard/api/categories") return json({ items: [] });
      if (url === "/api/meta") return json(serviceMetadata);
      if (url.endsWith(draft.id) && init?.method === "PATCH") {
        return json({ ...draft, expiresAt: extendedExpiry });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { container } = renderDashboard(fetchImplementation, "reports");

    await screen.findByText(draft.title);
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.extend,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: localeDocuments.en.management.extendWeek,
      }),
    );

    await waitFor(() =>
      expect(fetchImplementation).toHaveBeenCalledWith(
        `/dashboard/api/drafts/${draft.id}`,
        expect.objectContaining({
          body: JSON.stringify({ ttlSeconds: 7 * 24 * 60 * 60 }),
          headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }),
          method: "PATCH",
        }),
      ),
    );
    await waitFor(() => {
      const meta = container.querySelector(".draft-meta");
      expect(meta?.textContent).toContain(formatDeviceDate(extendedExpiry));
      expect(meta?.textContent).toContain("left)");
    });
    expect(
      screen.getByRole("button", {
        name: localeDocuments.en.management.extend,
      }),
    ).toBeInTheDocument();
  });

  it("requires a second explicit action before permanently deleting a report", async () => {
    document.cookie = "yaaps_csrf=csrf-token; Path=/";
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?") && !init?.method) {
        return json({ items: [draft], limit: 100, offset: 0, total: 1 });
      }
      if (url === "/auth/api-keys") return json({ items: [] });
      if (url === "/dashboard/api/categories") return json({ items: [] });
      if (url.endsWith(draft.id) && init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDashboard(fetchImplementation, "reports");

    await screen.findByText(draft.title);
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.delete,
      }),
    );
    expect(fetchImplementation).not.toHaveBeenCalledWith(
      expect.stringContaining(draft.id),
      expect.objectContaining({ method: "DELETE" }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.confirmDelete,
      }),
    );

    await screen.findByText(localeDocuments.en.management.emptyReportsHeading);
  });

  it("surfaces an add-passkey or sign-out failure in the account panel", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?")) {
        return json({ items: [], limit: 100, offset: 0, total: 0 });
      }
      if (url === "/auth/api-keys") {
        return json({ items: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDashboard(fetchImplementation, "settings", { actionError: true });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(localeDocuments.en.auth.error);
  });

  it("shows a newly created API key once and hides it after acknowledgement", async () => {
    document.cookie = "yaaps_csrf=csrf-token; Path=/";
    const fullKey = "yaaps_prefix_secret-value";
    const keyPrefix = "yaaps_prefix";
    let keyCreated = false;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?")) {
        return json({ items: [], limit: 100, offset: 0, total: 0 });
      }
      if (url === "/auth/api-keys" && init?.method === "POST") {
        keyCreated = true;
        return json({
          id: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
          key: fullKey,
          prefix: keyPrefix,
        });
      }
      if (url === "/auth/api-keys") {
        return json({
          items: keyCreated
            ? [
                {
                  createdAt: "2026-08-24T08:00:00.000Z",
                  id: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
                  label: "Local agent",
                  lastUsedAt: null,
                  prefix: keyPrefix,
                },
              ]
            : [],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDashboard(fetchImplementation, "settings", {
      copy: localeDocuments.he,
      locale: "he",
    });

    fireEvent.change(
      await screen.findByRole("textbox", {
        name: localeDocuments.he.management.keyLabel,
      }),
      { target: { value: "Local agent" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.he.management.createKey,
      }),
    );

    const createdKey = await screen.findByText(fullKey);
    expect(createdKey).toBeVisible();
    expect(createdKey).toHaveAttribute("dir", "ltr");
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.he.management.savedKey,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByText(fullKey)).not.toBeInTheDocument(),
    );
    const storedPrefix = screen.getByText(`${keyPrefix}…`);
    expect(storedPrefix).toBeVisible();
    expect(storedPrefix).toHaveAttribute("dir", "ltr");
  });

  it("renames an API key in place with CSRF", async () => {
    document.cookie = "yaaps_csrf=csrf-token; Path=/";
    const keyId = "8f7c1ca3-edbc-4b4b-b349-d45322728936";
    const storedKey = {
      createdAt: "2026-08-24T08:00:00.000Z",
      id: keyId,
      label: "Local agent",
      lastUsedAt: null,
      prefix: "yaaps_prefix",
    };
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?")) {
        return json({ items: [], limit: 100, offset: 0, total: 0 });
      }
      if (url === "/auth/api-keys") {
        return json({ items: [storedKey] });
      }
      if (url === `/auth/api-keys/${keyId}` && init?.method === "PATCH") {
        return json({ ...storedKey, label: "Weekly reports" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDashboard(fetchImplementation, "settings");

    await screen.findByText(storedKey.label);
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.rename,
      }),
    );
    fireEvent.change(screen.getByDisplayValue(storedKey.label), {
      target: { value: "Weekly reports" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.renameSave,
      }),
    );

    await screen.findByText("Weekly reports");
    expect(screen.queryByText(storedKey.label)).not.toBeInTheDocument();
    expect(fetchImplementation).toHaveBeenCalledWith(
      `/auth/api-keys/${keyId}`,
      expect.objectContaining({
        body: JSON.stringify({ label: "Weekly reports" }),
        headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }),
        method: "PATCH",
      }),
    );
  });

  it("labels a categorized report with its category chip", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?")) {
        return json({
          items: [categorizedDraft, draft],
          limit: 100,
          offset: 0,
          total: 2,
        });
      }
      if (url === "/auth/api-keys") return json({ items: [] });
      if (url === "/dashboard/api/categories") {
        return json({ items: [{ category: weeklyCategory, draftCount: 1 }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { container } = renderDashboard(fetchImplementation, "reports");

    await screen.findByText(categorizedDraft.title);
    const chips = container.querySelectorAll(".category-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent(weeklyCategory);
    expect(chips[0]?.closest(".draft-meta")).toBeInTheDocument();
    expect(
      screen.getByRole("group", {
        name: localeDocuments.en.management.categoryFilterLabel,
      }),
    ).toBeVisible();
  });

  it("asks the server for one category and back for every report", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === `${draftListUrl}&category=Weekly%20reports`) {
        return json({
          items: [categorizedDraft],
          limit: 100,
          offset: 0,
          total: 1,
        });
      }
      if (url === draftListUrl) {
        return json({
          items: [categorizedDraft, draft],
          limit: 100,
          offset: 0,
          total: 2,
        });
      }
      if (url === "/auth/api-keys") return json({ items: [] });
      if (url === "/dashboard/api/categories") {
        return json({ items: [{ category: weeklyCategory, draftCount: 1 }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDashboard(fetchImplementation, "reports");

    const filterOption = await screen.findByRole("button", {
      name: filterOptionName(weeklyCategory, 1),
    });
    expect(filterOption).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(filterOption);

    await waitFor(() =>
      expect(screen.queryByText(draft.title)).not.toBeInTheDocument(),
    );
    expect(fetchImplementation).toHaveBeenCalledWith(
      `${draftListUrl}&category=Weekly%20reports`,
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(
      screen.getByRole("button", { name: filterOptionName(weeklyCategory, 1) }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.categoryFilterAll,
      }),
    );

    await screen.findByText(draft.title);
    expect(
      screen.getByRole("button", {
        name: localeDocuments.en.management.categoryFilterAll,
      }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("names the filtered category when no report matches it", async () => {
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === `${draftListUrl}&category=Weekly%20reports`) {
        return json({ items: [], limit: 100, offset: 0, total: 0 });
      }
      if (url === draftListUrl) {
        return json({ items: [draft], limit: 100, offset: 0, total: 1 });
      }
      if (url === "/auth/api-keys") return json({ items: [] });
      if (url === "/dashboard/api/categories") {
        return json({ items: [{ category: weeklyCategory, draftCount: 1 }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDashboard(fetchImplementation, "reports");

    fireEvent.click(
      await screen.findByRole("button", {
        name: filterOptionName(weeklyCategory, 1),
      }),
    );

    expect(
      await screen.findByText(
        localeDocuments.en.management.emptyCategoryHeading,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(
        localeDocuments.en.management.emptyCategoryText.replace(
          "{category}",
          weeklyCategory,
        ),
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(localeDocuments.en.management.emptyReportsHeading),
    ).not.toBeInTheDocument();
  });

  it("types the first category of the account and offers it as a filter", async () => {
    document.cookie = "yaaps_csrf=csrf-token; Path=/";
    let categorized = false;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?")) {
        return json({
          items: [categorized ? { ...draft, category: weeklyCategory } : draft],
          limit: 100,
          offset: 0,
          total: 1,
        });
      }
      if (url === "/auth/api-keys") return json({ items: [] });
      if (url === "/dashboard/api/categories") {
        return json({
          items: categorized
            ? [{ category: weeklyCategory, draftCount: 1 }]
            : [],
        });
      }
      if (url.endsWith(draft.id) && init?.method === "PATCH") {
        categorized = true;
        return json({ ...draft, category: weeklyCategory });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDashboard(fetchImplementation, "reports");

    await screen.findByText(draft.title);
    expect(
      screen.queryByRole("group", {
        name: localeDocuments.en.management.categoryFilterLabel,
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.categorySet,
      }),
    );
    // With no category to pick from, the editor offers the text input alone.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.change(
      screen.getByLabelText(localeDocuments.en.management.categoryNewLabel),
      { target: { value: ` ${weeklyCategory} ` } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.categorySave,
      }),
    );

    expect(
      await screen.findByRole("button", {
        name: filterOptionName(weeklyCategory, 1),
      }),
    ).toBeVisible();
    expect(fetchImplementation).toHaveBeenCalledWith(
      `/dashboard/api/drafts/${draft.id}`,
      expect.objectContaining({
        body: JSON.stringify({ category: weeklyCategory }),
        headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }),
        method: "PATCH",
      }),
    );
    expect(
      screen.getByRole("button", {
        name: localeDocuments.en.management.categoryEdit,
      }),
    ).toBeVisible();
  });

  it("moves a report to a category picked from the list", async () => {
    document.cookie = "yaaps_csrf=csrf-token; Path=/";
    let assigned = false;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?")) {
        return json({
          items: [
            assigned ? { ...draft, category: weeklyCategory } : draft,
            categorizedDraft,
          ],
          limit: 100,
          offset: 0,
          total: 2,
        });
      }
      if (url === "/auth/api-keys") return json({ items: [] });
      if (url === "/dashboard/api/categories") {
        return json({
          items: [{ category: weeklyCategory, draftCount: assigned ? 2 : 1 }],
        });
      }
      if (url.endsWith(draft.id) && init?.method === "PATCH") {
        assigned = true;
        return json({ ...draft, category: weeklyCategory });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDashboard(fetchImplementation, "reports");

    await screen.findByText(draft.title);
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.categorySet,
      }),
    );
    const select = screen.getByLabelText(
      localeDocuments.en.management.categoryLabel,
    );
    // A report without a category starts on the placeholder, so there is
    // nothing to save yet.
    expect(
      screen.getByRole("option", {
        name: localeDocuments.en.management.categoryChoose,
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", {
        name: localeDocuments.en.management.categorySave,
      }),
    ).toBeDisabled();
    expect(
      screen.queryByLabelText(localeDocuments.en.management.categoryNewLabel),
    ).not.toBeInTheDocument();

    fireEvent.change(select, {
      target: {
        value: (
          screen.getByRole("option", {
            name: weeklyCategory,
          }) as HTMLOptionElement
        ).value,
      },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.categorySave,
      }),
    );

    expect(
      await screen.findByRole("button", {
        name: filterOptionName(weeklyCategory, 2),
      }),
    ).toBeVisible();
    expect(fetchImplementation).toHaveBeenCalledWith(
      `/dashboard/api/drafts/${draft.id}`,
      expect.objectContaining({
        body: JSON.stringify({ category: weeklyCategory }),
        method: "PATCH",
      }),
    );
  });

  it("changes and then removes the category of a report", async () => {
    document.cookie = "yaaps_csrf=csrf-token; Path=/";
    const monthlyCategory = "Monthly reports";
    let current: string | null = weeklyCategory;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?")) {
        return json({
          items: [{ ...categorizedDraft, category: current }],
          limit: 100,
          offset: 0,
          total: 1,
        });
      }
      if (url === "/auth/api-keys") return json({ items: [] });
      if (url === "/dashboard/api/categories") {
        return json({
          items: current === null ? [] : [{ category: current, draftCount: 1 }],
        });
      }
      if (url.endsWith(categorizedDraft.id) && init?.method === "PATCH") {
        current = (JSON.parse(String(init.body)) as { category: string | null })
          .category;
        return json({ ...categorizedDraft, category: current });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { container } = renderDashboard(fetchImplementation, "reports");

    await screen.findByText(categorizedDraft.title);
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.categoryEdit,
      }),
    );
    const select = screen.getByLabelText(
      localeDocuments.en.management.categoryLabel,
    );
    const currentOption = screen.getByRole("option", {
      name: weeklyCategory,
    }) as HTMLOptionElement;
    expect(select).toHaveValue(currentOption.value);
    fireEvent.change(select, {
      target: {
        value: (
          screen.getByRole("option", {
            name: localeDocuments.en.management.categoryNew,
          }) as HTMLOptionElement
        ).value,
      },
    });
    // The select stays available so the choice can be taken back.
    expect(select).toBeVisible();
    const input = screen.getByLabelText(
      localeDocuments.en.management.categoryNewLabel,
    );
    expect(input).toHaveValue("");
    fireEvent.change(input, { target: { value: monthlyCategory } });
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.categorySave,
      }),
    );

    expect(
      await screen.findByRole("button", {
        name: filterOptionName(monthlyCategory, 1),
      }),
    ).toBeVisible();
    expect(fetchImplementation).toHaveBeenCalledWith(
      `/dashboard/api/drafts/${categorizedDraft.id}`,
      expect.objectContaining({
        body: JSON.stringify({ category: monthlyCategory }),
        method: "PATCH",
      }),
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.categoryClear,
      }),
    );

    await waitFor(() =>
      expect(container.querySelector(".category-chip")).toBeNull(),
    );
    expect(fetchImplementation).toHaveBeenCalledWith(
      `/dashboard/api/drafts/${categorizedDraft.id}`,
      expect.objectContaining({
        body: JSON.stringify({ category: null }),
        method: "PATCH",
      }),
    );
    expect(
      screen.queryByRole("group", {
        name: localeDocuments.en.management.categoryFilterLabel,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: localeDocuments.en.management.categorySet,
      }),
    ).toBeVisible();
  });

  it("isolates displayed recovery codes from Hebrew page direction", async () => {
    const recoveryCode = "yar_save-this_once";
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?")) {
        return json({ items: [], limit: 100, offset: 0, total: 0 });
      }
      if (url === "/auth/api-keys") return json({ items: [] });
      if (url === "/dashboard/api/categories") return json({ items: [] });
      throw new Error(`Unexpected request: ${url}`);
    });

    renderDashboard(fetchImplementation, "reports", {
      copy: localeDocuments.he,
      locale: "he",
      recoveryCodes: [recoveryCode],
    });

    const displayedCode = screen.getByText(recoveryCode);
    expect(displayedCode).toBeVisible();
    expect(displayedCode).toHaveAttribute("dir", "ltr");
    await screen.findByLabelText(localeDocuments.he.management.summary);
  });
});
