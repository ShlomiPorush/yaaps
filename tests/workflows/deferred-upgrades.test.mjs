import assert from "node:assert/strict";
import test from "node:test";

import {
  collectDeferredUpgradeStatus,
  evaluateDeferredUpgrades,
  rangeSupportsMajor,
  renderSummary,
} from "../../.github/tools/check-deferred-upgrades.mjs";

const repositoryPackage = {
  engines: { node: ">=24 <25" },
  devDependencies: {
    typescript: "5.9.3",
    "typescript-eslint": "8.67.0",
  },
};

test("rangeSupportsMajor handles the range forms used by engine and peer declarations", () => {
  assert.equal(rangeSupportsMajor(">=24 <25", 26), false);
  assert.equal(rangeSupportsMajor(">=24 <27", 26), true);
  assert.equal(rangeSupportsMajor(">=5.0.0 <8.0.0", 7), true);
  assert.equal(rangeSupportsMajor("^7.1.0", 7), true);
  assert.equal(rangeSupportsMajor("5.9.3 || ^7.0.0", 7), true);
  assert.equal(rangeSupportsMajor("not-a-semver-range", 7), false);
});

test("Node.js 26 becomes ready only after LTS and while the engine excludes it", () => {
  const currentResult = evaluateDeferredUpgrades({
    nodeReleases: [{ version: "v26.2.0", lts: false }],
    packageMetadata: {
      version: "8.67.0",
      peerDependencies: { typescript: ">=4.8.4 <6.0.0" },
    },
    repositoryPackage,
  });
  assert.equal(currentResult.checks[0].ready, false);

  const ltsResult = evaluateDeferredUpgrades({
    nodeReleases: [{ version: "v26.7.0", lts: "Krypton" }],
    packageMetadata: {
      version: "8.67.0",
      peerDependencies: { typescript: ">=4.8.4 <6.0.0" },
    },
    repositoryPackage,
  });
  assert.equal(ltsResult.checks[0].ready, true);

  const alreadySupportedResult = evaluateDeferredUpgrades({
    nodeReleases: [{ version: "v26.7.0", lts: "Krypton" }],
    packageMetadata: {
      version: "8.67.0",
      peerDependencies: { typescript: ">=4.8.4 <6.0.0" },
    },
    repositoryPackage: {
      ...repositoryPackage,
      engines: { node: ">=24 <27" },
    },
  });
  assert.equal(alreadySupportedResult.checks[0].ready, false);
});

test("TypeScript 7 becomes ready only when latest typescript-eslint supports it", () => {
  const unsupportedResult = evaluateDeferredUpgrades({
    nodeReleases: [],
    packageMetadata: {
      version: "8.67.0",
      peerDependencies: { typescript: ">=4.8.4 <6.0.0" },
    },
    repositoryPackage,
  });
  assert.equal(unsupportedResult.checks[1].ready, false);

  const supportedResult = evaluateDeferredUpgrades({
    nodeReleases: [],
    packageMetadata: {
      version: "9.0.0",
      peerDependencies: { typescript: ">=5.0.0 <8.0.0" },
    },
    repositoryPackage,
  });
  assert.equal(supportedResult.checks[1].ready, true);

  const alreadyUpgradedResult = evaluateDeferredUpgrades({
    nodeReleases: [],
    packageMetadata: {
      version: "9.0.0",
      peerDependencies: { typescript: ">=5.0.0 <8.0.0" },
    },
    repositoryPackage: {
      ...repositoryPackage,
      devDependencies: {
        ...repositoryPackage.devDependencies,
        typescript: "7.0.1",
      },
    },
  });
  assert.equal(alreadyUpgradedResult.checks[1].ready, false);
});

test("collectDeferredUpgradeStatus uses injectable HTTP fixtures", async () => {
  const responses = new Map([
    [
      "https://nodejs.org/dist/index.json",
      [{ version: "v26.7.0", lts: "Krypton" }],
    ],
    [
      "https://registry.npmjs.org/typescript-eslint/latest",
      {
        version: "9.0.0",
        peerDependencies: { typescript: ">=5.0.0 <8.0.0" },
      },
    ],
  ]);
  const requestedUrls = [];
  const result = await collectDeferredUpgradeStatus({
    repositoryPackage,
    fetchImplementation: async (url) => {
      requestedUrls.push(url);
      return {
        ok: true,
        json: async () => responses.get(url),
      };
    },
  });

  assert.equal(requestedUrls.length, 2);
  assert.deepEqual(
    result.checks.map((check) => check.ready),
    [true, true],
  );
  assert.deepEqual(
    result.checks.map((check) => check.issueTitle),
    [
      "[Infrastructure][Dependencies] Revisit Node.js 26 support",
      "[Tooling][Dependencies] Revisit TypeScript 7 support",
    ],
  );
  assert.match(renderSummary(result), /Ready for discussion/);
});

test("collectDeferredUpgradeStatus rejects failed upstream responses", async () => {
  await assert.rejects(
    collectDeferredUpgradeStatus({
      repositoryPackage,
      fetchImplementation: async () => ({ ok: false, status: 503 }),
    }),
    /HTTP 503/,
  );
});
