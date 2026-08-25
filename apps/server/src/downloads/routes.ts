import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";

const DISTRIBUTION_FILES = {
  checksum: "yaaps-skill.zip.sha256",
  package: "yaaps-skill.zip",
  posixInstaller: "install-yaaps-skill.sh",
  powershellInstaller: "install-yaaps-skill.ps1",
} as const;

interface VerifiedSkillDistribution {
  paths: Record<keyof typeof DISTRIBUTION_FILES, string>;
}

async function fileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function loadVerifiedDistribution(
  directory: string | undefined,
): Promise<VerifiedSkillDistribution> {
  if (!directory) throw new Error("Skill distribution is not configured.");
  const root = path.resolve(directory);
  const paths = Object.fromEntries(
    Object.entries(DISTRIBUTION_FILES).map(([key, file]) => [
      key,
      path.join(root, file),
    ]),
  ) as VerifiedSkillDistribution["paths"];
  for (const filePath of Object.values(paths)) {
    if (!(await stat(filePath)).isFile()) {
      throw new Error("Skill distribution file is unavailable.");
    }
  }
  const checksumDocument = await readFile(paths.checksum, "utf8");
  const match = /^([a-f0-9]{64}) {2}yaaps-skill\.zip\r?\n?$/u.exec(
    checksumDocument,
  );
  if (!match || (await fileSha256(paths.package)) !== match[1]) {
    throw new Error("Skill package checksum does not match.");
  }
  return { paths };
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: {
      code: "SKILL_DISTRIBUTION_UNAVAILABLE",
      message: "The YAAPS skill distribution is not available.",
    },
  });
}

function sendDownload(
  reply: FastifyReply,
  body: NodeJS.ReadableStream | string,
  fileName: string,
  contentType: string,
  disposition: "attachment" | "inline",
) {
  return reply
    .header("cache-control", "no-store")
    .header("content-disposition", `${disposition}; filename="${fileName}"`)
    .header("x-content-type-options", "nosniff")
    .type(contentType)
    .send(body);
}

export async function registerDistributionRoutes(
  application: FastifyInstance,
  options: { directory?: string; publicOrigin: string },
): Promise<void> {
  const origin = new URL(options.publicOrigin).origin;
  const packageUrl = `${origin}/downloads/yaaps-skill.zip`;

  // These routes are public and unauthenticated. Verifying (full SHA-256 of the
  // package) on every request is a cheap CPU/IO amplification vector, so cache
  // the verified result and only re-verify when the package file changes.
  let verifiedCache: {
    fingerprint: string;
    distribution: VerifiedSkillDistribution;
  } | null = null;
  const verifiedDistribution = async (): Promise<VerifiedSkillDistribution> => {
    if (!options.directory) {
      throw new Error("Skill distribution is not configured.");
    }
    const packagePath = path.join(
      path.resolve(options.directory),
      DISTRIBUTION_FILES.package,
    );
    const stats = await stat(packagePath);
    const fingerprint = `${stats.mtimeMs}:${stats.size}`;
    if (verifiedCache && verifiedCache.fingerprint === fingerprint) {
      return verifiedCache.distribution;
    }
    const distribution = await loadVerifiedDistribution(options.directory);
    verifiedCache = { fingerprint, distribution };
    return distribution;
  };

  const registerFile = (
    route: string,
    key: keyof typeof DISTRIBUTION_FILES,
    contentType: string,
    disposition: "attachment" | "inline",
  ) => {
    application.get(route, async (_request, reply) => {
      try {
        const distribution = await verifiedDistribution();
        return sendDownload(
          reply,
          createReadStream(distribution.paths[key]),
          DISTRIBUTION_FILES[key],
          contentType,
          disposition,
        );
      } catch {
        return unavailable(reply);
      }
    });
  };

  registerFile(
    "/downloads/yaaps-skill.zip",
    "package",
    "application/zip",
    "attachment",
  );
  registerFile(
    "/downloads/yaaps-skill.zip.sha256",
    "checksum",
    "text/plain; charset=utf-8",
    "inline",
  );

  for (const installer of [
    {
      contentType: "text/plain; charset=utf-8",
      key: "powershellInstaller" as const,
      route: "/downloads/install-skill.ps1",
    },
    {
      contentType: "text/x-shellscript; charset=utf-8",
      key: "posixInstaller" as const,
      route: "/downloads/install-skill.sh",
    },
  ]) {
    application.get(installer.route, async (_request, reply) => {
      try {
        const distribution = await verifiedDistribution();
        const template = await readFile(
          distribution.paths[installer.key],
          "utf8",
        );
        if (!template.includes("__YAAPS_SKILL_PACKAGE_URL__")) {
          return unavailable(reply);
        }
        return sendDownload(
          reply,
          template.replaceAll("__YAAPS_SKILL_PACKAGE_URL__", packageUrl),
          DISTRIBUTION_FILES[installer.key],
          installer.contentType,
          "inline",
        );
      } catch {
        return unavailable(reply);
      }
    });
  }
}
