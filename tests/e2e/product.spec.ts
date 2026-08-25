import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";

const BOOTSTRAP_SECRET = "yaaps-playwright-bootstrap-secret-2026";
const SECURITY_REPORT_URL = `http://localhost:4174/d/${"S".repeat(32)}`;
const execFileAsync = promisify(execFile);
const bashExecutable =
  process.platform === "win32"
    ? path.join(
        process.env.ProgramFiles ?? "C:\\Program Files",
        "Git",
        "bin",
        "bash.exe",
      )
    : "bash";
const hebrew = JSON.parse(
  readFileSync(
    new URL("../../apps/dashboard/src/locales/he.json", import.meta.url),
    "utf8",
  ),
) as {
  actions: { switchLanguage: string; switchTheme: string };
  auth: {
    recoveryCode: string;
    signInWithPasskey: string;
    signOut: string;
    useRecoveryCode: string;
  };
  connect: { heading: string };
  management: {
    adminHeading: string;
    heading: string;
    loading: string;
    summary: string;
  };
  dashboard: { heading: string };
  docs: { heading: string };
};
const english = JSON.parse(
  readFileSync(
    new URL("../../apps/dashboard/src/locales/en.json", import.meta.url),
    "utf8",
  ),
) as {
  actions: { switchLanguage: string };
  auth: {
    addPasskey: string;
    bootstrapHeading: string;
    bootstrapSecret: string;
    createPasskey: string;
    displayName: string;
    passkeyAdded: string;
    signInHeading: string;
  };
  connect: {
    approve: string;
    approvedHeading: string;
    heading: string;
    methodNames: { macos: string; manual: string; windows: string };
  };
  dashboard: { heading: string };
  docs: { heading: string };
  management: {
    adminHeading: string;
    confirmDisableUser: string;
    createInvitation: string;
    createKey: string;
    disable: string;
    disableUser: string;
    enable: string;
    heading: string;
    keyLabel: string;
    loading: string;
    summary: string;
  };
  navigation: {
    administration: string;
    connect: string;
    docs: string;
    settings: string;
  };
};

async function addVirtualAuthenticator(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  await session.send("WebAuthn.enable");
  const { authenticatorId } = await session.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        automaticPresenceSimulation: true,
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        protocol: "ctap2",
        transport: "internal",
      },
    },
  );
  return { authenticatorId, session };
}

async function holdManagementRequests(page: Page) {
  let releaseRequests!: () => void;
  const requestGate = new Promise<void>((resolve) => {
    releaseRequests = resolve;
  });
  const delayedRequest = async (route: Route) => {
    await requestGate;
    await route.continue();
  };
  await page.route("**/dashboard/api/drafts?**", delayedRequest);
  await page.route("**/auth/api-keys", delayedRequest);
  return async () => {
    releaseRequests();
    await page.unroute("**/dashboard/api/drafts?**", delayedRequest);
    await page.unroute("**/auth/api-keys", delayedRequest);
  };
}

