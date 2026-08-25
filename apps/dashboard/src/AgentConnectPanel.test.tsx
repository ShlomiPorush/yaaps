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
  AgentConnectionApprovalPanel,
  AgentConnectPanel,
} from "./AgentConnectPanel.js";
import { localeDocuments } from "./localization.js";

const pendingRequest = {
  createdAt: "2026-08-24T08:00:00.000Z",
  expiresAt: "2026-08-24T08:10:00.000Z",
  id: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
  keyPrefix: "yaaps_abcdefghij",
  label: "Codex on Shlomi's PC",
  status: "pending" as const,
  userCode: "ABCD-EFGH",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

afterEach(() => {
  cleanup();
  document.cookie = "yaaps_csrf=; Max-Age=0; Path=/";
  window.history.replaceState(null, "", "/");
});

describe("agent connection dashboard", () => {
  it("sends a manually entered code from the public guide to the protected approval route", () => {
    window.history.replaceState(null, "", "/connect");
    render(<AgentConnectPanel copy={localeDocuments.en} />);

    fireEvent.change(
      screen.getByRole("textbox", {
        name: localeDocuments.en.connect.codeLabel,
      }),
      { target: { value: "abcd efgh" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.connect.continueToApproval,
      }),
    );

    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/dashboard/connect/approve?code=abcd+efgh",
    );
  });

  it("loads a query-string code and approves the exact request once with CSRF", async () => {
    window.history.replaceState(
      null,
      "",
      "/dashboard/connect/approve?code=abcd-efgh",
    );
    document.cookie = "yaaps_csrf=csrf-token; Path=/";
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (
        url === "/auth/device-connections/lookup" &&
        init?.method === "POST" &&
        String(init.body).includes("abcd-efgh")
      ) {
        return json(pendingRequest);
      }
      if (
        url === `/auth/device-connections/${pendingRequest.id}/approve` &&
        init?.method === "POST"
      ) {
        return json({
          apiKey: {
            createdAt: pendingRequest.createdAt,
            id: "3cb8fbdf-e202-4f41-84b2-e75f33c5b101",
            label: pendingRequest.label,
            lastUsedAt: null,
            prefix: pendingRequest.keyPrefix,
          },
          status: "approved",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(
      <AgentConnectionApprovalPanel
        copy={localeDocuments.en}
        fetchImplementation={fetchImplementation}
        locale="en"
        recoveryCodes={["RECOVERY-CODE-1"]}
      />,
    );

    expect(screen.getByText("RECOVERY-CODE-1")).toBeVisible();
    expect(await screen.findByText(pendingRequest.label)).toBeVisible();
    expect(
      screen.getByRole("heading", {
        name: localeDocuments.en.connect.pendingHeading,
      }),
    ).toBeVisible();
    const approve = screen.getByRole("button", {
      name: localeDocuments.en.connect.approve,
    });
    fireEvent.click(approve);
    fireEvent.click(approve);

    expect(
      await screen.findByText(localeDocuments.en.connect.approvedHeading),
    ).toBeVisible();
    const approvalCalls = fetchImplementation.mock.calls.filter(([input]) =>
      String(input).endsWith("/approve"),
    );
    expect(approvalCalls).toHaveLength(1);
    expect(approvalCalls[0]?.[1]).toEqual(
      expect.objectContaining({
        body: JSON.stringify({ userCode: pendingRequest.userCode }),
        headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }),
        method: "POST",
      }),
    );
    expect(window.location.pathname).toBe("/dashboard/connect/approve");
    expect(window.location.search).toBe("");
    expect(
      screen.queryByRole("button", {
        name: localeDocuments.en.connect.approve,
      }),
    ).not.toBeInTheDocument();
  });

  it("guides installation and prompt copy before continuing to approval", async () => {
    window.history.replaceState(null, "", "/connect");
    const writeText = vi.fn<(value: string) => Promise<void>>(
      async () => undefined,
    );
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<AgentConnectPanel copy={localeDocuments.en} />);

    const installStep = screen
      .getByRole("heading", {
        name: localeDocuments.en.connect.installHeading,
      })
      .closest("section");
    const askStep = screen
      .getByRole("heading", { name: localeDocuments.en.connect.askHeading })
      .closest("section");
    const approveStep = screen
      .getByRole("heading", {
        name: localeDocuments.en.connect.pendingHeading,
      })
      .closest("section");

    expect(installStep).toHaveAttribute("data-step-state", "active");
    expect(installStep).toHaveAttribute("aria-current", "step");
    expect(askStep).toHaveAttribute("data-step-state", "next");
    expect(approveStep).toHaveAttribute("data-step-state", "next");

    expect(
      screen.getByRole("radio", {
        name: localeDocuments.en.connect.methodNames.windows,
      }),
    ).toBeChecked();
    expect(screen.queryByRole("radio", { name: /Codex/u })).toBeNull();
    expect(
      screen.getByText(localeDocuments.en.connect.automaticTargets),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.connect.copyCommand,
      }),
    );
    const windowsScriptUrl = new URL(
      "/downloads/install-skill.ps1",
      window.location.origin,
    ).toString();
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText).toHaveBeenNthCalledWith(
      1,
      `irm '${windowsScriptUrl}' | iex`,
    );
    expect(installStep).toHaveAttribute("data-step-state", "complete");
    expect(askStep).toHaveAttribute("data-step-state", "active");
    expect(askStep).toHaveFocus();
    expect(
      screen.getByText(localeDocuments.en.connect.stepCommandCopied),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.connect.copyPrompt,
      }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText).toHaveBeenNthCalledWith(
      2,
      localeDocuments.en.connect.askPrompt,
    );
    expect(askStep).toHaveAttribute("data-step-state", "complete");
    expect(approveStep).toHaveAttribute("data-step-state", "active");
    expect(approveStep).toHaveFocus();
    expect(
      screen.getByText(localeDocuments.en.connect.stepPromptCopied),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("radio", {
        name: localeDocuments.en.connect.methodNames.macos,
      }),
    );
    expect(screen.queryByRole("radio", { name: /Claude/u })).toBeNull();
    expect(installStep).toHaveAttribute("data-step-state", "active");
    expect(
      screen.getByText(
        `curl -fsSL '${new URL("/downloads/install-skill.sh", window.location.origin).toString()}' | sh`,
      ),
    ).toBeVisible();

    fireEvent.click(
      screen.getByRole("radio", {
        name: localeDocuments.en.connect.methodNames.manual,
      }),
    );
    const claudeOption = screen.getByRole("radio", { name: /Claude/u });
    expect(claudeOption).toBeVisible();
    expect(
      screen.getByRole("radio", {
        name: new RegExp(localeDocuments.en.connect.genericName, "u"),
      }),
    ).toBeVisible();
    fireEvent.click(claudeOption);
    const downloadSkill = screen.getByRole("link", {
      name: localeDocuments.en.connect.downloadSkill,
    });
    expect(downloadSkill).toHaveAttribute("href", "/downloads/yaaps-skill.zip");
    expect(screen.getByText("$HOME/.claude/skills/yaaps")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.connect.manualContinue,
      }),
    );
    expect(askStep).toHaveAttribute("data-step-state", "active");
    await waitFor(() => expect(askStep).toHaveFocus());
    expect(
      screen.getByText(localeDocuments.en.connect.stepInstalled),
    ).toBeVisible();

    fireEvent.change(
      screen.getByRole("textbox", {
        name: localeDocuments.en.connect.codeLabel,
      }),
      { target: { value: "abcd efgh" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.connect.continueToApproval,
      }),
    );

    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/dashboard/connect/approve?code=abcd+efgh",
    );
  });

  it("accepts a manually entered code and explicitly denies the request", async () => {
    window.history.replaceState(null, "", "/dashboard/connect/approve");
    document.cookie = "yaaps_csrf=csrf-token; Path=/";
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (
        url === "/auth/device-connections/lookup" &&
        init?.method === "POST" &&
        String(init.body).includes("abcd efgh")
      ) {
        return json(pendingRequest);
      }
      if (
        url === `/auth/device-connections/${pendingRequest.id}/deny` &&
        init?.method === "POST"
      ) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(
      <AgentConnectionApprovalPanel
        copy={localeDocuments.en}
        fetchImplementation={fetchImplementation}
        locale="en"
      />,
    );

    fireEvent.change(
      screen.getByRole("textbox", {
        name: localeDocuments.en.connect.codeLabel,
      }),
      { target: { value: "abcd efgh" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.connect.lookup,
      }),
    );

    expect(await screen.findByText(pendingRequest.label)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.connect.deny,
      }),
    );

    expect(
      await screen.findByText(localeDocuments.en.connect.deniedHeading),
    ).toBeVisible();
    expect(fetchImplementation).toHaveBeenCalledWith(
      `/auth/device-connections/${pendingRequest.id}/deny`,
      expect.objectContaining({
        body: JSON.stringify({ userCode: pendingRequest.userCode }),
        method: "POST",
      }),
    );
  });

  it("explains when the browser blocks clipboard access", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn(async () =>
          Promise.reject(new DOMException("Blocked", "NotAllowedError")),
        ),
      },
    });

    render(<AgentConnectPanel copy={localeDocuments.en} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.connect.copyCommand,
      }),
    );

    expect(
      await screen.findByText(localeDocuments.en.connect.copyFailed),
    ).toHaveAttribute("role", "alert");
    expect(
      screen
        .getByRole("heading", {
          name: localeDocuments.en.connect.installHeading,
        })
        .closest("section"),
    ).toHaveAttribute("data-step-state", "active");
  });

  it("shows an actionable expiry message without decision controls", async () => {
    window.history.replaceState(
      null,
      "",
      "/dashboard/connect/approve?code=ABCD-EFGH",
    );
    const fetchImplementation = vi.fn<typeof fetch>(async () =>
      json(
        {
          error: {
            code: "DEVICE_CONNECTION_EXPIRED",
            message: "Expired",
          },
        },
        410,
      ),
    );

    render(
      <AgentConnectionApprovalPanel
        copy={localeDocuments.he}
        fetchImplementation={fetchImplementation}
        locale="he"
      />,
    );

    expect(
      await screen.findByText(localeDocuments.he.connect.expired),
    ).toHaveAttribute("role", "alert");
    expect(
      screen.getByText(localeDocuments.he.connect.securityText),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", {
          name: localeDocuments.he.connect.approve,
        }),
      ).not.toBeInTheDocument(),
    );
  });
});
