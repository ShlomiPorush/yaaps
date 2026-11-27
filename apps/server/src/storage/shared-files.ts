import { randomUUID } from "node:crypto";
import {
  access,
  constants,
  copyFile,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import { isMissingFileError } from "./blob-store.js";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

async function publishFile(source: string, target: string): Promise<void> {
  const temporary = path.join(path.dirname(target), `.${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL);
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function publishMissingFiles(
  sourceDirectory: string,
  targetDirectory: string,
  fileNames?: readonly string[],
): Promise<void> {
  await mkdir(targetDirectory, { recursive: true });
  const names =
    fileNames ??
    (await readdir(sourceDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  for (const name of names) {
    const target = path.join(targetDirectory, name);
    if (!(await fileExists(target))) {
      await publishFile(path.join(sourceDirectory, name), target);
    }
  }
}
