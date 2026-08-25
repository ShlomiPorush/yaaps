import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const skillDirectory = path.join(repositoryRoot, "plugins/yaaps/skills/yaaps");
const installerDirectory = path.join(
  repositoryRoot,
  "plugins/yaaps/installers",
);
const defaultOutputDirectory = path.join(
  repositoryRoot,
  "apps/server/dist/skill-distribution",
);
const fixedDosDate = 33;
const fixedDosTime = 0;

function parseOutputDirectory(arguments_) {
  if (arguments_.length === 0) return defaultOutputDirectory;
  if (arguments_.length === 2 && arguments_[0] === "--output") {
    return path.resolve(arguments_[1]);
  }
  throw new Error(
    "Usage: node build-skill-distribution.mjs [--output <directory>]",
  );
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function collectFiles(directory, relativeDirectory = "") {
  const files = [];
  const entries = await readdir(path.join(directory, relativeDirectory), {
    withFileTypes: true,
  });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(directory, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Unsupported non-file skill entry: ${relativePath}`);
    }
  }
  return files;
}

async function createZip() {
  const localRecords = [];
  const centralRecords = [];
  let localOffset = 0;

  for (const relativePath of await collectFiles(skillDirectory)) {
    const archiveName = `yaaps/${relativePath.split(path.sep).join("/")}`;
    const name = Buffer.from(archiveName, "utf8");
    const source = await readFile(path.join(skillDirectory, relativePath));
    const compressed = deflateRawSync(source, { level: 9 });
    const checksum = crc32(source);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(fixedDosTime, 10);
    localHeader.writeUInt16LE(fixedDosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(source.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    const localRecord = Buffer.concat([localHeader, name, compressed]);
    localRecords.push(localRecord);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(fixedDosTime, 12);
    centralHeader.writeUInt16LE(fixedDosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(source.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    const unixMode = archiveName.endsWith(".sh") ? 0o100755 : 0o100644;
    centralHeader.writeUInt32LE((unixMode * 0x10000) >>> 0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralRecords.push(Buffer.concat([centralHeader, name]));
    localOffset += localRecord.length;
  }

  const centralDirectory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centralRecords.length, 8);
  end.writeUInt16LE(centralRecords.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

async function build(outputDirectory) {
  await readFile(path.join(skillDirectory, "SKILL.md"));
  const parent = path.dirname(outputDirectory);
  const nonce = `${process.pid}-${Date.now()}`;
  const staging = path.join(parent, `.yaaps-skill-distribution-${nonce}`);
  const backup = path.join(parent, `.yaaps-skill-distribution-backup-${nonce}`);
  let backedUp = false;

  await mkdir(parent, { recursive: true });
  try {
    await mkdir(staging);
    const archive = await createZip();
    await writeFile(path.join(staging, "yaaps-skill.zip"), archive);
    const digest = createHash("sha256").update(archive).digest("hex");
    await writeFile(
      path.join(staging, "yaaps-skill.zip.sha256"),
      `${digest}  yaaps-skill.zip\n`,
      "ascii",
    );
    for (const installer of [
      "install-yaaps-skill.ps1",
      "install-yaaps-skill.sh",
    ]) {
      await copyFile(
        path.join(installerDirectory, installer),
        path.join(staging, installer),
      );
    }
    await chmod(path.join(staging, "install-yaaps-skill.sh"), 0o755);

    try {
      await rename(outputDirectory, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(staging, outputDirectory);
    } catch (error) {
      if (backedUp) await rename(backup, outputDirectory);
      throw error;
    }
    if (backedUp) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const outputDirectory = parseOutputDirectory(process.argv.slice(2));
await build(outputDirectory);
process.stdout.write(`Created YAAPS skill distribution: ${outputDirectory}\n`);
