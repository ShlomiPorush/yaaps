#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const NODE_RELEASES_URL = "https://nodejs.org/dist/index.json";
const TYPESCRIPT_ESLINT_URL =
  "https://registry.npmjs.org/typescript-eslint/latest";
const TARGET_NODE_MAJOR = 26;
const TARGET_TYPESCRIPT_MAJOR = 7;

function parseVersion(value) {
  const match = String(value)
    .trim()
    .match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2] ?? "0", 10),
    Number.parseInt(match[3] ?? "0", 10),
  ];
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function stricterLower(current, candidate) {
  const comparison = compareVersions(current.version, candidate.version);
  if (comparison > 0) return current;
  if (comparison < 0) return candidate;
  return {
    version: current.version,
    inclusive: current.inclusive && candidate.inclusive,
  };
}

function stricterUpper(current, candidate) {
  const comparison = compareVersions(current.version, candidate.version);
  if (comparison < 0) return current;
  if (comparison > 0) return candidate;
  return {
    version: current.version,
    inclusive: current.inclusive && candidate.inclusive,
  };
}

function branchSupportsMajor(branch, targetMajor) {
  const normalized = branch
    .trim()
    .replace(/\s+-\s+/g, " - ")
    .replace(/,/g, " ");
  if (normalized === "" || normalized === "*" || /^x$/i.test(normalized)) {
    return true;
  }

  let lower = { version: [targetMajor, 0, 0], inclusive: true };
  let upper = { version: [targetMajor + 1, 0, 0], inclusive: false };
  const tokens = normalized.split(/\s+/);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (tokens[index + 1] === "-" && tokens[index + 2]) {
      const start = parseVersion(token);
      const end = parseVersion(tokens[index + 2]);
      if (!start || !end) return false;
      lower = stricterLower(lower, { version: start, inclusive: true });
      upper = stricterUpper(upper, { version: end, inclusive: true });
      index += 2;
      continue;
    }

    const match = token.match(
      /^(>=|<=|>|<|=|\^|~)?v?(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?(?:-[0-9A-Za-z.-]+)?$/i,
    );
    if (!match) return false;

    const operator = match[1] ?? "";
    const parts = match.slice(2, 5);
    if (/^[x*]$/i.test(parts[0])) continue;

    const specifiedParts = parts.filter(
      (part) => part !== undefined && !/^[x*]$/i.test(part),
    ).length;
    const version = parts.map((part) =>
      part === undefined || /^[x*]$/i.test(part)
        ? 0
        : Number.parseInt(part, 10),
    );

    if (operator === ">=" || operator === ">") {
      lower = stricterLower(lower, {
        version,
        inclusive: operator === ">=",
      });
    } else if (operator === "<=" || operator === "<") {
      upper = stricterUpper(upper, {
        version,
        inclusive: operator === "<=",
      });
    } else if (operator === "^") {
      lower = stricterLower(lower, { version, inclusive: true });
      const firstNonZero = version.findIndex((part) => part !== 0);
      const boundaryIndex = firstNonZero === -1 ? 2 : firstNonZero;
      const boundary = version.slice();
      boundary[boundaryIndex] += 1;
      for (let part = boundaryIndex + 1; part < 3; part += 1)
        boundary[part] = 0;
      upper = stricterUpper(upper, { version: boundary, inclusive: false });
    } else if (operator === "~") {
      lower = stricterLower(lower, { version, inclusive: true });
      const boundaryIndex = specifiedParts <= 1 ? 0 : 1;
      const boundary = version.slice();
      boundary[boundaryIndex] += 1;
      for (let part = boundaryIndex + 1; part < 3; part += 1)
        boundary[part] = 0;
      upper = stricterUpper(upper, { version: boundary, inclusive: false });
    } else if (
      specifiedParts < 3 ||
      parts.some((part) => /^[x*]$/i.test(part ?? ""))
    ) {
      lower = stricterLower(lower, { version, inclusive: true });
      const boundaryIndex = specifiedParts <= 1 ? 0 : 1;
      const boundary = version.slice();
      boundary[boundaryIndex] += 1;
      for (let part = boundaryIndex + 1; part < 3; part += 1)
        boundary[part] = 0;
      upper = stricterUpper(upper, { version: boundary, inclusive: false });
    } else {
      lower = stricterLower(lower, { version, inclusive: true });
      upper = stricterUpper(upper, { version, inclusive: true });
    }
  }

  const comparison = compareVersions(lower.version, upper.version);
  return (
    comparison < 0 || (comparison === 0 && lower.inclusive && upper.inclusive)
  );
}

export function rangeSupportsMajor(range, targetMajor) {
  if (typeof range !== "string") return false;
  return range
    .split("||")
    .some((branch) => branchSupportsMajor(branch, targetMajor));
}

