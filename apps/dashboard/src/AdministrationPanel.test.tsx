// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdministrationPanel } from "./AdministrationPanel.js";
import { localeDocuments } from "./localization.js";

const adminId = "8f7c1ca3-edbc-4b4b-b349-d45322728936";
const memberId = "b75b47f4-5ab4-46c6-acaf-0bca45b46d23";
const invitationId = "b5915e09-bf47-4e7c-807b-0688d82419d0";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  cleanup();
  document.cookie = "yaaps_csrf=; Max-Age=0; Path=/";
});

describe("dashboard administration panel", () => {
  it("uses the shared Hebrew route heading and isolates invitation URLs", async () => {
    document.cookie = "yaaps_csrf=csrf-token; Path=/";
    const invitationLink = `${window.location.origin}/login?invite=yai_one-time-token`;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/dashboard/api/admin/users" && !init?.method) {
        return json({ items: [] });
      }
      if (url === "/dashboard/api/admin/invitations" && !init?.method) {
        return json({ items: [] });
      }
      if (url.startsWith("/dashboard/api/admin/drafts?") && !init?.method) {
        return json({ items: [] });
      }
      if (url === "/auth/invitations" && init?.method === "POST") {
        return json({
          expiresAt: "2026-08-25T08:00:00.000Z",
          id: invitationId,
          token: "yai_one-time-token",
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { container } = render(
      <AdministrationPanel
        copy={localeDocuments.he}
        currentUserId={adminId}
        fetchImplementation={fetchImplementation}
        locale="he"
      />,
    );

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: localeDocuments.he.management.adminHeading,
      }),
    ).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(
      screen.getByText(localeDocuments.he.management.adminIntro),
    ).toHaveClass("intro");
    expect(container.firstElementChild).toHaveClass(
      "dashboard-view",
      "administration-section",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.he.management.createInvitation,
      }),
    );

    const invitationCode = await screen.findByText(invitationLink);
    expect(invitationCode.tagName).toBe("CODE");
    expect(invitationCode).toHaveAttribute("dir", "ltr");
    expect(invitationCode.closest(".one-time-key")).not.toHaveAttribute("dir");
  });

  it("shows the category of a report without offering to change it", async () => {
    const category = "Weekly reports";
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/dashboard/api/admin/users" && !init?.method) {
        return json({ items: [] });
      }
      if (url === "/dashboard/api/admin/invitations" && !init?.method) {
        return json({ items: [] });
      }
      if (url.startsWith("/dashboard/api/admin/drafts?") && !init?.method) {
        return json({
          items: [
            {
              category,
              createdAt: "2026-08-24T08:00:00.000Z",
              expiresAt: "2026-08-31T08:00:00.000Z",
              id: "abcdefghijabcdefghijabcdefghijab",
              latestVersionNumber: 2,
              ownerDisplayName: "Member",
              ownerId: memberId,
              publicUrl:
                "https://share.example.test/d/abcdefghijabcdefghijabcdefghijab",
              status: "enabled",
              title: "Quarterly report",
              updatedAt: "2026-08-24T09:00:00.000Z",
            },
          ],
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const { container } = render(
      <AdministrationPanel
        copy={localeDocuments.en}
        currentUserId={adminId}
        fetchImplementation={fetchImplementation}
        locale="en"
      />,
    );

    await screen.findByText("Quarterly report");
    const chip = container.querySelector(".category-chip");
    expect(chip).toHaveTextContent(category);
    expect(chip?.closest(".admin-row")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: localeDocuments.en.management.categoryEdit,
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: localeDocuments.en.management.categoryClear,
      }),
    ).not.toBeInTheDocument();
  });

  it("creates one-time invitations and disables users with confirmation", async () => {
    document.cookie = "yaaps_csrf=csrf-token; Path=/";
    let invitationCreated = false;
    let memberDisabled = false;
    const fetchImplementation = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/dashboard/api/admin/users" && !init?.method) {
        return json({
          items: [
            {
              createdAt: "2026-08-24T08:00:00.000Z",
              disabledAt: null,
              displayName: "Admin",
              draftCount: 0,
              id: adminId,
              role: "admin",
              status: "active",
            },
            {
              createdAt: "2026-08-24T08:00:00.000Z",
              disabledAt: memberDisabled ? "2026-08-24T09:00:00.000Z" : null,
              displayName: "Member",
              draftCount: 2,
              id: memberId,
              role: "user",
              status: memberDisabled ? "disabled" : "active",
            },
          ],
        });
      }
      if (url === "/dashboard/api/admin/invitations" && !init?.method) {
        return json({
          items: invitationCreated
            ? [
                {
                  createdAt: "2026-08-24T08:00:00.000Z",
                  expiresAt: "2026-08-25T08:00:00.000Z",
                  id: invitationId,
                  role: "user",
                  status: "pending",
                },
              ]
            : [],
        });
      }
      if (url.startsWith("/dashboard/api/admin/drafts?") && !init?.method) {
        return json({ items: [] });
      }
      if (url === "/auth/invitations" && init?.method === "POST") {
        invitationCreated = true;
        return json({
          expiresAt: "2026-08-25T08:00:00.000Z",
          id: invitationId,
          token: "yai_one-time-token",
        });
      }
      if (
        url.endsWith(`/users/${memberId}/disable`) &&
        init?.method === "POST"
      ) {
        memberDisabled = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(
      <AdministrationPanel
        copy={localeDocuments.en}
        currentUserId={adminId}
        fetchImplementation={fetchImplementation}
        locale="en"
      />,
    );

    await screen.findByText("Member");
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.createInvitation,
      }),
    );
    expect(
      await screen.findByText(
        `${window.location.origin}/login?invite=yai_one-time-token`,
      ),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.savedInvitation,
      }),
    );
    expect(
      screen.queryByText(
        `${window.location.origin}/login?invite=yai_one-time-token`,
      ),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.disableUser,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: localeDocuments.en.management.confirmDisableUser,
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: localeDocuments.en.management.enableUser,
      }),
    ).toBeVisible();
    expect(fetchImplementation).toHaveBeenCalledWith(
      `/auth/users/${memberId}/disable`,
      expect.objectContaining({
        headers: expect.objectContaining({ "x-csrf-token": "csrf-token" }),
        method: "POST",
      }),
    );
  });
});
