import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readCliConfig, writeCliConfig } from "./config.js";
import { createProgram } from "./program.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-connect-test-"));
  temporaryPaths.push(directory);
  return directory;
}

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

describe("CLI device connection", () => {
  it("stores the locally generated key only after approval and never prints or sends it", async () => {
    const configDirectory = await temporaryDirectory();
    const outputs: string[] = [];
    const requests: Array<{ body: string; url: string }> = [];
    let pollCount = 0;
    const fetchImplementation = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = String(init?.body ?? "");
        requests.push({ body, url });
        if (url.endsWith("/auth/device-connections")) {
          return new Response(
            JSON.stringify({
              deviceSecret: `yad_${"a".repeat(43)}`,
              expiresAt: "2099-08-24T00:10:00.000Z",
              intervalSeconds: 2,
              userCode: "ABCD-EFGH",
              verificationUrl:
                "https://share.example/dashboard/connect/approve",
              verificationUrlComplete:
                "https://share.example/dashboard/connect/approve?code=ABCD-EFGH",
            }),
            { headers: { "content-type": "application/json" }, status: 201 },
          );
        }
        pollCount += 1;
        return new Response(
          JSON.stringify(
            pollCount === 1
              ? { status: "pending" }
              : {
                  apiKeyId: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
                  status: "approved",
                },
          ),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      },
    ) as unknown as typeof fetch;
    const openExternal = vi.fn(async () => undefined);
    const program = createProgram({
      configDirectory,
      environment: {},
      fetchImplementation,
      openExternal,
      sleep: async () => undefined,
      writeOutput: (message) => outputs.push(message),
    });

    await program.parseAsync([
      "node",
      "yaaps",
      "connect",
      "--api-url",
      "https://share.example",
      "--label",
      "Claude desktop",
      "--json",
    ]);

    const config = await readCliConfig(configDirectory);
    expect(config.apiKey).toMatch(/^yaaps_[A-Za-z0-9_-]{10}_/);
    expect(config.apiUrl).toBe("https://share.example");
    const createBody = JSON.parse(requests[0]!.body) as Record<string, string>;
    expect(createBody).toEqual({
      keyHash: createHash("sha256").update(config.apiKey!).digest("hex"),
      keyPrefix: config.apiKey!.slice(0, 16),
      label: "Claude desktop",
    });
    expect(
      requests.every((request) => !request.body.includes(config.apiKey!)),
    ).toBe(true);
    expect(outputs.join("\n")).toContain('"status":"pending"');
    expect(outputs.join("\n")).toContain('"status":"approved"');
    expect(outputs.join("\n")).not.toContain(config.apiKey!);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("preserves existing credentials when browser approval is denied", async () => {
    const configDirectory = await temporaryDirectory();
    const existing = {
      apiKey: "yaaps_oldprefix_oldsecret",
      apiUrl: "https://old.example",
      drafts: { "/report.html": { draftId: "A".repeat(32) } },
      version: 1 as const,
    };
    await writeCliConfig(configDirectory, existing);
    const errors: string[] = [];
    const fetchImplementation = vi.fn(
      async (input: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(input).endsWith("/auth/device-connections")
              ? {
                  deviceSecret: `yad_${"b".repeat(43)}`,
                  expiresAt: "2099-08-24T00:10:00.000Z",
                  intervalSeconds: 2,
                  userCode: "JKLM-NPQR",
                  verificationUrl:
                    "https://share.example/dashboard/connect/approve",
                  verificationUrlComplete:
                    "https://share.example/dashboard/connect/approve?code=JKLM-NPQR",
                }
              : { status: "denied" },
          ),
          {
            headers: { "content-type": "application/json" },
            status: String(input).endsWith("/auth/device-connections")
              ? 201
              : 200,
          },
        ),
    ) as unknown as typeof fetch;
    const openExternal = vi.fn(async () => undefined);
    const program = createProgram({
      configDirectory,
      environment: {},
      fetchImplementation,
      openExternal,
      sleep: async () => undefined,
      writeError: (message) => errors.push(message),
      writeOutput: () => undefined,
    });

    await program.parseAsync([
      "node",
      "yaaps",
      "connect",
      "--api-url",
      "https://share.example",
    ]);

    expect(errors).toEqual([
      "YAAPS connect failed: The connection request was denied.",
    ]);
    expect(openExternal).toHaveBeenCalledWith(
      "https://share.example/dashboard/connect/approve?code=JKLM-NPQR",
    );
    expect(await readCliConfig(configDirectory)).toEqual(existing);
  });
});
