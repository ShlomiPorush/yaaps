// Copies the self-contained Scalar API reference browser bundle into the
// server build output, so the runtime image serves it without keeping the
// @scalar/api-reference package (a development dependency) installed.
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const packageEntry = require.resolve("@scalar/api-reference");
const source = path.join(
  path.dirname(packageEntry),
  "browser",
  "standalone.js",
);
const serverDirectory = path.dirname(
  path.dirname(fileURLToPath(import.meta.url)),
);
const target = path.join(
  serverDirectory,
  "dist",
  "vendor",
  "scalar-api-reference.js",
);

await mkdir(path.dirname(target), { recursive: true });
await copyFile(source, target);
