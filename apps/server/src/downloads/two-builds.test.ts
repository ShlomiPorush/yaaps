import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApplication } from "../app.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
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

async function createDistribution(content: string): Promise<string> {
  const directory = await temporaryDirectory("yaaps-skill-build-");
  const skillPackage = Buffer.from(content);
  const checksum = createHash("sha256").update(skillPackage).digest("hex");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "yaaps-skill.zip"), skillPackage);
  await writeFile(
    path.join(directory, "yaaps-skill.zip.sha256"),
    `${checksum}  yaaps-skill.zip\n`,
  );
  await writeFile(
    path.join(directory, "install-yaaps-skill.ps1"),
    "$Source = '__YAAPS_SKILL_PACKAGE_URL__'\n",
  );
  await writeFile(
    path.join(directory, "install-yaaps-skill.sh"),
    "source_url='__YAAPS_SKILL_PACKAGE_URL__'\n",
  );
  return directory;
}

async function packageUrlFromInstaller(
  instance: FastifyInstance,
): Promise<URL> {
  const installer = await instance.inject({
    method: "GET",
    url: "/downloads/install-skill.sh",
  });
  expect(installer.statusCode).toBe(200);
  const match = /source_url='([^']+)'/u.exec(installer.body);
  expect(match?.[1]).toBeDefined();
  return new URL(match![1]!);
}

describe("skill downloads during a rollout", () => {
  it("serves a matching package and checksum when the two downloads reach different builds", async () => {
    const dataDirectory = await temporaryDirectory("yaaps-shared-data-");
    const options = {
      dataDirectory,
      publicOrigin: "https://self-hosted.example",
    };
    const oldInstance = await buildApplication({
      ...options,
      skillDistributionDirectory: await createDistribution("old skill"),
    });
    const newInstance = await buildApplication({
      ...options,
      skillDistributionDirectory: await createDistribution("new skill"),
    });

    try {
      for (const installerSource of [oldInstance, newInstance]) {
        const packageUrl = await packageUrlFromInstaller(installerSource);
        for (const [packageSource, checksumSource] of [
          [oldInstance, newInstance],
          [newInstance, oldInstance],
          [oldInstance, oldInstance],
          [newInstance, newInstance],
        ] as const) {
          const skillPackage = await packageSource.inject({
            method: "GET",
            url: packageUrl.pathname,
          });
          const checksum = await checksumSource.inject({
            method: "GET",
            url: `${packageUrl.pathname}.sha256`,
          });
          expect([skillPackage.statusCode, checksum.statusCode]).toEqual([
            200, 200,
          ]);
          expect(checksum.body.split(/\s+/u)[0]).toBe(
            createHash("sha256").update(skillPackage.rawPayload).digest("hex"),
          );
        }
      }
    } finally {
      await oldInstance.close();
      await newInstance.close();
    }
  });
});
