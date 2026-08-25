import {
  FOUNDATION_VERSION,
  PRODUCT_NAME,
  type HealthResponse,
  type ReadinessResponse,
} from "@yaaps/contracts";
import { describe, expect, it, vi } from "vitest";

import { createProgram } from "./program.js";
import { fetchServiceStatus } from "./status.js";

const health: HealthResponse = {
  name: PRODUCT_NAME,
  status: "ok",
  version: FOUNDATION_VERSION,
};

const readiness: ReadinessResponse = {
  checks: { dataDirectory: "ok" },
  name: PRODUCT_NAME,
  status: "ready",
  version: FOUNDATION_VERSION,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("CLI status", () => {
  it("validates health and readiness responses", async () => {
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(health))
      .mockResolvedValueOnce(jsonResponse(readiness));

    const result = await fetchServiceStatus(
      "https://share.example.test",
      fetchImplementation,
    );

    expect(result).toEqual({ health, readiness });
    expect(fetchImplementation).toHaveBeenNthCalledWith(
      1,
      new URL("https://share.example.test/healthz"),
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("reports a not-ready service returned as HTTP 503 instead of throwing", async () => {
    const notReady: ReadinessResponse = {
      checks: { dataDirectory: "failed" },
      name: PRODUCT_NAME,
      status: "not_ready",
      version: FOUNDATION_VERSION,
    };
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(health))
      .mockResolvedValueOnce(jsonResponse(notReady, 503));

    const result = await fetchServiceStatus(
      "https://share.example.test",
      fetchImplementation,
    );

    expect(result.readiness).toEqual(notReady);
  });

  it("prints machine-readable status", async () => {
    const outputs: string[] = [];
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(health))
      .mockResolvedValueOnce(jsonResponse(readiness));
    const program = createProgram({
      fetchImplementation,
      writeOutput: (message) => outputs.push(message),
    });

    await program.parseAsync([
      "node",
      "yaaps",
      "status",
      "--api-url",
      "https://share.example.test",
      "--json",
    ]);

    expect(JSON.parse(outputs[0] ?? "{}")).toEqual({ health, readiness });
  });
});
