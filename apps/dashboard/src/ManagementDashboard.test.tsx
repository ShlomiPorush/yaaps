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
  localeDocuments,
  type Locale,
  type LocaleDocument,
} from "./localization.js";
import { ManagementDashboard } from "./ManagementDashboard.js";

const draft = {
  createdAt: "2026-08-24T08:00:00.000Z",
  expiresAt: "2026-08-31T08:00:00.000Z",
  id: "abcdefghijabcdefghijabcdefghijab",
  latestVersionNumber: 2,
  publicUrl: "https://share.example.test/d/abcdefghijabcdefghijabcdefghijab",
  status: "enabled" as const,
  title: "Quarterly report",
  updatedAt: "2026-08-24T09:00:00.000Z",
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
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    renderDashboard(fetchImplementation, "reports");

    expect(
      screen.getByText(localeDocuments.en.management.loading),
    ).toBeVisible();
    expect(
      screen.queryByLabelText(localeDocuments.en.management.summary),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(2));

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
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });

    renderDashboard(fetchImplementation, "reports");

    expect(
      screen.queryByLabelText(localeDocuments.en.management.summary),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(fetchImplementation).toHaveBeenCalledTimes(2));
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
      if (url.endsWith(draft.id) && init?.method === "PATCH") {
        return json({ ...draft, status: "disabled" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    renderDashboard(fetchImplementation, "reports");

    await screen.findByText(draft.title);
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

  it("requires a second explicit action before permanently deleting a report", async () => {
    document.cookie = "yaaps_csrf=csrf-token; Path=/";
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?") && !init?.method) {
        return json({ items: [draft], limit: 100, offset: 0, total: 1 });
      }
      if (url === "/auth/api-keys") return json({ items: [] });
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

  it("isolates displayed recovery codes from Hebrew page direction", async () => {
    const recoveryCode = "yar_save-this_once";
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.startsWith("/dashboard/api/drafts?")) {
        return json({ items: [], limit: 100, offset: 0, total: 0 });
      }
      if (url === "/auth/api-keys") return json({ items: [] });
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
