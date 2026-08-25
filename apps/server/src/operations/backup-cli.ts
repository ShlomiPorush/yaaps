import path from "node:path";
import { pathToFileURL } from "node:url";

import { createBackup, restoreBackup } from "./backup.js";

function usage(): never {
  throw new Error(
    "Usage: data backup <data-directory> <backup-directory> | data restore <backup-directory> <data-directory> --confirm <absolute-data-directory>",
  );
}

export async function runDataOperation(arguments_: string[]): Promise<void> {
  const [operation, source, destination, confirmFlag, confirmation, ...extra] =
    arguments_;
  if (!source || !destination || extra.length > 0) usage();

  if (operation === "backup" && !confirmFlag && !confirmation) {
    const manifest = await createBackup(source, destination);
    process.stdout.write(
      `${JSON.stringify({ backupDirectory: path.resolve(destination), blobs: manifest.blobs.length, createdAt: manifest.createdAt })}\n`,
    );
    return;
  }
  if (
    operation === "restore" &&
    confirmFlag === "--confirm" &&
    confirmation === path.resolve(destination)
  ) {
    const manifest = await restoreBackup(source, destination);
    process.stdout.write(
      `${JSON.stringify({ blobs: manifest.blobs.length, restoredDataDirectory: path.resolve(destination) })}\n`,
    );
    return;
  }
  usage();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runDataOperation(process.argv.slice(2));
}
