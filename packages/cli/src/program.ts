import path from "node:path";
import { hostname } from "node:os";

import {
  DEFAULT_SERVICE_ORIGIN,
  draftIdSchema,
  FOUNDATION_VERSION,
  type ReportResourcePolicy,
} from "@yaaps/contracts";
import { Command, InvalidArgumentError } from "commander";

import {
  deleteDraft,
  getDraft,
  listDrafts,
  listDraftVersions,
  publishReport,
  updateDraft,
  type YaapsCredentials,
} from "./api.js";
import {
  apiKeyPrefix,
  localMappingKey,
  normalizeServiceUrl,
  readCliConfig,
  resolveCliConfigDirectory,
  validateApiKey,
  writeCliConfig,
  type CliConfig,
} from "./config.js";
import { openExternalUrl } from "./browser.js";
import { normalizeHtmlFile } from "./normalize.js";
import { fetchServiceStatus } from "./status.js";
import {
  generateApiKey,
  pollDeviceConnection,
  startDeviceConnection,
} from "./connect.js";

export interface ProgramDependencies {
  configDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  fetchImplementation?: typeof fetch;
  openExternal?: (url: string) => Promise<void>;
  workingDirectory?: string;
  writeError?: (message: string) => void;
  writeOutput?: (message: string) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface CredentialOptions {
  apiKey?: string;
  apiUrl?: string;
}

export function shouldOpenVerificationUrl(
  json: boolean | undefined,
  open: boolean | undefined,
  optionSource: string | undefined,
): boolean {
  const explicitlyRequestedOpen = optionSource === "cli" && open === true;
  return open !== false && (!json || explicitlyRequestedOpen);
}

function boundedIntegerOption(
  name: string,
  minimum: number,
  maximum: number,
): (value: string) => number {
  return (value: string): number => {
    if (!/^\d+$/.test(value)) {
      throw new InvalidArgumentError(`${name} must be a whole number.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new InvalidArgumentError(
        `${name} must be between ${minimum} and ${maximum}.`,
      );
    }
    return parsed;
  };
}

function resourcePolicyOption(value: string): ReportResourcePolicy {
  if (value !== "isolated" && value !== "connected") {
    throw new InvalidArgumentError(
      "--mode must be either isolated or connected.",
    );
  }
  return value;
}

const DRAFT_ID_OPERAND = /^-[A-Za-z0-9_-]{31}$/;

// Draft IDs are 32 random base64url characters, so roughly one in 64 starts
// with "-", which commander would reject as an unknown option. Commander has
// no operand escape besides "--", so the raw argv is rewritten to hoist such
// IDs behind one terminator while option values stay attached to their flags.
// Every later operand is hoisted too, so a command taking more than one
// operand keeps them in the order the user typed.
export function escapeDraftIdOperands(
  program: Command,
  argv: readonly string[],
): string[] {
  const valueFlags = new Set<string>();
  const collect = (command: Command) => {
    for (const option of command.options) {
      if (option.required || option.optional) {
        for (const flag of [option.short, option.long]) {
          if (flag) {
            valueFlags.add(flag);
          }
        }
      }
    }
    for (const subcommand of command.commands) {
      collect(subcommand);
    }
  };
  collect(program);

  const terminator = argv.indexOf("--");
  const scanned = terminator === -1 ? argv : argv.slice(0, terminator);
  const passthrough = terminator === -1 ? [] : argv.slice(terminator + 1);
  const kept: string[] = [];
  const hoisted: string[] = [];
  for (let index = 0; index < scanned.length; index += 1) {
    const token = scanned[index]!;
    if (valueFlags.has(token)) {
      kept.push(token);
      if (index + 1 < scanned.length) {
        index += 1;
        kept.push(scanned[index]!);
      }
      continue;
    }
    if (DRAFT_ID_OPERAND.test(token)) {
      hoisted.push(token);
      continue;
    }
    (hoisted.length > 0 && !token.startsWith("-") ? hoisted : kept).push(token);
  }
  if (hoisted.length === 0 && terminator === -1) {
    return [...argv];
  }
  return [...kept, "--", ...hoisted, ...passthrough];
}

function requireDraftId(value: string): string {
  if (!draftIdSchema.safeParse(value).success) {
    throw new Error("The draft ID format is invalid.");
  }
  return value;
}

function credentialsFrom(
  options: CredentialOptions,
  environment: NodeJS.ProcessEnv,
  config: CliConfig,
): YaapsCredentials {
  const apiUrl =
    options.apiUrl ??
    environment.YAAPS_API_URL ??
    config.apiUrl ??
    DEFAULT_SERVICE_ORIGIN;
  const apiKey = options.apiKey ?? environment.YAAPS_API_KEY ?? config.apiKey;
  if (!apiKey) {
    throw new Error(
      "YAAPS credentials are missing. Run `yaaps connect` to link this machine to yaaps.net, or pass --api-url for a self-hosted instance.",
    );
  }
  return {
    apiKey: validateApiKey(apiKey),
    apiUrl: normalizeServiceUrl(apiUrl),
  };
}

function addCredentialOptions(command: Command): Command {
  return command
    .option("--api-url <url>", "YAAPS service base URL")
    .option("--api-key <key>", "YAAPS API key");
}

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const environment = dependencies.environment ?? process.env;
  const fetchImplementation = dependencies.fetchImplementation ?? fetch;
  const openExternal = dependencies.openExternal ?? openExternalUrl;
  const writeError =
    dependencies.writeError ?? ((message) => console.error(message));
  const writeOutput =
    dependencies.writeOutput ?? ((message) => console.log(message));
  const workingDirectory = dependencies.workingDirectory ?? process.cwd();
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const configDirectory = resolveCliConfigDirectory(
    dependencies.configDirectory ?? environment.YAAPS_CONFIG_DIR,
  );
  const program = new Command();

  const run = async (label: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeError(`${label} failed: ${message}`);
      process.exitCode = 1;
    }
  };

  program
    .name("yaaps")
    .description("Publish and inspect reports on a self-hosted YAAPS service.")
    .version(FOUNDATION_VERSION);

  program
    .command("status")
    .description("Check service health and storage readiness.")
    .option("--api-url <url>", "YAAPS service base URL")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { apiUrl?: string; json?: boolean }) => {
      await run("YAAPS status", async () => {
        let resolvedUrl = options.apiUrl ?? environment.YAAPS_API_URL;
        if (!resolvedUrl) {
          const config = await readCliConfig(configDirectory);
          resolvedUrl = config.apiUrl ?? DEFAULT_SERVICE_ORIGIN;
        }
        const status = await fetchServiceStatus(
          normalizeServiceUrl(resolvedUrl),
          fetchImplementation,
        );
        writeOutput(
          options.json
            ? JSON.stringify(status, null, 2)
            : `${status.health.name} ${status.health.version}: ${status.health.status}; storage ${status.readiness.checks.dataDirectory}`,
        );
      });
    });

  const configCommand = program
    .command("config")
    .description("Manage user-scoped YAAPS CLI credentials.");
  configCommand
    .command("set")
    .description("Store the selected service URL and API key.")
    .requiredOption("--api-url <url>", "YAAPS service base URL")
    .requiredOption("--api-key <key>", "YAAPS API key")
    .action(async (options: { apiKey: string; apiUrl: string }) => {
      await run("YAAPS configuration", async () => {
        const existing = await readCliConfig(configDirectory);
        const apiUrl = normalizeServiceUrl(options.apiUrl);
        const apiKey = validateApiKey(options.apiKey);
        await writeCliConfig(configDirectory, {
          apiKey,
          apiUrl,
          drafts:
            existing.apiUrl === apiUrl && existing.apiKey === apiKey
              ? existing.drafts
              : {},
          version: 1,
        });
        writeOutput(
          `Configured ${apiUrl} with API key ${apiKeyPrefix(apiKey)}.`,
        );
      });
    });

  program
    .command("connect")
    .description("Securely connect this CLI through browser approval.")
    .option("--api-url <url>", "YAAPS service base URL", DEFAULT_SERVICE_ORIGIN)
    .option("--label <name>", "Label shown during approval")
    .option("--open", "Open the approval page in the default browser")
    .option("--no-open", "Do not open a browser")
    .option("--json", "Print machine-readable JSON events")
    .action(
      async (
        options: {
          apiUrl: string;
          json?: boolean;
          label?: string;
          open?: boolean;
        },
        command: Command,
      ) => {
        await run("YAAPS connect", async () => {
          const apiUrl = normalizeServiceUrl(options.apiUrl);
          const label = (
            options.label ?? `YAAPS CLI on ${hostname() || "this device"}`
          ).trim();
          if (label.length < 1 || label.length > 100) {
            throw new Error(
              "The connection label must be 1 to 100 characters.",
            );
          }
          const proposed = generateApiKey();
          const connection = await startDeviceConnection(
            apiUrl,
            {
              keyHash: proposed.hash,
              keyPrefix: proposed.prefix,
              label,
            },
            fetchImplementation,
          );
          writeOutput(
            options.json
              ? JSON.stringify({
                  expiresAt: connection.expiresAt,
                  status: "pending",
                  userCode: connection.userCode,
                  verificationUrl: connection.verificationUrlComplete,
                })
              : `Open ${connection.verificationUrlComplete}\nConfirm code ${connection.userCode}. Waiting for approval...`,
          );

          const shouldOpen = shouldOpenVerificationUrl(
            options.json,
            options.open,
            command.getOptionValueSource("open"),
          );
          if (shouldOpen) {
            try {
              await openExternal(connection.verificationUrlComplete);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              writeError(
                `Could not open the browser automatically: ${message} Open ${connection.verificationUrlComplete} manually.`,
              );
            }
          }

          const expiresAt = Date.parse(connection.expiresAt);
          while (Date.now() < expiresAt) {
            await sleep(
              Math.min(
                connection.intervalSeconds * 1_000,
                expiresAt - Date.now(),
              ),
            );
            if (Date.now() >= expiresAt) break;
            // Transient failures (a 429 at the rate-limit boundary, a network
            // blip) must not abort a request the user may already be approving
            // in the browser; only denial and expiry are fatal.
            let decision;
            try {
              decision = await pollDeviceConnection(
                apiUrl,
                connection.deviceSecret,
                fetchImplementation,
              );
            } catch {
              continue;
            }
            if (decision.status === "pending") continue;
            if (decision.status === "denied") {
              throw new Error("The connection request was denied.");
            }
            // A new key always starts with an empty drafts mapping: the key was
            // generated moments ago, so no stored mapping can belong to it.
            await writeCliConfig(configDirectory, {
              apiKey: proposed.key,
              apiUrl,
              drafts: {},
              version: 1,
            });
            writeOutput(
              options.json
                ? JSON.stringify({
                    apiKeyId: decision.apiKeyId,
                    apiKeyPrefix: proposed.prefix,
                    apiUrl,
                    status: "approved",
                  })
                : `Connected to ${apiUrl} with API key ${proposed.prefix}.`,
            );
            return;
          }
          throw new Error("The connection request expired.");
        });
      },
    );
  configCommand
    .command("show")
    .description("Show the selected service without revealing the API key.")
    .option("--json", "Print machine-readable JSON")
    .action(async (options: { json?: boolean }) => {
      await run("YAAPS configuration", async () => {
        const config = await readCliConfig(configDirectory);
        const visible = {
          apiKeyPrefix: config.apiKey ? apiKeyPrefix(config.apiKey) : null,
          apiUrl: config.apiUrl ?? null,
          mappedDrafts: Object.keys(config.drafts).length,
        };
        writeOutput(
          options.json
            ? JSON.stringify(visible, null, 2)
            : `${visible.apiUrl ?? "Not configured"}; key ${visible.apiKeyPrefix ?? "missing"}; ${visible.mappedDrafts} mapped drafts.`,
        );
      });
    });

  addCredentialOptions(
    program
      .command("publish <file>")
      .description("Normalize and publish one HTML report.")
      .option("--category <name>", "Set or update the report category")
      .option("--draft-id <id>", "Publish a version to an explicit draft")
      .option("--new-draft", "Create a new draft and replace the local mapping")
      .option(
        "--mode <mode>",
        "Resource policy: isolated or connected",
        resourcePolicyOption,
        "connected",
      )
      .option("--title <title>", "Set or update the report title")
      .option(
        "--ttl <seconds>",
        "Report lifetime in seconds",
        boundedIntegerOption("--ttl", 1, Number.MAX_SAFE_INTEGER),
      )
      .option("--json", "Print machine-readable JSON"),
  ).action(
    async (
      file: string,
      options: CredentialOptions & {
        category?: string;
        draftId?: string;
        json?: boolean;
        mode: ReportResourcePolicy;
        newDraft?: boolean;
        title?: string;
        ttl?: number;
      },
    ) => {
      await run("YAAPS publish", async () => {
        if (options.newDraft && options.draftId) {
          throw new Error(
            "--new-draft and --draft-id cannot be used together.",
          );
        }
        const config = await readCliConfig(configDirectory);
        const credentials = credentialsFrom(options, environment, config);
        const filePath = path.resolve(workingDirectory, file);
        const mappingKey = localMappingKey(filePath);
        const configuredForService =
          config.apiUrl === credentials.apiUrl &&
          config.apiKey === credentials.apiKey;
        const mappedDraftId = configuredForService
          ? config.drafts[mappingKey]?.draftId
          : undefined;
        const draftId = options.newDraft
          ? undefined
          : options.draftId
            ? requireDraftId(options.draftId)
            : mappedDraftId;
        const result = await publishReport(
          credentials,
          {
            category: options.category,
            draftId,
            html: await normalizeHtmlFile(filePath, options.mode),
            resourcePolicy: options.mode,
            title: options.title,
            ttlSeconds: options.ttl,
          },
          fetchImplementation,
        );
        if (configuredForService) {
          config.drafts[mappingKey] = { draftId: result.draft.id };
          await writeCliConfig(configDirectory, config);
        }
        writeOutput(
          options.json
            ? JSON.stringify(result, null, 2)
            : `Published ${result.draft.publicUrl} (draft ${result.draft.id}, version ${result.version.versionNumber}).`,
        );
      });
    },
  );

  addCredentialOptions(
    program
      .command("list")
      .description("List drafts owned by the configured user.")
      .option("--category <name>", "Show only drafts in this exact category")
      .option(
        "--limit <number>",
        "Maximum rows",
        boundedIntegerOption("--limit", 1, 100),
        50,
      )
      .option(
        "--offset <number>",
        "Rows to skip",
        boundedIntegerOption("--offset", 0, 10_000),
        0,
      )
      .option("--json", "Print machine-readable JSON"),
  ).action(
    async (
      options: CredentialOptions & {
        category?: string;
        json?: boolean;
        limit: number;
        offset: number;
      },
    ) => {
      await run("YAAPS list", async () => {
        const config = await readCliConfig(configDirectory);
        const result = await listDrafts(
          credentialsFrom(options, environment, config),
          {
            category: options.category,
            limit: options.limit,
            offset: options.offset,
          },
          fetchImplementation,
        );
        writeOutput(
          options.json
            ? JSON.stringify(result, null, 2)
            : result.items.length === 0
              ? "No drafts found."
              : result.items
                  .map(
                    (draft) =>
                      `${draft.id}  ${draft.status}  v${draft.latestVersionNumber}  ${draft.title ?? "Untitled"}  ${draft.category ?? "Uncategorized"}  ${draft.publicUrl}`,
                  )
                  .join("\n"),
        );
      });
    },
  );

  addCredentialOptions(
    program
      .command("inspect <draft-id>")
      .description("Inspect a draft and its latest version metadata.")
      .option("--json", "Print machine-readable JSON"),
  ).action(
    async (
      draftId: string,
      options: CredentialOptions & { json?: boolean },
    ) => {
      await run("YAAPS inspect", async () => {
        const config = await readCliConfig(configDirectory);
        const credentials = credentialsFrom(options, environment, config);
        const id = requireDraftId(draftId);
        const [draft, versions] = await Promise.all([
          getDraft(credentials, id, fetchImplementation),
          listDraftVersions(
            credentials,
            id,
            { limit: 100, offset: 0 },
            fetchImplementation,
          ),
        ]);
        const result = { draft, versions };
        writeOutput(
          options.json
            ? JSON.stringify(result, null, 2)
            : `${draft.id}  ${draft.status}  ${draft.title ?? "Untitled"}\n${draft.publicUrl}\nResource policy: ${draft.resourcePolicy}.\n${versions.total} versions; latest v${draft.latestVersionNumber}.`,
        );
      });
    },
  );

  addCredentialOptions(
    program
      .command("categorize <draft-id> [category]")
      .description("Group a draft under a category, or clear its category.")
      .option("--clear", "Remove the draft from its category"),
  ).action(
    async (
      draftId: string,
      category: string | undefined,
      options: CredentialOptions & { clear?: boolean },
    ) => {
      await run("YAAPS categorize", async () => {
        if (options.clear && category !== undefined) {
          throw new Error("A category and --clear cannot be used together.");
        }
        if (!options.clear && category === undefined) {
          throw new Error("Provide a category or --clear.");
        }
        const config = await readCliConfig(configDirectory);
        const result = await updateDraft(
          credentialsFrom(options, environment, config),
          requireDraftId(draftId),
          { category: options.clear ? null : category },
          fetchImplementation,
        );
        writeOutput(
          result.category === null
            ? `${result.id} is now uncategorized.`
            : `${result.id} is now in ${result.category}.`,
        );
      });
    },
  );

  for (const status of ["disable", "enable"] as const) {
    addCredentialOptions(
      program
        .command(`${status} <draft-id>`)
        .description(`${status === "disable" ? "Disable" : "Enable"} a draft.`),
    ).action(async (draftId: string, options: CredentialOptions) => {
      await run(`YAAPS ${status}`, async () => {
        const config = await readCliConfig(configDirectory);
        const result = await updateDraft(
          credentialsFrom(options, environment, config),
          requireDraftId(draftId),
          { status: status === "disable" ? "disabled" : "enabled" },
          fetchImplementation,
        );
        writeOutput(`${result.id} is now ${result.status}.`);
      });
    });
  }

  addCredentialOptions(
    program
      .command("delete <draft-id>")
      .description("Permanently delete a draft and all of its versions.")
      .requiredOption(
        "--confirm <draft-id>",
        "Confirm the exact draft ID to delete",
      ),
  ).action(
    async (
      draftId: string,
      options: CredentialOptions & { confirm: string },
    ) => {
      await run("YAAPS delete", async () => {
        const id = requireDraftId(draftId);
        if (options.confirm !== id) {
          throw new Error("The confirmation draft ID does not match.");
        }
        const config = await readCliConfig(configDirectory);
        const credentials = credentialsFrom(options, environment, config);
        await deleteDraft(credentials, id, fetchImplementation);
        if (
          config.apiUrl === credentials.apiUrl &&
          config.apiKey === credentials.apiKey
        ) {
          config.drafts = Object.fromEntries(
            Object.entries(config.drafts).filter(
              ([, mapping]) => mapping.draftId !== id,
            ),
          );
          await writeCliConfig(configDirectory, config);
        }
        writeOutput(`Deleted draft ${id}.`);
      });
    },
  );

  return program;
}
