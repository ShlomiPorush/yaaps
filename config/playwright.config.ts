import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 10_000 },
  fullyParallel: false,
  globalSetup: "./playwright.global-setup.ts",
  outputDir: "../test-results",
  reporter: [
    ["line"],
    ["html", { open: "never", outputFolder: "../playwright-report" }],
  ],
  retries: process.env.CI ? 1 : 0,
  testDir: "../tests/e2e",
  timeout: 60_000,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:4173",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  workers: 1,
});
