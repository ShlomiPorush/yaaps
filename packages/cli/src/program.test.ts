import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readCliConfig, writeCliConfig } from "./config.js";
import { createProgram, shouldOpenVerificationUrl } from "./program.js";

const temporaryPaths: string[] = [];

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
