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

export interface StoredBlob {
  byteLength: number;
  key: string;
  sha256: string;
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

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
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

  async store(content: Uint8Array): Promise<StoredBlob> {
    if (content.byteLength === 0) {
      throw new BlobIntegrityError("An HTML blob cannot be empty.");
    }

    await this.initialize();
    const sha256 = digest(content);
    const relativeKey = `blobs/${sha256.slice(0, 2)}/${sha256}.html`;
    const destinationDirectory = path.join(
      this.#blobDirectory,
      sha256.slice(0, 2),
    );
    const destinationPath = path.join(destinationDirectory, `${sha256}.html`);
    const temporaryPath = path.join(
      this.#temporaryDirectory,
      `${randomUUID()}.tmp`,
    );

    await mkdir(destinationDirectory, { recursive: true });
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(temporaryPath, destinationPath);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      await this.#verifyFile(destinationPath, sha256, content.byteLength);
    } finally {
      await unlink(temporaryPath).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") {
          throw error;
        }
      });
    }

    return { byteLength: content.byteLength, key: relativeKey, sha256 };
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
    const { filePath } = this.#resolveKey(key);
    await unlink(filePath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    });
  }

  async cleanupTemporaryFiles(): Promise<number> {
    await this.initialize();
    const entries = await readdir(this.#temporaryDirectory, {
      withFileTypes: true,
    });
    let removed = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".tmp")) {
        continue;
      }
      await unlink(path.join(this.#temporaryDirectory, entry.name));
      removed += 1;
    }

    return removed;
  }

  async #verifyFile(
    filePath: string,
    expectedDigest: string,
    expectedLength: number,
  ): Promise<void> {
    const details = await stat(filePath);
    if (details.size !== expectedLength) {
      throw new BlobIntegrityError(
        "An existing blob does not match its content address.",
      );
    }
    const existing = await readFile(filePath);
    if (digest(existing) !== expectedDigest) {
      throw new BlobIntegrityError(
        "An existing blob does not match its content address.",
      );
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
