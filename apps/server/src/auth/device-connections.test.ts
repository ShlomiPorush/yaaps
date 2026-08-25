import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthenticationRepository } from "./repository.js";
import {
  DeviceConnectionDecidedError,
  DeviceConnectionExpiredError,
  DeviceConnectionNotFoundError,
  DeviceConnectionRepository,
} from "./device-connections.js";
import { openDatabase, type YaapsDatabase } from "../storage/database.js";

const temporaryPaths: string[] = [];
let authentication: AuthenticationRepository;
let connections: DeviceConnectionRepository;
let database: YaapsDatabase;
let now: Date;

beforeEach(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "yaaps-device-test-"));
  temporaryPaths.push(directory);
  database = await openDatabase(directory);
  now = new Date("2026-08-24T00:00:00.000Z");
  authentication = new AuthenticationRepository(database.connection, () => now);
  connections = new DeviceConnectionRepository(database.connection, () => now);
});

afterEach(async () => {
  await database.connection.destroy();
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((entry) => rm(entry, { force: true, recursive: true })),
  );
});

function proposedKey() {
  const secret = randomBytes(32).toString("base64url");
  const keyPrefix = `yaaps_${secret.slice(0, 10)}`;
  const key = `${keyPrefix}_${secret}`;
  return {
    key,
    keyHash: createHash("sha256").update(key).digest("hex"),
    keyPrefix,
  };
}

describe("device connection repository", () => {
  it("denies exactly one matched request and never creates its proposed key", async () => {
    const userId = await authentication.createUser({
      displayName: "User",
      role: "user",
    });
    const firstKey = proposedKey();
    const secondKey = proposedKey();
    const first = await connections.create({ ...firstKey, label: "First" });
    const second = await connections.create({ ...secondKey, label: "Second" });

    await expect(
      connections.deny({
        id: first.id,
        userCode: second.userCode,
        userId,
      }),
    ).rejects.toBeInstanceOf(DeviceConnectionNotFoundError);
    await connections.deny({
      id: first.id,
      userCode: first.userCode,
      userId,
    });
    await expect(connections.poll(first.deviceSecret)).resolves.toEqual({
      status: "denied",
    });
    await expect(
      connections.deny({
        id: first.id,
        userCode: first.userCode,
        userId,
      }),
    ).rejects.toBeInstanceOf(DeviceConnectionDecidedError);
    await expect(
      authentication.authenticateApiKey(firstKey.key),
    ).rejects.toThrow();
    await expect(connections.poll(second.deviceSecret)).resolves.toEqual({
      status: "pending",
    });
  });

  it("rejects expired requests for inspection, decisions, and polling", async () => {
    const userId = await authentication.createUser({
      displayName: "User",
      role: "user",
    });
    const created = await connections.create({
      ...proposedKey(),
      label: "Expired",
    });
    now = new Date(created.expiresAt);

    await expect(
      connections.getPending(created.userCode),
    ).rejects.toBeInstanceOf(DeviceConnectionExpiredError);
    await expect(connections.poll(created.deviceSecret)).rejects.toBeInstanceOf(
      DeviceConnectionExpiredError,
    );
    await expect(
      connections.approve({
        id: created.id,
        userCode: created.userCode,
        userId,
      }),
    ).rejects.toBeInstanceOf(DeviceConnectionExpiredError);
  });

  it("reclaims stale connection rows in bounded batches without deleting approved API keys", async () => {
    const userId = await authentication.createUser({
      displayName: "User",
      role: "user",
    });
    const key = proposedKey();
    const created = await connections.create({ ...key, label: "Approved" });
    const approved = await connections.approve({
      id: created.id,
      userCode: created.userCode,
      userId,
    });
    now = new Date(
      new Date(created.expiresAt).getTime() + 24 * 60 * 60 * 1_000 + 1,
    );

    await connections.create({ ...proposedKey(), label: "Cleanup trigger" });

    expect(
      await database.connection
        .selectFrom("device_connections")
        .select("id")
        .where("id", "=", created.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    await expect(authentication.authenticateApiKey(key.key)).resolves.toEqual({
      apiKeyId: approved.apiKey.id,
      role: "user",
      userId,
    });
  });
});