test("presents the product and API documentation across locales and viewports", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol !== "data:" && url.origin !== "http://localhost:4173") {
      externalRequests.push(request.url());
    }
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: english.dashboard.heading }),
  ).toBeVisible();
  const documentationLink = page
    .getByRole("navigation")
    .getByRole("link", { exact: true, name: english.navigation.docs });
  await expect(documentationLink).toBeVisible();
  const connectionLink = page
    .getByRole("navigation")
    .getByRole("link", { exact: true, name: english.navigation.connect });
  await expect(connectionLink).toBeVisible();
  await expect(page.getByRole("navigation").getByRole("link")).toHaveText([
    english.navigation.connect,
    english.navigation.docs,
    english.navigation.dashboard,
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await connectionLink.click();
  await expect(page).toHaveURL(/\/connect$/u);
  await expect(
    page.getByRole("heading", { name: english.connect.heading }),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: english.connect.methodNames.windows }),
  ).toBeChecked();
  await page
    .getByRole("radio", { name: english.connect.methodNames.macos })
    .click();
  await expect(
    page.getByRole("radio", { name: english.connect.methodNames.macos }),
  ).toBeChecked();
  await page
    .getByRole("radio", { name: english.connect.methodNames.manual })
    .click();
  await expect(
    page.getByRole("radio", { name: english.connect.methodNames.manual }),
  ).toBeChecked();
  await page.setViewportSize({ height: 844, width: 390 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: english.actions.switchLanguage })
    .click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByRole("heading", { name: hebrew.connect.heading }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: hebrew.actions.switchLanguage })
    .click();
  await page.setViewportSize({ height: 900, width: 1280 });

  await page.goto("/");
  await documentationLink.click();
  await expect(
    page.getByRole("heading", { name: english.docs.heading }),
  ).toBeVisible();
  await expect(page.locator(".docs-install-options")).toHaveCount(0);
  await expect(
    page.locator('.docs-content a[href^="/downloads/"]'),
  ).toHaveCount(0);
  await expect(page.locator(".endpoint-row")).toHaveCount(7);
  const openApi = await page.request.get("/openapi.json");
  expect(openApi.status()).toBe(200);
  expect(await openApi.json()).toMatchObject({
    info: { title: "YAAPS API" },
    openapi: "3.1.0",
  });

  await page.setViewportSize({ height: 844, width: 390 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: english.actions.switchLanguage })
    .click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByRole("heading", { name: hebrew.docs.heading }),
  ).toBeVisible();
  const firstEndpoint = page.locator(".endpoint-row").first();
  await expect(firstEndpoint.locator("p")).toHaveCSS("direction", "rtl");
  await expect(firstEndpoint.locator(".method-badge")).toHaveCSS(
    "direction",
    "ltr",
  );
  await expect(firstEndpoint.locator("code")).toHaveCSS("direction", "ltr");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: hebrew.dashboard.heading }),
  ).toBeVisible();
  await expect(page.locator(".terminal-strip small")).toHaveCSS(
    "direction",
    "rtl",
  );
  await expect(page.locator(".terminal-strip code").first()).toHaveCSS(
    "direction",
    "rtl",
  );
  await expect(page.locator(".terminal-strip-result bdi")).toHaveCSS(
    "direction",
    "ltr",
  );

  await page.setViewportSize({ height: 900, width: 1280 });
  await page.goto("/docs/swagger");
  await expect(page.locator(".swagger-ui .info .title")).toContainText(
    "YAAPS API",
  );
  await page.goto("/docs/redoc");
  await expect(page.locator("#redoc-container h1")).toContainText("YAAPS API");
  expect(externalRequests).toEqual([]);
});