export function evaluateDeferredUpgrades({
  nodeReleases,
  packageMetadata,
  repositoryPackage,
}) {
  const nodeEngine = repositoryPackage.engines?.node ?? "";
  const typescriptVersion = repositoryPackage.devDependencies?.typescript ?? "";
  const typescriptEslintVersion =
    repositoryPackage.devDependencies?.["typescript-eslint"] ?? "";
  const targetNodeReleases = nodeReleases.filter(
    (release) => parseVersion(release.version)?.[0] === TARGET_NODE_MAJOR,
  );
  const ltsNodeRelease = targetNodeReleases.find((release) => release.lts);
  const nodeAlreadySupported = rangeSupportsMajor(
    nodeEngine,
    TARGET_NODE_MAJOR,
  );

  const peerRange = packageMetadata.peerDependencies?.typescript ?? "";
  const typescriptAlreadySupported = rangeSupportsMajor(
    typescriptVersion,
    TARGET_TYPESCRIPT_MAJOR,
  );
  const typescriptEslintSupportsTarget = rangeSupportsMajor(
    peerRange,
    TARGET_TYPESCRIPT_MAJOR,
  );

  return {
    checkedAt: new Date().toISOString(),
    checks: [
      {
        id: "node-26",
        ready: Boolean(ltsNodeRelease) && !nodeAlreadySupported,
        trackingKey: "yaaps-deferred-upgrade-node-26",
        issueTitle: "[Infrastructure][Dependencies] Revisit Node.js 26 support",
        issueBody: [
          "The monthly deferred-upgrade check found that Node.js 26 has reached LTS while YAAPS does not yet declare support for it.",
          "",
          "This upgrade was deferred from #2.",
          "",
          `- Latest observed Node.js 26 LTS release: ${ltsNodeRelease?.version ?? "none"}`,
          `- LTS codename: ${ltsNodeRelease?.lts || "not yet LTS"}`,
          `- Current repository Node.js engine: \`${nodeEngine || "not declared"}\``,
          "",
          "Please reassess the runtime, Docker image, CI version, npm engine, and full verification matrix before deciding whether to upgrade.",
          "",
          "Tracking key: yaaps-deferred-upgrade-node-26",
        ].join("\n"),
        summary: nodeAlreadySupported
          ? `No discussion needed: the repository engine \`${nodeEngine}\` already accepts Node.js 26.`
          : ltsNodeRelease
            ? `Ready for discussion: ${ltsNodeRelease.version} is an LTS release (${ltsNodeRelease.lts}).`
            : "Not ready: Node.js 26 has not reached LTS.",
      },
      {
        id: "typescript-7",
        ready: typescriptEslintSupportsTarget && !typescriptAlreadySupported,
        trackingKey: "yaaps-deferred-upgrade-typescript-7",
        issueTitle: "[Tooling][Dependencies] Revisit TypeScript 7 support",
        issueBody: [
          "The monthly deferred-upgrade check found that the latest typescript-eslint release declares support for TypeScript 7 while YAAPS has not yet moved to TypeScript 7.",
          "",
          "This upgrade was deferred from #3.",
          "",
          `- Latest typescript-eslint release: ${packageMetadata.version ?? "unknown"}`,
          `- Declared TypeScript peer range: \`${peerRange || "not declared"}\``,
          `- Current YAAPS TypeScript dependency: \`${typescriptVersion || "not declared"}\``,
          `- Current YAAPS typescript-eslint dependency: \`${typescriptEslintVersion || "not declared"}\``,
          "",
          "Please reassess the compiler, lint toolchain, build, and full verification matrix before deciding whether to upgrade.",
          "",
          "Tracking key: yaaps-deferred-upgrade-typescript-7",
        ].join("\n"),
        summary: typescriptAlreadySupported
          ? `No discussion needed: the repository TypeScript dependency \`${typescriptVersion}\` already targets TypeScript 7.`
          : typescriptEslintSupportsTarget
            ? `Ready for discussion: typescript-eslint ${packageMetadata.version ?? "latest"} accepts TypeScript 7 through peer range \`${peerRange}\`.`
            : `Not ready: typescript-eslint ${packageMetadata.version ?? "latest"} declares TypeScript peer range \`${peerRange || "none"}\`.`,
      },
    ],
  };
}

export function renderSummary(result) {
  return [
    "## Deferred upgrade review",
    "",
    ...result.checks.flatMap((check) => [
      `### ${check.issueTitle}`,
      "",
      check.summary,
      "",
    ]),
  ].join("\n");
}

async function fetchJson(url, fetchImplementation) {
  const response = await fetchImplementation(url, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Request to ${url} failed with HTTP ${response.status}.`);
  }
  return response.json();
}

export async function collectDeferredUpgradeStatus({
  fetchImplementation = globalThis.fetch,
  repositoryPackage,
}) {
  const [nodeReleases, packageMetadata] = await Promise.all([
    fetchJson(NODE_RELEASES_URL, fetchImplementation),
    fetchJson(TYPESCRIPT_ESLINT_URL, fetchImplementation),
  ]);
  return evaluateDeferredUpgrades({
    nodeReleases,
    packageMetadata,
    repositoryPackage,
  });
}

function getArgument(name, argumentsList) {
  const index = argumentsList.indexOf(name);
  return index === -1 ? "" : (argumentsList[index + 1] ?? "");
}

async function main() {
  const argumentsList = process.argv.slice(2);
  const resultPath = getArgument("--result", argumentsList);
  const summaryPath = getArgument("--summary", argumentsList);
  const outputPath = getArgument("--github-output", argumentsList);
  if (!resultPath || !summaryPath) {
    throw new Error(
      "Usage: check-deferred-upgrades.mjs --result <path> --summary <path> [--github-output <path>]",
    );
  }

  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const repositoryPackage = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  );
  const result = await collectDeferredUpgradeStatus({ repositoryPackage });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, `${renderSummary(result)}\n`, {
    encoding: "utf8",
    flag: "a",
  });
  if (outputPath) {
    const readyCount = result.checks.filter((check) => check.ready).length;
    await writeFile(outputPath, `ready_count=${readyCount}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
