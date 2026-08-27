import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile, spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const pwshAvailable =
  process.platform === "win32" &&
  spawnSync("where.exe", ["pwsh"], { windowsHide: true }).status === 0;
const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

describe("standalone YAAPS helper contracts", () => {
  it("keeps the macOS helper valid POSIX shell syntax", async () => {
    const script = path.resolve("plugins/yaaps/skills/yaaps/scripts/yaaps.sh");
    const windowsGitShell = "C:\\Program Files\\Git\\bin\\sh.exe";
    const shell =
      process.platform === "win32" && existsSync(windowsGitShell)
        ? windowsGitShell
        : "sh";
    await expect(
      execFileAsync(shell, ["-n", script], {
        encoding: "utf8",
        windowsHide: true,
      }),
    ).resolves.toMatchObject({ stderr: "" });
  });

  it("reaches curl in a shell status smoke test", async () => {
    const testDirectory = await mkdtemp(
      path.join(tmpdir(), "yaaps-shell-helper-"),
    );
    temporaryPaths.push(testDirectory);
    const curlPath = path.join(testDirectory, "curl");
    const osascriptPath = path.join(testDirectory, "osascript");
    const markerPath = path.join(testDirectory, "curl-reached");
    await writeFile(
      curlPath,
      `#!/bin/sh
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    -w|--config|--max-time|--max-redirs|-X) shift 2 ;;
    *) url=$1; shift ;;
  esac
done
case "$url" in
  */healthz) printf '{"name":"YAAPS","status":"ok","version":"0.0.0"}' >"$output" ;;
  */readyz) printf '{"checks":{"dataDirectory":"ok"},"name":"YAAPS","status":"ready","version":"0.0.0"}' >"$output" ;;
  *) exit 22 ;;
esac
: >"$YAAPS_CURL_MARKER"
printf '200'
`,
      "utf8",
    );
    await writeFile(
      osascriptPath,
      `#!/bin/sh
printf '{"health":{"status":"ok"},"readiness":{"status":"ready"}}\\n'
`,
      "utf8",
    );
    await chmod(curlPath, 0o755);
    await chmod(osascriptPath, 0o755);

    const shellPath =
      process.platform === "win32"
        ? "C:\\Program Files\\Git\\bin\\sh.exe"
        : "sh";
    const toShellPath = (value: string) =>
      process.platform === "win32"
        ? value
            .replace(
              /^([A-Za-z]):\\/u,
              (_, drive: string) => `/${drive.toLowerCase()}/`,
            )
            .replaceAll("\\", "/")
        : value;
    const script = path.resolve("plugins/yaaps/skills/yaaps/scripts/yaaps.sh");
    const smoke = await execFileAsync(
      shellPath,
      [
        "-c",
        'PATH="$1:$PATH"; export PATH; exec /bin/sh "$2" status --api-url http://127.0.0.1:9999',
        "yaaps-smoke",
        toShellPath(testDirectory),
        toShellPath(script),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, YAAPS_CURL_MARKER: toShellPath(markerPath) },
        windowsHide: true,
      },
    );
    expect(JSON.parse(smoke.stdout)).toEqual({
      health: { status: "ok" },
      readiness: { status: "ready" },
    });
    await expect(readFile(markerPath, "utf8")).resolves.toBe("");
  }, 15_000);

  it("drives the POSIX helper through the full draft lifecycle without leaking the key", async () => {
    const testDirectory = await mkdtemp(
      path.join(tmpdir(), "yaaps-shell-flow-"),
    );
    temporaryPaths.push(testDirectory);
    const apiKey = `yaaps_${"p".repeat(10)}_${"s".repeat(43)}`;
    const draftId = "E".repeat(32);
    const draft = {
      category: null as string | null,
      createdAt: "2026-08-24T00:00:00.000Z",
      expiresAt: "2026-08-25T00:00:00.000Z",
      id: draftId,
      latestVersionNumber: 1,
      publicUrl: `https://share.example/d/${draftId}`,
      status: "enabled",
      title: "Sh report",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };
    const requests: Array<{
      authorization?: string;
      body: string;
      method?: string;
      url: string;
    }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push({
          authorization: request.headers.authorization,
          body,
          method: request.method,
          url: request.url ?? "",
        });
        response.setHeader("content-type", "application/json");
        if (
          request.method === "POST" &&
          request.url?.startsWith("/api/drafts?")
        ) {
          response.statusCode = 201;
          response.end(
            JSON.stringify({
              draft,
              version: {
                byteLength: Buffer.byteLength(body),
                createdAt: "2026-08-24T00:00:00.000Z",
                publicUrl: `${draft.publicUrl}/v/1`,
                sha256: "a".repeat(64),
                versionNumber: 1,
              },
            }),
          );
        } else if (request.url?.startsWith("/api/drafts?limit=1&offset=0")) {
          response.end(
            JSON.stringify({ items: [draft], limit: 1, offset: 0, total: 1 }),
          );
        } else if (
          request.method === "GET" &&
          request.url === `/api/drafts/${draftId}`
        ) {
          response.end(JSON.stringify(draft));
        } else if (
          request.method === "GET" &&
          request.url === `/api/drafts/${draftId}/versions?limit=100&offset=0`
        ) {
          response.end(
            JSON.stringify({ items: [], limit: 100, offset: 0, total: 0 }),
          );
        } else if (
          request.method === "PATCH" &&
          request.url === `/api/drafts/${draftId}`
        ) {
          response.end(
            JSON.stringify({
              ...draft,
              ...(JSON.parse(body) as Record<string, unknown>),
            }),
          );
        } else if (
          request.method === "DELETE" &&
          request.url === `/api/drafts/${draftId}`
        ) {
          response.statusCode = 204;
          response.end();
        } else {
          response.statusCode = 404;
          response.end(
            JSON.stringify({ error: { code: "NOT_FOUND", message: "Miss" } }),
          );
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("Server address unavailable.");
      }
      const apiUrl = `http://127.0.0.1:${address.port}`;
      const script = path.resolve(
        "plugins/yaaps/skills/yaaps/scripts/yaaps.sh",
      );
      const shellPath =
        process.platform === "win32" &&
        existsSync("C:\\Program Files\\Git\\bin\\sh.exe")
          ? "C:\\Program Files\\Git\\bin\\sh.exe"
          : "sh";
      const toShellPath = (value: string) =>
        process.platform === "win32"
          ? value
              .replace(
                /^([A-Za-z]):\\/u,
                (_, drive: string) => `/${drive.toLowerCase()}/`,
              )
              .replaceAll("\\", "/")
          : value;
      const environment = {
        ...process.env,
        YAAPS_API_KEY: apiKey,
        YAAPS_API_URL: apiUrl,
      };
      const runHelper = async (...helperArguments: string[]) =>
        execFileAsync(shellPath, [toShellPath(script), ...helperArguments], {
          encoding: "utf8",
          env: environment,
          windowsHide: true,
        });

      const reportPath = path.join(testDirectory, "report.html");
      const html =
        '<!doctype html><html lang="en"><head><title>Sh report</title></head><body><h1>Sh report</h1></body></html>';
      await writeFile(reportPath, html, "utf8");

      const published = await runHelper(
        "publish",
        toShellPath(reportPath),
        "--category",
        "Sh group",
        "--title",
        "Sh report",
        "--ttl",
        "3600",
      );
      expect(JSON.parse(published.stdout)).toMatchObject({
        draft: { id: draftId },
        version: { versionNumber: 1 },
      });
      expect(requests.at(-1)?.url).toBe(
        "/api/drafts?resourcePolicy=connected&category=Sh%20group&title=Sh%20report&ttlSeconds=3600",
      );
      expect(requests.at(-1)?.body).toBe(html);

      const listed = await runHelper("list", "--limit", "1");
      expect(JSON.parse(listed.stdout)).toMatchObject({ total: 1 });

      const filtered = await runHelper(
        "list",
        "--limit",
        "1",
        "--category",
        "Sh group",
      );
      expect(JSON.parse(filtered.stdout)).toMatchObject({ total: 1 });
      expect(requests.at(-1)?.url).toBe(
        "/api/drafts?limit=1&offset=0&category=Sh%20group",
      );

      const categorized = await runHelper("categorize", draftId, "Sh group");
      expect(JSON.parse(categorized.stdout)).toMatchObject({
        category: "Sh group",
      });
      expect(requests.at(-1)).toMatchObject({
        body: '{"category":"Sh group"}',
        method: "PATCH",
        url: `/api/drafts/${draftId}`,
      });

      const uncategorized = await runHelper("categorize", draftId, "--clear");
      expect(JSON.parse(uncategorized.stdout)).toMatchObject({
        category: null,
      });
      expect(requests.at(-1)?.body).toBe('{"category":null}');

      await expect(
        runHelper("categorize", draftId, "Sh group", "--clear"),
      ).rejects.toMatchObject({ stdout: "" });
      await expect(runHelper("categorize", draftId)).rejects.toMatchObject({
        stdout: "",
      });

      const inspected = await runHelper("inspect", draftId);
      expect(JSON.parse(inspected.stdout)).toMatchObject({
        draft: { id: draftId },
        versions: { total: 0 },
      });

      for (const command of ["disable", "enable"] as const) {
        const updated = await runHelper(command, draftId);
        expect(JSON.parse(updated.stdout)).toMatchObject({
          status: command === "disable" ? "disabled" : "enabled",
        });
      }

      const deleted = await runHelper("delete", draftId, "--confirm", draftId);
      expect(JSON.parse(deleted.stdout)).toEqual({ deleted: draftId });

      const outputs = [
        published.stdout,
        listed.stdout,
        inspected.stdout,
        deleted.stdout,
      ].join("\n");
      expect(outputs).not.toContain(apiKey);
      for (const entry of requests) {
        expect(entry.authorization).toBe(`Bearer ${apiKey}`);
        expect(entry.url).not.toContain(apiKey);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 60_000);
});

describe.runIf(process.platform === "win32")(
  "standalone YAAPS PowerShell helper",
  () => {
    it("connects without sending or printing the locally generated key", async () => {
      const configDirectory = await mkdtemp(
        path.join(tmpdir(), "yaaps-skill-helper-"),
      );
      temporaryPaths.push(configDirectory);
      const requests: Array<{
        authorization?: string;
        body: string;
        url: string;
      }> = [];
      const draftId = "D".repeat(32);
      const draft = {
        category: null as string | null,
        createdAt: "2026-08-24T00:00:00.000Z",
        expiresAt: "2026-08-25T00:00:00.000Z",
        id: draftId,
        latestVersionNumber: 1,
        publicUrl: `https://share.example/d/${draftId}`,
        status: "enabled",
        title: "Test report",
        updatedAt: "2026-08-24T00:00:00.000Z",
      };
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          requests.push({
            authorization: request.headers.authorization,
            body,
            url: request.url ?? "",
          });
          response.setHeader("content-type", "application/json");
          if (request.url === "/auth/device-connections") {
            response.statusCode = 201;
            response.end(
              JSON.stringify({
                deviceSecret: `yad_${"a".repeat(43)}`,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
                intervalSeconds: 1,
                userCode: "ABCD-EFGH",
                verificationUrl:
                  "https://share.example/dashboard/connect/approve",
                verificationUrlComplete:
                  "https://share.example/dashboard/connect/approve?code=ABCD-EFGH",
              }),
            );
          } else if (request.url === "/auth/device-connections/token") {
            response.end(
              JSON.stringify({
                apiKeyId: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
                status: "approved",
              }),
            );
          } else if (request.url?.startsWith("/api/drafts?limit=1&offset=0")) {
            response.end(
              JSON.stringify({ items: [], limit: 1, offset: 0, total: 0 }),
            );
          } else if (
            request.method === "POST" &&
            request.url?.startsWith("/api/drafts?")
          ) {
            response.statusCode = 201;
            response.end(
              JSON.stringify({
                draft,
                version: {
                  byteLength: Buffer.byteLength(body),
                  createdAt: "2026-08-24T00:00:00.000Z",
                  publicUrl: `${draft.publicUrl}/v/1`,
                  sha256: "a".repeat(64),
                  versionNumber: 1,
                },
              }),
            );
          } else if (
            request.method === "GET" &&
            request.url === `/api/drafts/${draftId}`
          ) {
            response.end(JSON.stringify(draft));
          } else if (
            request.method === "GET" &&
            request.url === `/api/drafts/${draftId}/versions?limit=100&offset=0`
          ) {
            response.end(
              JSON.stringify({ items: [], limit: 100, offset: 0, total: 0 }),
            );
          } else if (
            request.method === "PATCH" &&
            request.url === `/api/drafts/${draftId}`
          ) {
            response.end(
              JSON.stringify({
                ...draft,
                ...(JSON.parse(body) as Record<string, unknown>),
              }),
            );
          } else if (
            request.method === "DELETE" &&
            request.url === `/api/drafts/${draftId}`
          ) {
            response.statusCode = 204;
            response.end();
          } else if (request.url === "/healthz") {
            response.end(
              JSON.stringify({ name: "YAAPS", status: "ok", version: "0.0.0" }),
            );
          } else if (request.url === "/readyz") {
            response.end(
              JSON.stringify({
                checks: { dataDirectory: "ok" },
                name: "YAAPS",
                status: "ready",
                version: "0.0.0",
              }),
            );
          } else {
            response.statusCode = 404;
            response.end(
              JSON.stringify({
                error: { code: "NOT_FOUND", message: "Missing" },
              }),
            );
          }
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );

      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Missing address");
        const origin = `http://127.0.0.1:${address.port}`;
        const script = path.resolve(
          "plugins/yaaps/skills/yaaps/scripts/yaaps.ps1",
        );
        const environment = {
          ...process.env,
          HOME: configDirectory,
          YAAPS_CONFIG_DIR: configDirectory,
        };
        const connected = await execFileAsync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-File",
            script,
            "connect",
            "--api-url",
            origin,
            "--label",
            "Test agent",
            "--no-open",
          ],
          {
            encoding: "utf8",
            env: environment,
            timeout: 10_000,
            windowsHide: true,
          },
        );
        const events = connected.stdout
          .trim()
          .split(/\r?\n/u)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(events.map((event) => event.status)).toEqual([
          "pending",
          "approved",
        ]);

        const stored = JSON.parse(
          await readFile(path.join(configDirectory, "config.json"), "utf8"),
        ) as { apiKey: string };
        expect(connected.stdout).not.toContain(stored.apiKey);
        const created = JSON.parse(requests[0]!.body) as {
          keyHash: string;
          keyPrefix: string;
        };
        expect(created.keyHash).toBe(
          createHash("sha256").update(stored.apiKey).digest("hex"),
        );
        expect(created.keyPrefix).toBe(stored.apiKey.slice(0, 16));
        expect(
          requests
            .slice(0, 2)
            .every((entry) => !entry.body.includes(stored.apiKey)),
        ).toBe(true);

        const listed = await execFileAsync(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-File", script, "list", "--limit", "1"],
          { encoding: "utf8", env: environment, windowsHide: true },
        );
        expect(JSON.parse(listed.stdout)).toMatchObject({ total: 0 });
        expect(requests.at(-1)?.authorization).toBe(`Bearer ${stored.apiKey}`);

        const status = await execFileAsync(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-File", script, "status"],
          { encoding: "utf8", env: environment, windowsHide: true },
        );
        expect(JSON.parse(status.stdout)).toMatchObject({
          health: { status: "ok" },
          readiness: { status: "ready" },
        });

        const reportPath = path.join(configDirectory, "report.html");
        await writeFile(
          reportPath,
          '<!doctype html><html lang="en"><head><title>Safe report</title></head><body><h1>Safe report</h1></body></html>',
          "utf8",
        );
        const published = await execFileAsync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-File",
            script,
            "publish",
            reportPath,
            "--category",
            "Test group",
            "--title",
            "Test report",
            "--ttl",
            "3600",
          ],
          { encoding: "utf8", env: environment, windowsHide: true },
        );
        expect(JSON.parse(published.stdout)).toMatchObject({
          draft: { id: draftId },
          version: { versionNumber: 1 },
        });
        expect(requests.at(-1)?.url).toBe(
          "/api/drafts?resourcePolicy=connected&category=Test%20group&title=Test%20report&ttlSeconds=3600",
        );
        expect(requests.at(-1)?.body).toBe(
          '<!doctype html><html lang="en"><head><title>Safe report</title></head><body><h1>Safe report</h1></body></html>',
        );

        const filtered = await execFileAsync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-File",
            script,
            "list",
            "--limit",
            "1",
            "--category",
            "Test group",
          ],
          { encoding: "utf8", env: environment, windowsHide: true },
        );
        expect(JSON.parse(filtered.stdout)).toMatchObject({ total: 0 });
        expect(requests.at(-1)?.url).toBe(
          "/api/drafts?limit=1&offset=0&category=Test%20group",
        );

        const categorized = await execFileAsync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-File",
            script,
            "categorize",
            draftId,
            "Test group",
          ],
          { encoding: "utf8", env: environment, windowsHide: true },
        );
        expect(JSON.parse(categorized.stdout)).toMatchObject({
          category: "Test group",
        });
        expect(requests.at(-1)?.body).toBe('{"category":"Test group"}');

        const uncategorized = await execFileAsync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-File",
            script,
            "categorize",
            draftId,
            "--clear",
          ],
          { encoding: "utf8", env: environment, windowsHide: true },
        );
        expect(JSON.parse(uncategorized.stdout)).toMatchObject({
          category: null,
        });
        expect(requests.at(-1)?.body).toBe('{"category":null}');

        for (const invalid of [[draftId, "Test group", "--clear"], [draftId]]) {
          await expect(
            execFileAsync(
              "powershell.exe",
              [
                "-NoLogo",
                "-NoProfile",
                "-File",
                script,
                "categorize",
                ...invalid,
              ],
              { encoding: "utf8", env: environment, windowsHide: true },
            ),
          ).rejects.toMatchObject({ stdout: "" });
        }

        const inspected = await execFileAsync(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-File", script, "inspect", draftId],
          { encoding: "utf8", env: environment, windowsHide: true },
        );
        expect(JSON.parse(inspected.stdout)).toMatchObject({
          draft: { id: draftId },
          versions: { total: 0 },
        });

        for (const command of ["disable", "enable"] as const) {
          const updated = await execFileAsync(
            "powershell.exe",
            ["-NoLogo", "-NoProfile", "-File", script, command, draftId],
            { encoding: "utf8", env: environment, windowsHide: true },
          );
          expect(JSON.parse(updated.stdout)).toMatchObject({
            id: draftId,
            status: command === "disable" ? "disabled" : "enabled",
          });
        }

        await expect(
          execFileAsync(
            "powershell.exe",
            [
              "-NoLogo",
              "-NoProfile",
              "-File",
              script,
              "delete",
              draftId,
              "--confirm",
              "X".repeat(32),
            ],
            { encoding: "utf8", env: environment, windowsHide: true },
          ),
        ).rejects.toMatchObject({ stdout: "" });
        const deleted = await execFileAsync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-File",
            script,
            "delete",
            draftId,
            "--confirm",
            draftId,
          ],
          { encoding: "utf8", env: environment, windowsHide: true },
        );
        expect(JSON.parse(deleted.stdout)).toEqual({ deleted: draftId });
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }, 40_000);

    it.runIf(pwshAvailable)(
      "connects under PowerShell 7 with a non en-US culture",
      async () => {
        const configDirectory = await mkdtemp(
          path.join(tmpdir(), "yaaps-skill-culture-"),
        );
        temporaryPaths.push(configDirectory);
        const expiresAt = new Date(Date.now() + 60_000).toISOString();
        const server = createServer((request, response) => {
          request.on("data", () => {});
          request.on("end", () => {
            response.setHeader("content-type", "application/json");
            if (request.url === "/auth/device-connections") {
              response.statusCode = 201;
              response.end(
                JSON.stringify({
                  deviceSecret: `yad_${"a".repeat(43)}`,
                  expiresAt,
                  intervalSeconds: 1,
                  userCode: "ABCD-EFGH",
                  verificationUrl:
                    "https://share.example/dashboard/connect/approve",
                  verificationUrlComplete:
                    "https://share.example/dashboard/connect/approve?code=ABCD-EFGH",
                }),
              );
            } else if (request.url === "/auth/device-connections/token") {
              response.end(
                JSON.stringify({
                  apiKeyId: "8f7c1ca3-edbc-4b4b-b349-d45322728936",
                  status: "approved",
                }),
              );
            } else {
              response.statusCode = 404;
              response.end(
                JSON.stringify({
                  error: { code: "NOT_FOUND", message: "Missing" },
                }),
              );
            }
          });
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        try {
          const address = server.address();
          if (!address || typeof address === "string")
            throw new Error("Missing address");
          const script = path.resolve(
            "plugins/yaaps/skills/yaaps/scripts/yaaps.ps1",
          );
          // Unlike Windows PowerShell 5.1, PowerShell 7 deserializes ISO
          // date strings into DateTime objects, so the helper must not
          // round-trip them through culture-formatted strings; forcing
          // de-DE makes such a round-trip fail deterministically.
          const command = [
            "$ErrorActionPreference = 'Stop'",
            "[Globalization.CultureInfo]::DefaultThreadCurrentCulture = [Globalization.CultureInfo]::GetCultureInfo('de-DE')",
            "[Globalization.CultureInfo]::CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo('de-DE')",
            "& $env:YAAPS_TEST_SCRIPT connect --api-url $env:YAAPS_TEST_ORIGIN --label 'Culture agent' --no-open",
            "exit $LASTEXITCODE",
          ].join("; ");
          const connected = await execFileAsync(
            "pwsh",
            ["-NoLogo", "-NoProfile", "-Command", command],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                HOME: configDirectory,
                YAAPS_CONFIG_DIR: configDirectory,
                YAAPS_TEST_ORIGIN: `http://127.0.0.1:${address.port}`,
                YAAPS_TEST_SCRIPT: script,
              },
              timeout: 10_000,
              windowsHide: true,
            },
          );
          const events = connected.stdout
            .trim()
            .split(/\r?\n/u)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          expect(events.map((event) => event.status)).toEqual([
            "pending",
            "approved",
          ]);
          expect(Date.parse(String(events[0]!.expiresAt))).toBe(
            Date.parse(expiresAt),
          );
          const stored = JSON.parse(
            await readFile(path.join(configDirectory, "config.json"), "utf8"),
          ) as { apiKey: string };
          expect(stored.apiKey).toMatch(/^yaaps_/u);
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
      15_000,
    );
  },
);
