import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApplication } from "./app.js";

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

async function createDashboard(assetName: string, content: string) {
  const directory = await temporaryDirectory("yaaps-dashboard-build-");
  await mkdir(path.join(directory, "assets"));
  await writeFile(
    path.join(directory, "index.html"),
    `<!doctype html><title>YAAPS</title><script src="/assets/${assetName}"></script>`,
  );
  await writeFile(path.join(directory, "assets", assetName), content);
  return directory;
}

describe("dashboard assets during a rollout", () => {
  it("serves the assets of both builds from either instance", async () => {
    const dataDirectory = await temporaryDirectory("yaaps-shared-data-");
    const oldBuild = await createDashboard("index-0ld0ld.js", "old build");
    const newBuild = await createDashboard("index-n3wn3w.js", "new build");
    const oldInstance = await buildApplication({
      dashboardDirectory: oldBuild,
      dataDirectory,
    });
    const newInstance = await buildApplication({
      dashboardDirectory: newBuild,
      dataDirectory,
    });

    try {
      for (const instance of [oldInstance, newInstance]) {
        const oldAsset = await instance.inject({
          method: "GET",
          url: "/assets/index-0ld0ld.js",
        });
        const newAsset = await instance.inject({
          method: "GET",
          url: "/assets/index-n3wn3w.js",
        });
        expect([oldAsset.statusCode, newAsset.statusCode]).toEqual([200, 200]);
        expect([oldAsset.body, newAsset.body]).toEqual([
          "old build",
          "new build",
        ]);
      }
    } finally {
      await oldInstance.close();
      await newInstance.close();
    }
  });
});
