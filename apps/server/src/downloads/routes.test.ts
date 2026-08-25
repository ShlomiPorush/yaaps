import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

async function createDistribution(directory: string) {
  const skillPackage = Buffer.from("test YAAPS skill ZIP");
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
  return { checksum, skillPackage };
}

describe("skill distribution routes", () => {
  it("serves the verified package and origin-bound installers", async () => {
    const distributionDirectory = await temporaryDirectory(
      "yaaps-skill-distribution-",
    );
    const distribution = await createDistribution(distributionDirectory);
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory("yaaps-download-data-"),
      publicOrigin: "https://self-hosted.example",
      skillDistributionDirectory: distributionDirectory,
    });

    const skill = await application.inject({
      method: "GET",
      url: "/downloads/yaaps-skill.zip",
    });
    expect(skill.statusCode).toBe(200);
    expect(skill.headers["content-disposition"]).toContain("attachment");
    expect(skill.rawPayload).toEqual(distribution.skillPackage);
    const checksum = await application.inject({
      method: "GET",
      url: "/downloads/yaaps-skill.zip.sha256",
    });
    expect(checksum.body).toContain(distribution.checksum);

    for (const [url, filename] of [
      ["/downloads/install-skill.ps1", "install-yaaps-skill.ps1"],
      ["/downloads/install-skill.sh", "install-yaaps-skill.sh"],
    ]) {
      const response = await application.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-disposition"]).toContain(filename);
      expect(response.headers["content-disposition"]).toContain("inline");
      expect(response.body).toContain(
        "https://self-hosted.example/downloads/yaaps-skill.zip",
      );
      expect(response.body).not.toContain("__YAAPS_SKILL_PACKAGE_URL__");
    }
    await application.close();
  });

  it("returns unavailable when the package checksum is invalid", async () => {
    const distributionDirectory = await temporaryDirectory(
      "yaaps-invalid-skill-distribution-",
    );
    await createDistribution(distributionDirectory);
    await writeFile(
      path.join(distributionDirectory, "yaaps-skill.zip"),
      "corrupt",
    );
    const application = await buildApplication({
      dataDirectory: await temporaryDirectory("yaaps-download-data-"),
      skillDistributionDirectory: distributionDirectory,
    });

    const response = await application.inject({
      method: "GET",
      url: "/downloads/install-skill.ps1",
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: {
        code: "SKILL_DISTRIBUTION_UNAVAILABLE",
        message: "The YAAPS skill distribution is not available.",
      },
    });
    expect(response.body).not.toContain(distributionDirectory);
    await application.close();
  });
});
