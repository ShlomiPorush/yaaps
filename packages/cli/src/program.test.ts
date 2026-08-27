import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readCliConfig, writeCliConfig } from "./config.js";
import {
  createProgram,
  escapeDraftIdOperands,
  shouldOpenVerificationUrl,
} from "./program.js";

const temporaryPaths: string[] = [];

const dashDraftId = "-kE3bGEycgPf3BtwUKGyvs1mlgTulCu1";

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-cli-program-"));
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

describe("CLI program safety", () => {
  it("opens interactive connections but respects automation controls", () => {
    expect(shouldOpenVerificationUrl(undefined, true, "default")).toBe(true);
    expect(shouldOpenVerificationUrl(undefined, false, "cli")).toBe(false);
    expect(shouldOpenVerificationUrl(true, true, "default")).toBe(false);
    expect(shouldOpenVerificationUrl(true, true, "cli")).toBe(true);
  });

  it("clears local mappings when the configured API key changes", async () => {
    const configDirectory = await temporaryDirectory();
    const oldKey = "yaaps_oldprefix_oldsecret";
    const newKey = "yaaps_newprefix_newsecret";
    await writeCliConfig(configDirectory, {
      apiKey: oldKey,
      apiUrl: "https://share.example.test",
      drafts: { "/report.html": { draftId: "A".repeat(32) } },
      version: 1,
    });
    const output: string[] = [];
    const program = createProgram({
      configDirectory,
      environment: {},
      writeOutput: (message) => output.push(message),
    });

    await program.parseAsync([
      "node",
      "yaaps",
      "config",
      "set",
      "--api-url",
      "https://share.example.test",
      "--api-key",
      newKey,
    ]);

    expect((await readCliConfig(configDirectory)).drafts).toEqual({});
    expect(output.join("\n")).not.toContain(newKey);
  });

  it("shows only a non-secret API key prefix", async () => {
    const configDirectory = await temporaryDirectory();
    const apiKey = "yaaps_visibleprefix_hiddensecret";
    await writeCliConfig(configDirectory, {
      apiKey,
      apiUrl: "https://share.example.test",
      drafts: {},
      version: 1,
    });
    const output: string[] = [];
    const program = createProgram({
      configDirectory,
      environment: {},
      writeOutput: (message) => output.push(message),
    });

    await program.parseAsync(["node", "yaaps", "config", "show", "--json"]);

    expect(output.join("\n")).toContain("yaaps_visibleprefix");
    expect(output.join("\n")).not.toContain("hiddensecret");
  });
});

describe("CLI draft ID escaping", () => {
  it("hoists a dash-leading draft ID operand behind a terminator", () => {
    const program = createProgram();

    expect(escapeDraftIdOperands(program, ["disable", dashDraftId])).toEqual([
      "disable",
      "--",
      dashDraftId,
    ]);
    expect(escapeDraftIdOperands(program, ["inspect", dashDraftId])).toEqual([
      "inspect",
      "--",
      dashDraftId,
    ]);
  });

  it("keeps a dash-leading draft ID attached to the option that takes it", () => {
    const program = createProgram();

    expect(
      escapeDraftIdOperands(program, [
        "delete",
        dashDraftId,
        "--confirm",
        dashDraftId,
      ]),
    ).toEqual(["delete", "--confirm", dashDraftId, "--", dashDraftId]);
  });

  it("never hoists an option value that looks like a draft ID", () => {
    const program = createProgram();
    const argv = ["publish", "report.html", "--title", dashDraftId];

    expect(escapeDraftIdOperands(program, argv)).toEqual(argv);
  });

  it("keeps existing passthrough operands after the hoisted draft IDs", () => {
    const program = createProgram();

    expect(
      escapeDraftIdOperands(program, [
        "delete",
        dashDraftId,
        "--confirm",
        dashDraftId,
        "--",
        "already-passed-through",
      ]),
    ).toEqual([
      "delete",
      "--confirm",
      dashDraftId,
      "--",
      dashDraftId,
      "already-passed-through",
    ]);
  });

  it("keeps operands in order when a dash-leading draft ID leads them", () => {
    const program = createProgram();

    expect(
      escapeDraftIdOperands(program, ["categorize", dashDraftId, "Sales"]),
    ).toEqual(["categorize", "--", dashDraftId, "Sales"]);
    expect(
      escapeDraftIdOperands(program, ["categorize", dashDraftId, "--clear"]),
    ).toEqual(["categorize", "--clear", "--", dashDraftId]);
  });

  it("returns argv unchanged when no token looks like a draft ID", () => {
    const program = createProgram();
    const argv = ["list", "--limit", "10", "--json"];

    expect(escapeDraftIdOperands(program, argv)).toEqual(argv);
  });
});

