import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance, FastifyReply } from "fastify";

import { isMissingFileError } from "../storage/blob-store.js";
import { publishMissingFiles } from "../storage/shared-files.js";

const DISTRIBUTION_FILES = {
  checksum: "yaaps-skill.zip.sha256",
  package: "yaaps-skill.zip",
  posixInstaller: "install-yaaps-skill.sh",
  powershellInstaller: "install-yaaps-skill.ps1",
} as const;

const SHARED_DOWNLOAD_FILES = [
  DISTRIBUTION_FILES.package,
  DISTRIBUTION_FILES.checksum,
] as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

interface VerifiedSkillDistribution {
  paths: Record<keyof typeof DISTRIBUTION_FILES, string>;
  root: string;
  sha256: string;
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
  if (!match?.[1] || (await fileSha256(paths.package)) !== match[1]) {
    throw new Error("Skill package checksum does not match.");
  }
  return { paths, root, sha256: match[1] };
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
  options: {
    directory?: string;
    publicOrigin: string;
    sharedDirectory: string;
  },
): Promise<{ sharedFilesPublished: boolean }> {
  const origin = new URL(options.publicOrigin).origin;
  const packageUrl = (sha256: string) =>
    `${origin}/downloads/skill/${sha256}/${DISTRIBUTION_FILES.package}`;

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

  for (const [fileName, contentType, disposition] of [
    [DISTRIBUTION_FILES.package, "application/zip", "attachment"],
    [DISTRIBUTION_FILES.checksum, "text/plain; charset=utf-8", "inline"],
  ] as const) {
    application.get<{ Params: { sha256: string } }>(
      `/downloads/skill/:sha256/${fileName}`,
      async (request, reply) => {
        const { sha256 } = request.params;
        if (!SHA256_PATTERN.test(sha256)) {
          return reply.callNotFound();
        }
        const own = await verifiedDistribution().catch(() => null);
        let filePath: string;
        if (own?.sha256 === sha256) {
          filePath = path.join(own.root, fileName);
        } else {
          const sharedEntry = (
            await readdir(options.sharedDirectory).catch(() => [])
          ).find((entry) => entry === sha256);
          if (!sharedEntry) {
            return reply.callNotFound();
          }
          filePath = path.join(options.sharedDirectory, sharedEntry, fileName);
        }
        let handle;
        try {
          handle = await open(filePath, "r");
        } catch (error) {
          if (isMissingFileError(error)) {
            return reply.callNotFound();
          }
          return unavailable(reply);
        }
        return sendDownload(
          reply,
          handle.createReadStream(),
          fileName,
          contentType,
          disposition,
        );
      },
    );
  }

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
          template.replaceAll(
            "__YAAPS_SKILL_PACKAGE_URL__",
            packageUrl(distribution.sha256),
          ),
          DISTRIBUTION_FILES[installer.key],
          installer.contentType,
          "inline",
        );
      } catch {
        return unavailable(reply);
      }
    });
  }

  const distribution = options.directory
    ? await verifiedDistribution().catch(() => null)
    : null;
  if (!distribution) {
    return { sharedFilesPublished: true };
  }
  try {
    await publishMissingFiles(
      distribution.root,
      path.join(options.sharedDirectory, distribution.sha256),
      SHARED_DOWNLOAD_FILES,
    );
    return { sharedFilesPublished: true };
  } catch (error) {
    application.log.error(
      { err: error },
      "The skill package could not be copied to the shared download directory.",
    );
    return { sharedFilesPublished: false };
  }
}