test("completes the browser product lifecycle with real WebAuthn ceremonies", async ({
  browser,
  context,
  page,
}) => {
  const deviceKeySecret = randomBytes(32).toString("base64url");
  const deviceKeyPrefix = `yaaps_${deviceKeySecret.slice(0, 10)}`;
  const deviceApiKey = `${deviceKeyPrefix}_${deviceKeySecret}`;
  const connectionResponse = await page.request.post(
    "/auth/device-connections",
    {
      data: {
        keyHash: createHash("sha256")
          .update(deviceApiKey, "utf8")
          .digest("hex"),
        keyPrefix: deviceKeyPrefix,
        label: "E2E Claude agent",
      },
    },
  );
  expect(connectionResponse.status()).toBe(201);
  const connection = (await connectionResponse.json()) as {
    deviceSecret: string;
    userCode: string;
    verificationUrlComplete: string;
  };
  expect(new URL(connection.verificationUrlComplete).pathname).toBe(
    "/dashboard/connect/approve",
  );

  const firstAuthenticator = await addVirtualAuthenticator(context, page);
  await page.goto(connection.verificationUrlComplete);
  await expect(page).toHaveURL(
    new RegExp(
      `/login\\?returnTo=${encodeURIComponent(`/dashboard/connect/approve?code=${connection.userCode}`)}`,
      "u",
    ),
  );
  await expect(
    page.getByRole("heading", { name: english.auth.bootstrapHeading }),
  ).toBeVisible();
  await page.getByLabel(english.auth.displayName).fill("E2E administrator");
  await page.getByLabel(english.auth.bootstrapSecret).fill(BOOTSTRAP_SECRET);
  await page.getByRole("button", { name: english.auth.createPasskey }).click();
  await expect(page).toHaveURL(
    `/dashboard/connect/approve?code=${connection.userCode}`,
  );
  await expect(page.getByText("E2E Claude agent")).toBeVisible();
  const recoveryCode = await page
    .locator(".recovery-codes code")
    .first()
    .textContent();
  expect(recoveryCode).toBeTruthy();
  await page
    .getByRole("button", { name: english.actions.switchLanguage })
    .click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator(".recovery-codes code").first()).toHaveCSS(
    "direction",
    "ltr",
  );
  await page
    .getByRole("button", { name: hebrew.actions.switchLanguage })
    .click();

  for (const publicPath of ["/", "/docs", "/connect"]) {
    await page.goto(publicPath);
    await expect(
      page.getByRole("button", { name: english.auth.signOut }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        exact: true,
        name: english.navigation.settings,
      }),
    ).toBeVisible();
    const navigationLinks = page
      .getByRole("navigation", { name: english.navigation.ariaLabel })
      .getByRole("link");
    await expect(navigationLinks.first()).toHaveText(
      english.navigation.connect,
    );
    await expect(navigationLinks.first()).toHaveClass(/connect-nav-link/u);
  }
  await page.goto("/");
  await expect(page.getByText(english.dashboard.unavailable)).toHaveCount(0);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/connect");
  await expect(
    page.getByRole("button", { name: english.auth.signOut }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ height: 900, width: 1280 });

  await page.goto("/dashboard/settings");

  await page
    .getByRole("link", { exact: true, name: english.navigation.settings })
    .click();
  await page
    .getByLabel(english.management.keyLabel)
    .fill("E2E publishing agent");
  await page
    .getByRole("button", { name: english.management.createKey })
    .click();
  const apiKey = await page.locator(".one-time-key code").first().textContent();
  expect(apiKey).toMatch(/^yaaps_/);
  await page
    .getByRole("button", { name: english.actions.switchLanguage })
    .click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator(".one-time-key code").first()).toHaveCSS(
    "direction",
    "ltr",
  );
  await expect(page.locator(".key-item code").first()).toHaveCSS(
    "direction",
    "ltr",
  );
  await page
    .getByRole("button", { name: hebrew.actions.switchLanguage })
    .click();

  await page.goto(connection.verificationUrlComplete);
  await expect(page.getByText("E2E Claude agent")).toBeVisible();
  await page.getByRole("button", { name: english.connect.approve }).click();
  await expect(page.getByText(english.connect.approvedHeading)).toBeVisible();

  const pollResponse = await page.request.post(
    "/auth/device-connections/token",
    { data: { deviceSecret: connection.deviceSecret } },
  );
  expect(pollResponse.status()).toBe(200);
  expect(await pollResponse.json()).toMatchObject({ status: "approved" });
  const devicePublication = await page.request.post(
    "/api/drafts?title=Device%20connection%20proof",
    {
      data: "<!doctype html><html><head><title>Device connection proof</title></head><body><h1>Connected securely</h1></body></html>",
      headers: {
        authorization: `Bearer ${deviceApiKey}`,
        "content-type": "text/html",
      },
    },
  );
  expect(devicePublication.status()).toBe(201);

  const smoke = await execFileAsync(
    bashExecutable,
    [path.resolve("tests/operations/smoke.sh").replaceAll(path.sep, "/")],
    {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        YAAPS_SMOKE_API_KEY: apiKey!,
        YAAPS_SMOKE_ORIGIN: "http://localhost:4173",
      },
      windowsHide: true,
    },
  );
  expect(smoke.stdout).toContain("YAAPS smoke test passed");
  expect(smoke.stdout).not.toContain(apiKey!);

  const published = await page.request.post("/api/drafts?title=E2E%20report", {
    data: "<!doctype html><html><head><title>E2E report</title></head><body><h1>Published by Playwright</h1></body></html>",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "text/html",
    },
  });
  expect(published.status()).toBe(201);
  const publication = (await published.json()) as {
    draft: { publicUrl: string };
  };

  const releaseManagementRequests = await holdManagementRequests(page);
  await page.goto("/dashboard");
  await expect(page.getByText(english.management.loading)).toBeVisible();
  await expect(page.getByLabel(english.management.summary)).not.toBeAttached();
  await releaseManagementRequests();
  await expect(page.getByLabel(english.management.summary)).toBeVisible();
  const report = page.locator(".draft-item", { hasText: "E2E report" });
  await expect(report).toBeVisible();
  await report
    .getByRole("button", { name: english.management.disable })
    .click();
  expect((await page.request.get(publication.draft.publicUrl)).status()).toBe(
    404,
  );
  await report.getByRole("button", { name: english.management.enable }).click();
  expect((await page.request.get(publication.draft.publicUrl)).status()).toBe(
    200,
  );

  await firstAuthenticator.session.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: firstAuthenticator.authenticatorId,
  });
  await firstAuthenticator.session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      automaticPresenceSimulation: true,
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      protocol: "ctap2",
      transport: "internal",
    },
  });
  await page
    .getByRole("link", { exact: true, name: english.navigation.settings })
    .click();
  await page.getByRole("button", { name: english.auth.addPasskey }).click();
  await expect(page.getByText(english.auth.passkeyAdded)).toBeVisible();

  await page
    .getByRole("link", { exact: true, name: english.navigation.administration })
    .click();
  await page.setViewportSize({ height: 900, width: 1280 });
  const administrationHeading = page.getByRole("heading", {
    level: 1,
    name: english.management.adminHeading,
  });
  await expect(administrationHeading).toBeVisible();
  const desktopHeadingSize = await administrationHeading.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(desktopHeadingSize).toBeGreaterThan(40);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: english.management.createInvitation })
    .click();
  const invitationLink = await page
    .locator(".administration-section .one-time-key code")
    .textContent();
  expect(invitationLink).toContain("/login?invite=yai_");
  await page
    .getByRole("button", { name: english.actions.switchLanguage })
    .click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: hebrew.management.adminHeading,
    }),
  ).toBeVisible();
  await expect(page.locator(".dashboard-heading h1")).toHaveCSS(
    "font-size",
    "73.6px",
  );
  await expect(
    page.locator(".administration-section .one-time-key code"),
  ).toHaveCSS("direction", "ltr");
  await page
    .getByRole("button", { name: hebrew.actions.switchLanguage })
    .click();

  const invitedContext = await browser.newContext();
  const invitedPage = await invitedContext.newPage();
  await addVirtualAuthenticator(invitedContext, invitedPage);
  await invitedPage.goto(invitationLink!);
  await invitedPage
    .getByLabel(english.auth.displayName)
    .fill("E2E invited user");
  await invitedPage
    .getByRole("button", { name: english.auth.createPasskey })
    .click();
  await expect(
    invitedPage.getByRole("heading", { name: english.management.heading }),
  ).toBeVisible();

  await page.reload();
  const invitedUser = page.locator(".user-row", {
    hasText: "E2E invited user",
  });
  await expect(invitedUser).toBeVisible();
  await invitedUser
    .getByRole("button", { name: english.management.disableUser })
    .click();
  await invitedUser
    .getByRole("button", { name: english.management.confirmDisableUser })
    .click();
  await invitedPage.reload();
  await expect(
    invitedPage.getByRole("heading", { name: english.auth.signInHeading }),
  ).toBeVisible();
  await invitedContext.close();

  await page.goto("/dashboard");
  await page
    .getByRole("button", { name: english.actions.switchLanguage })
    .click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.setViewportSize({ height: 844, width: 390 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const previousTheme = await page.locator("html").getAttribute("data-theme");
  await page.getByRole("button", { name: hebrew.actions.switchTheme }).click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-theme",
    previousTheme!,
  );

  const releaseHebrewManagementRequests = await holdManagementRequests(page);
  await page.goto("/dashboard");
  await expect(page.getByText(hebrew.management.loading)).toBeVisible();
  await expect(page.getByLabel(hebrew.management.summary)).not.toBeAttached();
  await releaseHebrewManagementRequests();
  await expect(page.getByLabel(hebrew.management.summary)).toBeVisible();

  await page.goto("/dashboard/admin");
  const mobileAdministrationHeading = page.getByRole("heading", {
    level: 1,
    name: hebrew.management.adminHeading,
  });
  await expect(mobileAdministrationHeading).toBeVisible();
  const mobileHeadingSize = await mobileAdministrationHeading.evaluate(
    (element) => Number.parseFloat(getComputedStyle(element).fontSize),
  );
  expect(mobileHeadingSize).toBeGreaterThan(24);
  expect(mobileHeadingSize).toBeLessThan(desktopHeadingSize);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.getByRole("button", { name: hebrew.auth.signOut }).click();
  await page
    .getByRole("button", {
      name: hebrew.auth.signInWithPasskey,
    })
    .click();
  await expect(
    page.getByRole("heading", {
      name: hebrew.management.heading,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: hebrew.auth.signOut }).click();
  const recoveryInput = page.getByLabel(hebrew.auth.recoveryCode);
  await expect(recoveryInput).toHaveCSS("direction", "ltr");
  expect(
    await recoveryInput.evaluate((element) =>
      getComputedStyle(element).fontFamily.toLowerCase(),
    ),
  ).toContain("monospace");
  await recoveryInput.fill(recoveryCode!);
  await page.getByRole("button", { name: hebrew.auth.useRecoveryCode }).click();
  await expect(
    page.getByRole("heading", {
      name: hebrew.management.heading,
    }),
  ).toBeVisible();
});