describe("CLI commands with dash-leading draft IDs", () => {
  const summary = {
    category: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    expiresAt: "2026-08-27T00:00:00.000Z",
    id: dashDraftId,
    latestVersionNumber: 1,
    publicUrl: `https://share.example.test/d/${dashDraftId}`,
    resourcePolicy: "isolated",
    status: "disabled",
    title: "Dash report",
    updatedAt: "2026-08-26T00:00:00.000Z",
    viewCount: 0,
  };

  async function buildProgram(response: Response) {
    const configDirectory = await temporaryDirectory();
    const errors: string[] = [];
    const output: string[] = [];
    const requests: Array<{ body: string; method: string; url: string }> = [];
    const fetchImplementation = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          body: String(init?.body ?? ""),
          method: String(init?.method ?? "GET"),
          url: String(input),
        });
        return response.clone();
      },
    ) as unknown as typeof fetch;
    const program = createProgram({
      configDirectory,
      environment: {
        YAAPS_API_KEY: "yaaps_prefix_secret",
        YAAPS_API_URL: "https://share.example.test",
      },
      fetchImplementation,
      writeError: (message) => errors.push(message),
      writeOutput: (message) => output.push(message),
    });
    return { errors, output, program, requests };
  }

  it("disables a draft whose ID starts with a dash", async () => {
    const { errors, output, program, requests } = await buildProgram(
      new Response(JSON.stringify(summary), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );

    await program.parseAsync(
      escapeDraftIdOperands(program, ["disable", dashDraftId]),
      { from: "user" },
    );

    expect(errors).toEqual([]);
    expect(process.exitCode).not.toBe(1);
    expect(requests).toEqual([
      {
        body: '{"status":"disabled"}',
        method: "PATCH",
        url: `https://share.example.test/api/drafts/${dashDraftId}`,
      },
    ]);
    expect(output.join("\n")).toContain(`${dashDraftId} is now disabled.`);
  });

  it("deletes a draft whose ID starts with a dash", async () => {
    const { errors, output, program, requests } = await buildProgram(
      new Response(null, { status: 204 }),
    );

    await program.parseAsync(
      escapeDraftIdOperands(program, [
        "delete",
        dashDraftId,
        "--confirm",
        dashDraftId,
      ]),
      { from: "user" },
    );

    expect(errors).toEqual([]);
    expect(process.exitCode).not.toBe(1);
    expect(requests).toEqual([
      {
        body: "",
        method: "DELETE",
        url: `https://share.example.test/api/drafts/${dashDraftId}`,
      },
    ]);
    expect(output.join("\n")).toContain(`Deleted draft ${dashDraftId}.`);
  });
});

