import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { apiKeySchema, draftIdSchema } from "@yaaps/contracts";

export interface LocalDraftMapping {
  draftId: string;
}

export interface CliConfig {
  apiKey?: string;
  apiUrl?: string;
  drafts: Record<string, LocalDraftMapping>;
  version: 1;
}

export function emptyCliConfig(): CliConfig {
  return { drafts: {}, version: 1 };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

export function normalizeServiceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The YAAPS service URL is invalid.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("The YAAPS service URL must be an HTTP or HTTPS origin.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      "The YAAPS service URL must not include a path, query, or fragment.",
    );
  }
  return url.origin;
}

export function validateApiKey(value: string): string {
  if (!apiKeySchema.safeParse(value).success) {
    throw new Error("The YAAPS API key format is invalid.");
  }
  return value;
}

export function resolveCliConfigDirectory(
  explicitDirectory?: string,
  options: {
    environment?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    platform?: NodeJS.Platform;
  } = {},
): string {
  if (explicitDirectory) {
    return path.resolve(explicitDirectory);
  }
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  if (platform === "win32" && environment.APPDATA) {
    return path.join(environment.APPDATA, "YAAPS");
  }
  if (environment.XDG_CONFIG_HOME) {
    return path.join(environment.XDG_CONFIG_HOME, "yaaps");
  }
  if (!homeDirectory) {
    throw new Error("A user configuration directory could not be resolved.");
  }
  return path.join(homeDirectory, ".config", "yaaps");
}

export function localMappingKey(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.normalize(path.resolve(filePath));
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parseConfig(value: unknown): CliConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error("The YAAPS CLI configuration is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.drafts !== "object" ||
    candidate.drafts === null ||
    (candidate.apiUrl !== undefined && typeof candidate.apiUrl !== "string") ||
    (candidate.apiKey !== undefined && typeof candidate.apiKey !== "string")
  ) {
    throw new Error("The YAAPS CLI configuration is invalid.");
  }

  const drafts: Record<string, LocalDraftMapping> = {};
  for (const [key, mapping] of Object.entries(candidate.drafts)) {
    if (
      typeof mapping !== "object" ||
      mapping === null ||
      typeof (mapping as Record<string, unknown>).draftId !== "string" ||
      !draftIdSchema.safeParse(
        String((mapping as Record<string, unknown>).draftId),
      ).success
    ) {
      throw new Error("The YAAPS CLI draft mapping is invalid.");
    }
    drafts[key] = {
      draftId: String((mapping as Record<string, unknown>).draftId),
    };
  }

  return {
    ...(candidate.apiKey === undefined
      ? {}
      : { apiKey: validateApiKey(candidate.apiKey as string) }),
    ...(candidate.apiUrl === undefined
      ? {}
      : { apiUrl: normalizeServiceUrl(candidate.apiUrl as string) }),
    drafts,
    version: 1,
  };
}

export async function readCliConfig(directory: string): Promise<CliConfig> {
  try {
    return parseConfig(
      JSON.parse(await readFile(path.join(directory, "config.json"), "utf8")),
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return emptyCliConfig();
    }
    if (error instanceof SyntaxError) {
      throw new Error("The YAAPS CLI configuration is not valid JSON.", {
        cause: error,
      });
    }
    throw error;
  }
}

export async function writeCliConfig(
  directory: string,
  config: CliConfig,
): Promise<void> {
  const validated = parseConfig(config);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const destination = path.join(directory, "config.json");
  const temporary = path.join(directory, `.config-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, destination);
    await chmod(destination, 0o600).catch(() => undefined);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    });
  }
}

export function apiKeyPrefix(apiKey: string): string {
  // Server keys are `yaaps_` + the first 10 secret characters + `_` + secret.
  // The 10-character prefix is base64url and may itself contain underscores,
  // so splitting on `_` would truncate it.
  if (/^yaaps_.{10}_/.test(apiKey)) {
    return apiKey.slice(0, 16);
  }
  const [namespace, prefix] = apiKey.split("_", 3);
  return `${namespace}_${prefix}`;
}
