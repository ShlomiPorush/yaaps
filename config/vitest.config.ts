import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export default defineConfig({
  root: repositoryRoot,
  plugins: [react()],
  resolve: {
    alias: {
      "@yaaps/contracts": path.join(
        repositoryRoot,
        "packages/contracts/src/index.ts",
      ),
    },
  },
  test: {
    // Dashboard tests select jsdom via a per-file "@vitest-environment jsdom"
    // pragma; environmentMatchGlobs was removed in Vitest 4 and is not used.
    include: ["apps/**/*.test.{ts,tsx}", "packages/**/*.test.ts"],
    setupFiles: [path.join(repositoryRoot, "config/vitest.setup.ts")],
  },
});
