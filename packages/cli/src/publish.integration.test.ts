import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication } from "../../../apps/server/src/app.js";
import { localMappingKey, readCliConfig } from "./config.js";
import { createProgram } from "./program.js";

const temporaryPaths: string[] = [];
const applications: FastifyInstance[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

afterEach(async () => {
  process.exitCode = undefined;
  await Promise.all(
    applications.splice(0).map((application) => application.close()),
  );
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

describe("CLI publishing against a disposable server", () => {
  it("configures, creates, versions, lists, disables, enables, and deletes", async () => {
    const dataDirectory = await temporaryDirectory("yaaps-cli-server-");
    const configDirectory = await temporaryDirectory("yaaps-cli-user-");
    const workingDirectory = await temporaryDirectory("yaaps-cli-work-");
    const application = await buildApplication({
      dataDirectory,
      publicOrigin: "https://share.example.test",
    });
    applications.push(application);
    const address = await application.listen({ host: "127.0.0.1", port: 0 });
    const userId = await application.yaapsData!.authentication.createUser({
      displayName: "CLI owner",
      role: "user",
    });
    const apiKey = await application.yaapsData!.authentication.createApiKey(
      userId,
      "CLI integration",
    );
    const assetsDirectory = path.join(workingDirectory, "assets");
    const reportPath = path.join(workingDirectory, "report.html");
    await mkdir(assetsDirectory);
    await writeFile(
      path.join(assetsDirectory, "chart.png"),
      Buffer.from("89504e470d0a1a0a00000000", "hex"),
    );
    const firstSource =
      '<!doctype html><html><head><title>CLI report</title></head><body><h1>First</h1><img src="assets/chart.png"></body></html>';
    await writeFile(reportPath, firstSource, "utf8");

    const run = async (arguments_: string[]) => {
      const output: string[] = [];
      const errors: string[] = [];
      const program = createProgram({
        configDirectory,
        environment: {},
        workingDirectory,
        writeError: (message) => errors.push(message),
        writeOutput: (message) => output.push(message),
      });
      process.exitCode = undefined;
      await program.parseAsync(["node", "yaaps", ...arguments_]);
      return { errors, output };
    };

    const configured = await run([
      "config",
      "set",
      "--api-url",
      address,
      "--api-key",
      apiKey.key,
    ]);
    expect(configured.errors).toEqual([]);
    expect(configured.output.join("\n")).not.toContain(apiKey.key);
    expect(configured.output.join("\n")).toContain(apiKey.prefix);

    const firstPublish = await run([
      "publish",
      "report.html",
      "--title",
      "CLI report",
      "--ttl",
      "3600",
      "--json",
    ]);
    expect(firstPublish.errors).toEqual([]);
    const first = JSON.parse(firstPublish.output[0] ?? "{}") as {
      draft: { id: string; latestVersionNumber: number };
      version: { versionNumber: number };
    };
    expect(first.version.versionNumber).toBe(1);
    expect(await readFile(reportPath, "utf8")).toBe(firstSource);
    expect(
      (await readCliConfig(configDirectory)).drafts[
        localMappingKey(reportPath)
      ],
    ).toEqual({ draftId: first.draft.id });

    await writeFile(
      reportPath,
      '<!doctype html><html><head><title>CLI report</title></head><body><h1>Second</h1><img src="assets/chart.png"></body></html>',
      "utf8",
    );
    const secondPublish = await run(["publish", "report.html", "--json"]);
    expect(secondPublish.errors).toEqual([]);
    const second = JSON.parse(secondPublish.output[0] ?? "{}") as {
      draft: { id: string; latestVersionNumber: number };
      version: { versionNumber: number };
    };
    expect(second.draft.id).toBe(first.draft.id);
    expect(second.version.versionNumber).toBe(2);

    const list = await run(["list", "--json"]);
    expect(list.errors).toEqual([]);
    expect(JSON.parse(list.output[0] ?? "{}")).toMatchObject({
      items: [{ id: first.draft.id, latestVersionNumber: 2 }],
      total: 1,
    });

    expect((await run(["disable", first.draft.id])).errors).toEqual([]);
    expect(
      (
        await application.inject({
          method: "GET",
          url: `/d/${first.draft.id}`,
        })
      ).statusCode,
    ).toBe(404);
    expect((await run(["enable", first.draft.id])).errors).toEqual([]);

    const refusedDelete = await run([
      "delete",
      first.draft.id,
      "--confirm",
      "Z".repeat(32),
    ]);
    expect(refusedDelete.errors).toEqual([
      "YAAPS delete failed: The confirmation draft ID does not match.",
    ]);
    expect(process.exitCode).toBe(1);

    const deleted = await run([
      "delete",
      first.draft.id,
      "--confirm",
      first.draft.id,
    ]);
    expect(deleted.errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
    expect(
      (await readCliConfig(configDirectory)).drafts[
        localMappingKey(reportPath)
      ],
    ).toBeUndefined();
    expect(
      await application
        .yaapsData!.database.connection.selectFrom("drafts")
        .selectAll()
        .execute(),
    ).toEqual([]);
    expect(await application.yaapsData!.blobs.listKeys()).toEqual([]);
  });
});
