// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App, safeDashboardReturnTarget } from "./App.js";
import { formatDate, localeDocuments } from "./localization.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

describe("dashboard foundation", () => {
  it("serves bilingual public API documentation while checking for a session", async () => {
    window.history.replaceState(null, "", "/docs");
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401 }));
    render(
      <App
        fetchImplementation={fetchImplementation}
        initialLocale="en"
        initialTheme="light"
      />,
    );

    expect(
      screen.getByRole("heading", { name: localeDocuments.en.docs.heading }),
    ).toBeVisible();
    expect(screen.getAllByText("/api/drafts/{draftId}/versions")).toHaveLength(
      2,
    );
    expect(
      screen.getByRole("heading", {
        name: localeDocuments.en.docs.authenticationHeading,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: new RegExp(localeDocuments.en.docs.openApiAction, "u"),
      }),
    ).toHaveAttribute("href", "/openapi.json");
    expect(
      screen.getByRole("link", {
        name: new RegExp(localeDocuments.en.docs.swaggerAction, "u"),
      }),
    ).toHaveAttribute("href", "/docs/swagger");
    expect(
      screen.getByRole("link", {
        name: new RegExp(localeDocuments.en.docs.redocAction, "u"),
      }),
    ).toHaveAttribute("href", "/docs/redoc");
    const footer = screen.getByRole("contentinfo");
    const githubLink = within(footer).getByRole("link", { name: "GitHub" });
    expect(githubLink).toHaveAttribute(
      "href",
      "https://github.com/ShlomiPorush/yaaps",
    );
    expect(githubLink.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      within(footer).queryByRole("link", {
        name: localeDocuments.en.navigation.docs,
      }),
    ).not.toBeInTheDocument();
    expect(
      within(footer).queryByRole("link", { name: "OpenAPI 3.1" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());
    expect(fetchImplementation).toHaveBeenCalledWith("/auth/session", {
      credentials: "same-origin",
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.actions.switchLanguage,
      }),
    );
    expect(
      screen.getByRole("heading", { name: localeDocuments.he.docs.heading }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: new RegExp(localeDocuments.he.docs.swaggerAction, "u"),
      }),
    ).toHaveAttribute("href", "/docs/swagger");
    expect(
      screen.getByRole("link", {
        name: new RegExp(localeDocuments.he.docs.redocAction, "u"),
      }),
    ).toHaveAttribute("href", "/docs/redoc");
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
  });

  it("keeps localized endpoint prose RTL and isolates technical values", () => {
    window.history.replaceState(null, "", "/docs");
    render(<App initialLocale="he" initialTheme="light" />);

    const endpointList = document.querySelector<HTMLElement>(".endpoint-list");
    const firstEndpoint =
      endpointList?.querySelector<HTMLElement>(".endpoint-row");
    if (!endpointList || !firstEndpoint) {
      throw new Error("The endpoint list did not render.");
    }

    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    expect(endpointList).not.toHaveAttribute("dir");
    const description = within(firstEndpoint).getByText(
      localeDocuments.he.docs.endpointDescriptions.create,
    );
    expect(description.closest('[dir="ltr"]')).toBeNull();
    expect(firstEndpoint.querySelector(".method-badge")).toHaveAttribute(
      "dir",
      "ltr",
    );
    expect(firstEndpoint.querySelector("code")).toHaveAttribute("dir", "ltr");
  });

  it("states truthfully that publishing management is available after sign-in", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401 }));
    render(
      <App
        fetchImplementation={fetchImplementation}
        initialLocale="en"
        initialTheme="light"
      />,
    );

    expect(
      screen.getByText(localeDocuments.en.dashboard.unavailable),
    ).toBeVisible();
    const publishingIllustration = screen.getByRole("region", {
      name: localeDocuments.en.dashboard.statusHeading,
    });
    expect(publishingIllustration).toHaveTextContent(
      localeDocuments.en.dashboard.terminalPrompt,
    );
    expect(
      within(publishingIllustration).getAllByRole("listitem"),
    ).toHaveLength(3);
    expect(
      within(publishingIllustration).getByText(
        localeDocuments.en.dashboard.terminalResult,
      ),
    ).toHaveAttribute("dir", "ltr");
    expect(publishingIllustration.querySelector("svg")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      publishingIllustration.querySelector(".publishing-processing-dots"),
    ).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByText(/yaaps publish/u)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        name: localeDocuments.en.auth.signInHeading,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: localeDocuments.en.dashboard.primaryAction,
      }),
    ).toHaveAttribute("href", "/connect");
    expect(
      screen.getByRole("link", {
        name: localeDocuments.en.navigation.connect,
      }),
    ).toHaveAttribute("href", "/connect");
    await waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());
    expect(document.documentElement).toHaveAttribute("dir", "ltr");
  });

  it("switches to the Hebrew locale and RTL direction", () => {
    render(<App initialLocale="en" initialTheme="light" />);

    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.actions.switchLanguage,
      }),
    );

    expect(
      screen.getByText(localeDocuments.he.dashboard.heading),
    ).toBeVisible();
    expect(
      screen.getByRole("region", {
        name: localeDocuments.he.dashboard.statusHeading,
      }),
    ).toHaveTextContent(localeDocuments.he.dashboard.terminalPrompt);
    expect(document.documentElement).toHaveAttribute("lang", "he");
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
  });

  it("keeps localized landing prose RTL and isolates technical fragments", () => {
    render(<App initialLocale="he" initialTheme="light" />);

    const datelineIssue =
      document.querySelector<HTMLElement>(".dateline-issue");
    const illustration = screen.getByRole("region", {
      name: localeDocuments.he.dashboard.statusHeading,
    });
    const promptLine = illustration.querySelector<HTMLElement>(
      ".publishing-request",
    );
    const resultLine = illustration.querySelector<HTMLElement>(
      ".publishing-response-bubble",
    );
    if (!datelineIssue || !promptLine || !resultLine) {
      throw new Error("The landing direction surfaces did not render.");
    }

    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    expect(datelineIssue).not.toHaveAttribute("dir");
    expect(datelineIssue).toHaveTextContent(localeDocuments.he.product.tagline);
    expect(within(datelineIssue).getByText("YAAPS")).toHaveAttribute(
      "dir",
      "ltr",
    );
    expect(illustration).not.toHaveAttribute("dir");
    expect(
      within(illustration)
        .getByText(localeDocuments.he.dashboard.terminalLabel)
        .closest('[dir="ltr"]'),
    ).toBeNull();
    expect(promptLine).toHaveTextContent(
      localeDocuments.he.dashboard.terminalPrompt,
    );
    expect(promptLine.closest('[dir="ltr"]')).toBeNull();
    expect(within(promptLine).getByText("$yaaps")).toHaveAttribute(
      "dir",
      "ltr",
    );
    expect(
      within(illustration)
        .getByText(localeDocuments.he.dashboard.terminalResponseLabel)
        .closest('[dir="ltr"]'),
    ).toBeNull();
    expect(
      within(resultLine).getByText(localeDocuments.he.dashboard.terminalResult),
    ).toHaveAttribute("dir", "ltr");
  });

  it("shows a localized deadline exactly 24 hours after the illustration mounts", () => {
    const mountedAt = new Date("2026-08-26T12:34:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(mountedAt.getTime());
    render(<App initialLocale="en" initialTheme="light" />);

    const expectedDeadline = new Date(
      mountedAt.getTime() + 24 * 60 * 60 * 1000,
    );
    const time = screen.getByText(
      formatDate("en", expectedDeadline.toISOString()),
    );
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", expectedDeadline.toISOString());

    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.actions.switchLanguage,
      }),
    );
    expect(time).toHaveTextContent(
      formatDate("he", expectedDeadline.toISOString()),
    );
    expect(time).toHaveAttribute("datetime", expectedDeadline.toISOString());
  });

  it("keeps the recovery-code input LTR within Hebrew login", async () => {
    window.history.replaceState(null, "", "/login");
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ initialized: true }), { status: 200 }),
      );
    render(
      <App
        fetchImplementation={fetchImplementation}
        initialLocale="he"
        initialTheme="light"
      />,
    );

    const recoveryInput = await screen.findByLabelText(
      localeDocuments.he.auth.recoveryCode,
    );
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    expect(recoveryInput).toHaveAttribute("dir", "ltr");
    expect(recoveryInput).toHaveClass("recovery-code-input");
    expect(
      screen.getByText(localeDocuments.he.auth.recoveryCode),
    ).not.toHaveAttribute("dir");
  });

  it("uses the browser locale until the user chooses a language", () => {
    window.history.replaceState(null, "", "/docs");
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue([
      "he-IL",
      "en-US",
    ]);

    const firstRender = render(<App initialTheme="light" />);

    expect(
      screen.getByRole("heading", { name: localeDocuments.he.docs.heading }),
    ).toBeVisible();
    expect(document.documentElement).toHaveAttribute("lang", "he");

    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.he.actions.switchLanguage,
      }),
    );
    expect(window.localStorage.getItem("yaaps-locale")).toBe("en");

    firstRender.unmount();
    render(<App initialTheme="light" />);

    expect(
      screen.getByRole("heading", { name: localeDocuments.en.docs.heading }),
    ).toBeVisible();
    expect(document.documentElement).toHaveAttribute("dir", "ltr");
  });

  it("switches between complete theme roots", () => {
    render(<App initialLocale="en" initialTheme="light" />);

    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.actions.switchTheme,
      }),
    );

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("renders the signed-in header during the session check when the hint is set", async () => {
    window.history.replaceState(null, "", "/dashboard");
    window.localStorage.setItem("yaaps-signed-in", "true");
    window.localStorage.setItem("yaaps-signed-in-role", "admin");
    try {
      // A fetch that never settles keeps the app in the loading state, which is
      // exactly when the pre-fix header flashed its signed-out variant.
      const fetchImplementation = vi.fn<typeof fetch>(
        () => new Promise<Response>(() => undefined),
      );
      render(
        <App
          fetchImplementation={fetchImplementation}
          initialLocale="en"
          initialTheme="light"
        />,
      );

      expect(
        screen.getByRole("link", {
          name: localeDocuments.en.navigation.settings,
        }),
      ).toBeVisible();
      expect(
        screen.getByRole("link", {
          name: localeDocuments.en.navigation.administration,
        }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: localeDocuments.en.auth.signOut }),
      ).toBeVisible();
    } finally {
      window.localStorage.removeItem("yaaps-signed-in");
      window.localStorage.removeItem("yaaps-signed-in-role");
    }
  });

  it("keeps the signed-out header during the session check without the hint", async () => {
    window.history.replaceState(null, "", "/dashboard");
    const fetchImplementation = vi.fn<typeof fetch>(
      () => new Promise<Response>(() => undefined),
    );
    render(
      <App
        fetchImplementation={fetchImplementation}
        initialLocale="en"
        initialTheme="light"
      />,
    );

    expect(
      screen.queryByRole("button", { name: localeDocuments.en.auth.signOut }),
    ).toBeNull();
  });

  it("completes the first-administrator passkey flow and shows recovery codes", async () => {
    window.history.replaceState(null, "", "/login");
    // URL-dispatching mock: the flow fails loudly if the bootstrap secret or
    // credential is ever posted to an unexpected endpoint.
    const optionsBodies: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/auth/session") {
        return new Response(
          JSON.stringify({ error: { code: "AUTHENTICATION_FAILED" } }),
          { status: 401 },
        );
      }
      if (url === "/auth/state") {
        return new Response(JSON.stringify({ initialized: false }), {
          status: 200,
        });
      }
      if (url === "/auth/bootstrap/options" && init?.method === "POST") {
        optionsBodies.push(String(init.body));
        return new Response(
          JSON.stringify({
            challenge: "challenge",
            pubKeyCredParams: [],
            rp: { id: "localhost", name: "YAAPS" },
            user: { displayName: "Admin", id: "user", name: "Admin" },
          }),
          { status: 200 },
        );
      }
      if (url === "/auth/bootstrap/verify" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            recoveryCodes: ["yar_save_this_once"],
            user: {
              id: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
              role: "admin",
            },
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/dashboard/api/drafts?")) {
        return new Response(
          JSON.stringify({ items: [], limit: 100, offset: 0, total: 0 }),
          { status: 200 },
        );
      }
      if (url === "/auth/api-keys") {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const startRegistrationImplementation = vi.fn(async () => ({
      clientExtensionResults: {},
      id: "credential",
      rawId: "credential",
      response: { attestationObject: "x", clientDataJSON: "y" },
      type: "public-key" as const,
    }));
    render(
      <App
        fetchImplementation={fetchImplementation}
        initialLocale="en"
        initialTheme="light"
        startRegistrationImplementation={startRegistrationImplementation}
      />,
    );

    await screen.findByRole("heading", {
      name: localeDocuments.en.auth.bootstrapHeading,
    });
    fireEvent.change(
      screen.getByRole("textbox", {
        name: localeDocuments.en.auth.displayName,
      }),
      { target: { value: "Admin" } },
    );
    fireEvent.change(
      screen.getByLabelText(localeDocuments.en.auth.bootstrapSecret),
      { target: { value: "bootstrap-secret" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.auth.createPasskey,
      }),
    );

    await screen.findByText("yar_save_this_once");
    expect(startRegistrationImplementation).toHaveBeenCalledOnce();
    expect(optionsBodies).toHaveLength(1);
    expect(JSON.parse(optionsBodies[0]!)).toEqual({
      displayName: "Admin",
      secret: "bootstrap-secret",
    });
  });

  it("removes a consumed invitation token from the browser URL", async () => {
    window.history.replaceState(null, "", "/login?invite=yai_once");
    const invitationBodies: string[] = [];
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/auth/session") {
        return new Response(null, { status: 401 });
      }
      if (url === "/auth/state") {
        return new Response(JSON.stringify({ initialized: true }), {
          status: 200,
        });
      }
      if (url === "/auth/invitations/options" && init?.method === "POST") {
        invitationBodies.push(String(init.body));
        return new Response(
          JSON.stringify({
            challenge: "challenge",
            pubKeyCredParams: [],
            rp: { id: "localhost", name: "YAAPS" },
            user: { displayName: "Member", id: "user", name: "Member" },
          }),
          { status: 200 },
        );
      }
      if (url === "/auth/invitations/verify" && init?.method === "POST") {
        return new Response(
          JSON.stringify({
            user: {
              id: "3cb8fbdf-e202-4f41-84b2-e75f33c5b101",
              role: "user",
            },
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("/dashboard/api/drafts?")) {
        return new Response(
          JSON.stringify({ items: [], limit: 100, offset: 0, total: 0 }),
          { status: 200 },
        );
      }
      if (url === "/auth/api-keys") {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const startRegistrationImplementation = vi.fn(async () => ({
      clientExtensionResults: {},
      id: "credential",
      rawId: "credential",
      response: { attestationObject: "x", clientDataJSON: "y" },
      type: "public-key" as const,
    }));
    render(
      <App
        fetchImplementation={fetchImplementation}
        initialLocale="en"
        initialTheme="light"
        startRegistrationImplementation={startRegistrationImplementation}
      />,
    );

    await screen.findByRole("heading", {
      name: localeDocuments.en.auth.invitationHeading,
    });
    fireEvent.change(
      screen.getByRole("textbox", {
        name: localeDocuments.en.auth.displayName,
      }),
      { target: { value: "Member" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.auth.createPasskey,
      }),
    );

    await screen.findByRole("heading", {
      name: localeDocuments.en.management.heading,
    });
    expect(window.location.pathname).toBe("/dashboard");
    expect(window.location.search).toBe("");
    expect(invitationBodies).toHaveLength(1);
    expect(JSON.parse(invitationBodies[0]!)).toEqual({
      displayName: "Member",
      token: "yai_once",
    });
  });

  it("keeps the guided connection page public while checking for a session", async () => {
    window.history.replaceState(null, "", "/connect");
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401 }));
    render(
      <App
        fetchImplementation={fetchImplementation}
        initialLocale="en"
        initialTheme="light"
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: localeDocuments.en.connect.heading,
      }),
    ).toBeVisible();
    await waitFor(() => expect(fetchImplementation).toHaveBeenCalledOnce());
    expect(fetchImplementation).toHaveBeenCalledWith("/auth/session", {
      credentials: "same-origin",
    });
    expect(window.location.pathname).toBe("/connect");
    expect(
      screen.getByRole("button", {
        name: localeDocuments.en.connect.continueToApproval,
      }),
    ).toBeVisible();
  });

  it("shows the signed-in header on every public page", async () => {
    for (const path of ["/", "/docs", "/connect"]) {
      window.history.replaceState(null, "", path);
      const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            user: {
              id: "3cb8fbdf-e202-4f41-84b2-e75f33c5b101",
              role: "admin",
            },
          }),
          { status: 200 },
        ),
      );
      const view = render(
        <App
          fetchImplementation={fetchImplementation}
          initialLocale="en"
          initialTheme="light"
        />,
      );

      expect(
        await screen.findByRole("button", {
          name: localeDocuments.en.auth.signOut,
        }),
      ).toBeVisible();
      expect(
        screen.getByRole("link", {
          name: localeDocuments.en.navigation.settings,
        }),
      ).toBeVisible();
      expect(
        screen.getByRole("link", {
          name: localeDocuments.en.navigation.administration,
        }),
      ).toBeVisible();
      const navigation = screen.getByRole("navigation", {
        name: localeDocuments.en.navigation.ariaLabel,
      });
      const navigationLinks = within(navigation).getAllByRole("link");
      expect(
        navigationLinks.slice(0, 3).map((link) => link.textContent),
      ).toEqual([
        localeDocuments.en.navigation.connect,
        localeDocuments.en.navigation.docs,
        localeDocuments.en.navigation.dashboard,
      ]);
      expect(navigationLinks[0]).toHaveClass("connect-nav-link");
      expect(fetchImplementation).toHaveBeenCalledOnce();
      view.unmount();
    }
  });

  it("redirects a signed-out approval request to login with its code", async () => {
    window.history.replaceState(
      null,
      "",
      "/dashboard/connect/approve?code=ABCD-EFGH",
    );
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ initialized: true }), { status: 200 }),
      );
    render(
      <App
        fetchImplementation={fetchImplementation}
        initialLocale="en"
        initialTheme="light"
      />,
    );

    await screen.findByRole("heading", {
      name: localeDocuments.en.auth.signInHeading,
    });
    expect(window.location.pathname).toBe("/login");
    expect(new URLSearchParams(window.location.search).get("returnTo")).toBe(
      "/dashboard/connect/approve?code=ABCD-EFGH",
    );
  });

  it("renders approval as a focused page for a signed-in user", async () => {
    window.history.replaceState(
      null,
      "",
      "/dashboard/connect/approve?code=ABCD-EFGH",
    );
    const fetchImplementation = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "/auth/session") {
        return new Response(
          JSON.stringify({
            user: {
              id: "3cb8fbdf-e202-4f41-84b2-e75f33c5b101",
              role: "user",
            },
          }),
          { status: 200 },
        );
      }
      if (url === "/auth/device-connections/lookup") {
        return new Response(
          JSON.stringify({
            createdAt: "2026-08-24T08:00:00.000Z",
            expiresAt: "2026-08-24T08:10:00.000Z",
            id: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
            keyPrefix: "yaaps_abcdefghij",
            label: "Codex on Shlomi's PC",
            status: "pending",
            userCode: "ABCD-EFGH",
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(
      <App
        fetchImplementation={fetchImplementation}
        initialLocale="en"
        initialTheme="light"
      />,
    );

    const heading = await screen.findByRole("heading", {
      name: localeDocuments.en.connect.pendingHeading,
    });
    expect(heading.closest(".connection-approval-card")).toBeInTheDocument();
    expect(document.querySelector(".dashboard-view")).toBeNull();
    expect(await screen.findByText("Codex on Shlomi's PC")).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: localeDocuments.en.navigation.connect,
      }),
    ).toHaveAttribute("aria-current", "page");
    expect(window.location.pathname).toBe("/dashboard/connect/approve");
  });

  it("still redirects the signed-out reports dashboard to login", async () => {
    window.history.replaceState(null, "", "/dashboard");
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ initialized: true }), { status: 200 }),
      );
    render(
      <App
        fetchImplementation={fetchImplementation}
        initialLocale="en"
        initialTheme="light"
      />,
    );

    await screen.findByRole("heading", {
      name: localeDocuments.en.auth.signInHeading,
    });
    expect(window.location.pathname).toBe("/login");
    expect(new URLSearchParams(window.location.search).get("returnTo")).toBe(
      "/dashboard",
    );
  });

  it("redirects an authenticated login visit to reports", async () => {
    window.history.replaceState(null, "", "/login");
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            user: {
              id: "3cb8fbdf-e202-4f41-84b2-e75f33c5b101",
              role: "user",
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ items: [], limit: 100, offset: 0, total: 0 }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
    render(
      <App
        fetchImplementation={fetchImplementation}
        initialLocale="en"
        initialTheme="light"
      />,
    );

    await screen.findByRole("heading", {
      name: localeDocuments.en.management.heading,
    });
    expect(window.location.pathname).toBe("/dashboard");
  });

  it("accepts only known internal dashboard return targets", () => {
    expect(
      safeDashboardReturnTarget("/dashboard/connect/approve?code=ABCD-EFGH"),
    ).toBe("/dashboard/connect/approve?code=ABCD-EFGH");
    expect(safeDashboardReturnTarget("/connect?code=ABCD-EFGH")).toBe(
      "/dashboard",
    );
    expect(safeDashboardReturnTarget("https://evil.example/dashboard")).toBe(
      "/dashboard",
    );
    expect(safeDashboardReturnTarget("//evil.example/dashboard/admin")).toBe(
      "/dashboard",
    );
    expect(safeDashboardReturnTarget("/docs?next=/dashboard")).toBe(
      "/dashboard",
    );
  });

  it("preserves legacy root invitation links on the login page", async () => {
    window.history.replaceState(null, "", "/?invite=yai_legacy");
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ initialized: true }), { status: 200 }),
      );
    render(
      <App
        fetchImplementation={fetchImplementation}
        initialLocale="en"
        initialTheme="light"
      />,
    );

    await screen.findByRole("heading", {
      name: localeDocuments.en.auth.invitationHeading,
    });
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/login?invite=yai_legacy",
    );
  });
});
