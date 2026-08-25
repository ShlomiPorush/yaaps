#!/usr/bin/env node
// Synchronizes every version declaration in the repository from the root
// VERSION file, which is the single source of truth.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const version = readFileSync(
  path.join(repositoryRoot, "VERSION"),
  "utf8",
).trim();
if (
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(
    version,
  )
) {
  process.stderr.write(`VERSION does not contain valid SemVer: ${version}\n`);
  process.exit(1);
}

const packagePaths = [
  "package.json",
  "packages/contracts/package.json",
  "packages/cli/package.json",
  "apps/server/package.json",
  "apps/dashboard/package.json",
];
for (const relativePath of packagePaths) {
  const absolutePath = path.join(repositoryRoot, relativePath);
  const document = JSON.parse(readFileSync(absolutePath, "utf8"));
  document.version = version;
  writeFileSync(absolutePath, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`${relativePath} -> ${version}\n`);
}

const contractsPath = path.join(
  repositoryRoot,
  "packages/contracts/src/index.ts",
);
const contracts = readFileSync(contractsPath, "utf8");
const updated = contracts.replace(
  /FOUNDATION_VERSION = "[^"]+"/,
  `FOUNDATION_VERSION = "${version}"`,
);
if (
  updated === contracts &&
  !contracts.includes(`FOUNDATION_VERSION = "${version}"`)
) {
  process.stderr.write(
    "FOUNDATION_VERSION assignment was not found in contracts.\n",
  );
  process.exit(1);
}
writeFileSync(contractsPath, updated);
process.stdout.write(`packages/contracts/src/index.ts -> ${version}\n`);
