import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  apiKeyPrefix,
  localMappingKey,
  readCliConfig,
  resolveCliConfigDirectory,
  writeCliConfig,
} from "./config.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-cli-config-"));
  temporaryPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

describe("CLI user configuration", () => {
  it("resolves Windows, XDG, and Linux fallback directories", () => {
    expect(
      resolveCliConfigDirectory(undefined, {
        environment: { APPDATA: "C:\\Users\\Person\\AppData\\Roaming" },
        homeDirectory: "C:\\Users\\Person",
        platform: "win32",
      }),
    ).toBe(path.join("C:\\Users\\Person\\AppData\\Roaming", "YAAPS"));
    expect(
      resolveCliConfigDirectory(undefined, {
        environment: { XDG_CONFIG_HOME: "/var/user-config" },
        homeDirectory: "/home/person",
        platform: "linux",
      }),
    ).toBe(path.join("/var/user-config", "yaaps"));
    expect(
      resolveCliConfigDirectory(undefined, {
        environment: {},
        homeDirectory: "/home/person",
        platform: "linux",
      }),
    ).toBe(path.join("/home/person", ".config", "yaaps"));
  });

  it("writes and reloads credentials and mappings without temporary leftovers", async () => {
    const directory = await temporaryDirectory();
    const config = {
      apiKey: "yaaps_abcdefghij_secretvalue",
      apiUrl: "https://share.example.test",
      drafts: { "C:\\report.html": { draftId: "A".repeat(32) } },
      version: 1 as const,
    };

    await writeCliConfig(directory, config);

    expect(await readCliConfig(directory)).toEqual(config);
    expect(
      await readFile(path.join(directory, "config.json"), "utf8"),
    ).not.toContain(".tmp");
    if (process.platform !== "win32") {
      expect(
        (await stat(path.join(directory, "config.json"))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("fails closed on malformed configuration", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "config.json"), "not json", "utf8");
    await expect(readCliConfig(directory)).rejects.toThrow("not valid JSON");

    await writeFile(
      path.join(directory, "config.json"),
      JSON.stringify({
        apiKey: "plaintext-but-not-a-key",
        drafts: {},
        version: 1,
      }),
      "utf8",
    );
    await expect(readCliConfig(directory)).rejects.toThrow("API key format");
  });

  it("normalizes Windows mapping keys case-insensitively", () => {
    expect(localMappingKey("C:\\Reports\\One.html", "win32")).toBe(
      localMappingKey("c:\\reports\\ONE.html", "win32"),
    );
  });

  it("derives display prefixes for server keys and legacy fixtures", () => {
    // Real server format: the 10-character prefix may contain underscores.
    expect(apiKeyPrefix("yaaps_aUy_0fgZgg_aUy_0fgZggRestOfSecret")).toBe(
      "yaaps_aUy_0fgZgg",
    );
    expect(apiKeyPrefix("yaaps_abcdefghij_secretvalue")).toBe(
      "yaaps_abcdefghij",
    );
    // Fallback for keys whose prefix segment is not 10 characters long.
    expect(apiKeyPrefix("yaaps_oldprefix_oldsecret")).toBe("yaaps_oldprefix");
  });
});
