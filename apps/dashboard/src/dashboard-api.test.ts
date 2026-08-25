// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { DashboardApi } from "./dashboard-api.js";

describe("dashboard browser API client", () => {
  it("invokes native fetch without rebinding its browser receiver", async () => {
    const nativeLikeFetch = function (this: unknown, input: RequestInfo | URL) {
      if (this !== undefined) {
        throw new TypeError("Illegal invocation");
      }
      expect(String(input)).toBe("/auth/api-keys");
      return Promise.resolve(
        new Response(JSON.stringify({ items: [] }), { status: 200 }),
      );
    } as typeof fetch;

    await expect(
      new DashboardApi(nativeLikeFetch).listApiKeys(),
    ).resolves.toEqual({ items: [] });
  });
});
