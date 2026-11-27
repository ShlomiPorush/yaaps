import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

const BLOB_KEY_PATTERN = /^blobs\/([a-f0-9]{2})\/([a-f0-9]{64})\.html$/;

export const TEMPORARY_FILE_MAXIMUM_AGE_MILLISECONDS = 60 * 60 * 1_000;

export interface StoredBlob {
  byteLength: number;
  key: string;
  sha256: string;
}

export interface PreparedBlob extends StoredBlob {
  temporaryPath: string;
}

export class BlobIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobIntegrityError";
  }
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  await unlink(filePath).catch((error: unknown) => {
    if (!isMissingFileError(error)) {
      throw error;
    }
  });
}

export class HtmlBlobStore {
  readonly #blobDirectory: string;
  readonly #temporaryDirectory: string;

  constructor(private readonly dataDirectory: string) {
    this.#blobDirectory = path.join(dataDirectory, "blobs");
    this.#temporaryDirectory = path.join(dataDirectory, ".blob-tmp");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.#blobDirectory, { recursive: true }),
      mkdir(this.#temporaryDirectory, { recursive: true }),
    ]);
  }

  async prepare(content: Uint8Array): Promise<PreparedBlob> {
    if (content.byteLength === 0) {
      throw new BlobIntegrityError("An HTML blob cannot be empty.");
    }

    await this.initialize();
    const sha256 = digest(content);
    const key = `blobs/${sha256.slice(0, 2)}/${sha256}.html`;
    const { filePath: destinationPath } = this.#resolveKey(key);
    const temporaryPath = path.join(
      this.#temporaryDirectory,
      `${randomUUID()}.tmp`,
    );

    await mkdir(path.dirname(destinationPath), { recursive: true });
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      await unlinkIfPresent(temporaryPath).catch(() => undefined);
      throw error;
    }

    const prepared = {
      byteLength: content.byteLength,
      key,
      sha256,
      temporaryPath,
    };
    try {
      await this.#verifyExistingFile(
        destinationPath,
        sha256,
        content.byteLength,
      );
    } catch (error) {
      await this.discard(prepared);
      throw error;
    }
    return prepared;
  }

  async publish(prepared: PreparedBlob): Promise<void> {
    const { filePath: destinationPath } = this.#resolveKey(prepared.key);
    try {
      await link(prepared.temporaryPath, destinationPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      if ((await stat(destinationPath)).size !== prepared.byteLength) {
        throw new BlobIntegrityError(
          "An existing blob does not match its content address.",
        );
      }
    }
  }

  async discard(prepared: PreparedBlob): Promise<void> {
    await unlinkIfPresent(prepared.temporaryPath);
  }

  async store(content: Uint8Array): Promise<StoredBlob> {
    const prepared = await this.prepare(content);
    try {
      await this.publish(prepared);
    } finally {
      await this.discard(prepared);
    }
    return {
      byteLength: prepared.byteLength,
      key: prepared.key,
      sha256: prepared.sha256,
    };
  }

  async read(key: string): Promise<Buffer> {
    const { digest: expectedDigest, filePath } = this.#resolveKey(key);
    const content = await readFile(filePath);
    if (digest(content) !== expectedDigest) {
      throw new BlobIntegrityError(
        "The stored blob failed its integrity check.",
      );
    }
    return content;
  }

  async listKeys(): Promise<string[]> {
    await this.initialize();
    const keys: string[] = [];
    const directories = await readdir(this.#blobDirectory, {
      withFileTypes: true,
    });

    for (const directory of directories) {
      if (!directory.isDirectory() || !/^[a-f0-9]{2}$/.test(directory.name)) {
        continue;
      }
      const entries = await readdir(
        path.join(this.#blobDirectory, directory.name),
        { withFileTypes: true },
      );
      for (const entry of entries) {
        const key = `blobs/${directory.name}/${entry.name}`;
        if (entry.isFile() && BLOB_KEY_PATTERN.test(key)) {
          keys.push(key);
        }
      }
    }

    return keys.sort();
  }

  async remove(key: string): Promise<void> {
    await unlinkIfPresent(this.#resolveKey(key).filePath);
  }

  async cleanupTemporaryFiles(now = new Date()): Promise<number> {
    await this.initialize();
    const cutoff = now.getTime() - TEMPORARY_FILE_MAXIMUM_AGE_MILLISECONDS;
    const entries = await readdir(this.#temporaryDirectory, {
      withFileTypes: true,
    });
    let removed = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".tmp")) {
        continue;
      }
      const filePath = path.join(this.#temporaryDirectory, entry.name);
      const modifiedAt = await stat(filePath).then(
        (details) => details.mtimeMs,
        (error: unknown) => {
          if (isMissingFileError(error)) {
            return undefined;
          }
          throw error;
        },
      );
      if (modifiedAt === undefined || modifiedAt > cutoff) {
        continue;
      }
      await unlinkIfPresent(filePath);
      removed += 1;
    }

    return removed;
  }

  async #verifyExistingFile(
    filePath: string,
    expectedDigest: string,
    expectedLength: number,
  ): Promise<void> {
    let handle;
    try {
      handle = await open(filePath, "r");
    } catch (error) {
      if (isMissingFileError(error)) {
        return;
      }
      throw error;
    }
    try {
      if ((await handle.stat()).size !== expectedLength) {
        throw new BlobIntegrityError(
          "An existing blob does not match its content address.",
        );
      }
      if (digest(await handle.readFile()) !== expectedDigest) {
        throw new BlobIntegrityError(
          "An existing blob does not match its content address.",
        );
      }
    } finally {
      await handle.close();
    }
  }

  #resolveKey(key: string): { digest: string; filePath: string } {
    const match = BLOB_KEY_PATTERN.exec(key);
    if (!match || !match[2] || match[1] !== match[2].slice(0, 2)) {
      throw new BlobIntegrityError("The blob key is invalid.");
    }
    return {
      digest: match[2],
      filePath: path.join(this.dataDirectory, ...key.split("/")),
    };
  }
}