test("enforces the public report sandbox in Chromium", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page.goto(SECURITY_REPORT_URL);
  expect(response?.status()).toBe(200);
  expect(response?.headers()["content-security-policy"]).toContain("sandbox");
  expect(response?.headers()["content-security-policy"]).not.toContain(
    "allow-scripts",
  );
  await expect(
    page.getByRole("heading", { name: "YAAPS isolation fixture" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as Window & { yaapsUnsafeScriptRan?: boolean })
          .yaapsUnsafeScriptRan,
    ),
  ).toBeUndefined();
  const storageResult = await page.evaluate(() => {
    try {
      window.localStorage.setItem("yaaps-e2e", "unsafe");
      return "allowed";
    } catch (error) {
      return error instanceof DOMException ? error.name : "blocked";
    }
  });
  expect(storageResult).toBe("SecurityError");
  await page.getByRole("button", { name: "Submit blocked form" }).click();
  await expect(page).toHaveURL(SECURITY_REPORT_URL);
  // A zero-probe assertion is only as strong as its settle window: check,
  // prove the page is still live with a second interaction, and check again
  // so a delayed leak cannot slip past a single fixed wait.
  const readProbeCount = async () => {
    const probes = await context.request.get(
      "http://localhost:4174/__e2e/probes",
    );
    return ((await probes.json()) as { networkProbeCount: number })
      .networkProbeCount;
  };
  await page.waitForTimeout(500);
  expect(await readProbeCount()).toBe(0);
  await page.getByRole("button", { name: "Submit blocked form" }).click();
  await expect(page).toHaveURL(SECURITY_REPORT_URL);
  await page.waitForTimeout(500);
  expect(await readProbeCount()).toBe(0);
  await context.close();
});