describe("CLI draft categories", () => {
  const draftId = "C".repeat(32);
  const summary = {
    category: "Sales",
    createdAt: "2026-08-26T00:00:00.000Z",
    expiresAt: "2026-08-27T00:00:00.000Z",
    id: draftId,
    latestVersionNumber: 2,
    publicUrl: `https://share.example.test/d/${draftId}`,
    resourcePolicy: "isolated",
    status: "enabled",
    title: "Quarterly report",
    updatedAt: "2026-08-26T00:00:00.000Z",
    viewCount: 0,
  };

  async function buildProgram(
    payload: unknown | ((requestUrl: string) => unknown),
  ) {
    const configDirectory = await temporaryDirectory();
    const workingDirectory = await temporaryDirectory();
    await writeFile(
      path.join(workingDirectory, "report.html"),
      '<!doctype html><html lang="en"><head><title>Quarterly report</title></head><body><h1>Quarterly</h1></body></html>',
      "utf8",
    );
    const errors: string[] = [];
    const output: string[] = [];
    const requests: Array<{ body: string; method: string; url: string }> = [];
    const fetchImplementation = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body;
        requests.push({
          body: typeof body === "string" ? body : "",
          method: String(init?.method ?? "GET"),
          url: String(input),
        });
        const responsePayload =
          typeof payload === "function" ? payload(String(input)) : payload;
        return new Response(JSON.stringify(responsePayload), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
    ) as unknown as typeof fetch;
    const program = createProgram({
      configDirectory,
      environment: {
        YAAPS_API_KEY: "yaaps_prefix_secret",
        YAAPS_API_URL: "https://share.example.test",
      },
      fetchImplementation,
      workingDirectory,
      writeError: (message) => errors.push(message),
      writeOutput: (message) => output.push(message),
    });
    return { errors, output, program, requests };
  }

  it("sends the category when creating a draft and when adding a version", async () => {
    const published = {
      draft: summary,
      version: {
        byteLength: 128,
        createdAt: "2026-08-26T00:00:00.000Z",
        publicUrl: `${summary.publicUrl}/v/2`,
        resourcePolicy: "isolated",
        sha256: "a".repeat(64),
        versionNumber: 2,
        viewCount: 0,
      },
    };

    const created = await buildProgram(published);
    await created.program.parseAsync([
      "node",
      "yaaps",
      "publish",
      "report.html",
      "--category",
      "Sales reports",
      "--json",
    ]);
    expect(created.errors).toEqual([]);
    expect(created.requests[0]?.url).toBe(
      "https://share.example.test/api/drafts?resourcePolicy=isolated&category=Sales+reports",
    );

    const versioned = await buildProgram(published);
    await versioned.program.parseAsync([
      "node",
      "yaaps",
      "publish",
      "report.html",
      "--draft-id",
      draftId,
      "--category",
      "Sales reports",
      "--json",
    ]);
    expect(versioned.errors).toEqual([]);
    expect(versioned.requests[0]?.url).toBe(
      `https://share.example.test/api/drafts/${draftId}/versions?resourcePolicy=isolated&category=Sales+reports`,
    );
  });

  it("sends the selected connected resource policy", async () => {
    const published = {
      draft: summary,
      version: {
        byteLength: 128,
        createdAt: "2026-08-26T00:00:00.000Z",
        publicUrl: `${summary.publicUrl}/v/2`,
        resourcePolicy: "connected",
        sha256: "a".repeat(64),
        versionNumber: 2,
        viewCount: 0,
      },
    };
    const connected = await buildProgram(published);

    await connected.program.parseAsync([
      "node",
      "yaaps",
      "publish",
      "report.html",
      "--mode",
      "connected",
      "--json",
    ]);

    expect(connected.errors).toEqual([]);
    expect(connected.requests[0]?.url).toBe(
      "https://share.example.test/api/drafts?resourcePolicy=connected",
    );
  });

  it("filters the list by category and prints it in the human format", async () => {
    const { errors, output, program, requests } = await buildProgram({
      items: [summary, { ...summary, category: null, id: "D".repeat(32) }],
      limit: 50,
      offset: 0,
      total: 2,
    });

    await program.parseAsync([
      "node",
      "yaaps",
      "list",
      "--category",
      "Sales reports",
    ]);

    expect(errors).toEqual([]);
    expect(requests[0]?.url).toBe(
      "https://share.example.test/api/drafts?limit=50&offset=0&category=Sales+reports",
    );
    expect(output.join("\n").split("\n")).toEqual([
      `${draftId}  enabled  v2  Quarterly report  Sales  ${summary.publicUrl}`,
      `${"D".repeat(32)}  enabled  v2  Quarterly report  Uncategorized  https://share.example.test/d/${draftId}`,
    ]);
  });

  it("shows the latest resource policy in human inspect output", async () => {
    const connectedSummary = {
      ...summary,
      resourcePolicy: "connected" as const,
    };
    const { errors, output, program } = await buildProgram(
      (requestUrl: string) =>
        requestUrl.includes("/versions?")
          ? {
              items: [
                {
                  byteLength: 128,
                  createdAt: "2026-08-26T00:00:00.000Z",
                  publicUrl: `${summary.publicUrl}/v/2`,
                  resourcePolicy: "connected",
                  sha256: "a".repeat(64),
                  versionNumber: 2,
                  viewCount: 0,
                },
              ],
              limit: 100,
              offset: 0,
              total: 1,
            }
          : connectedSummary,
    );

    await program.parseAsync(["node", "yaaps", "inspect", draftId]);

    expect(errors).toEqual([]);
    expect(output.join("\n")).toContain("Resource policy: connected.");
  });

  it("sets and clears a category, including for a dash-leading draft ID", async () => {
    const set = await buildProgram(summary);
    await set.program.parseAsync(
      escapeDraftIdOperands(set.program, [
        "categorize",
        dashDraftId,
        "Sales reports",
      ]),
      { from: "user" },
    );
    expect(set.errors).toEqual([]);
    expect(set.requests).toEqual([
      {
        body: '{"category":"Sales reports"}',
        method: "PATCH",
        url: `https://share.example.test/api/drafts/${dashDraftId}`,
      },
    ]);
    expect(set.output.join("\n")).toContain(`${draftId} is now in Sales.`);

    const cleared = await buildProgram({ ...summary, category: null });
    await cleared.program.parseAsync(
      escapeDraftIdOperands(cleared.program, [
        "categorize",
        dashDraftId,
        "--clear",
      ]),
      { from: "user" },
    );
    expect(cleared.errors).toEqual([]);
    expect(cleared.requests[0]?.body).toBe('{"category":null}');
    expect(cleared.output.join("\n")).toContain(
      `${draftId} is now uncategorized.`,
    );
  });

  it("rejects a categorize call that passes both a category and --clear", async () => {
    const { errors, program, requests } = await buildProgram(summary);

    await program.parseAsync([
      "node",
      "yaaps",
      "categorize",
      draftId,
      "Sales",
      "--clear",
    ]);

    expect(errors).toEqual([
      "YAAPS categorize failed: A category and --clear cannot be used together.",
    ]);
    expect(process.exitCode).toBe(1);
    expect(requests).toEqual([]);
  });

  it("rejects a categorize call that passes neither a category nor --clear", async () => {
    const { errors, program, requests } = await buildProgram(summary);

    await program.parseAsync(["node", "yaaps", "categorize", draftId]);

    expect(errors).toEqual([
      "YAAPS categorize failed: Provide a category or --clear.",
    ]);
    expect(process.exitCode).toBe(1);
    expect(requests).toEqual([]);
  });
});
