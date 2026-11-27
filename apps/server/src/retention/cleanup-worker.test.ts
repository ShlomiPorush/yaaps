import { describe, expect, it, vi } from "vitest";

import type { CleanupResult } from "../storage/draft-storage.js";
import { RetentionCleanupWorker } from "./cleanup-worker.js";
import type { LeaderRun } from "./leader-lock.js";

const alwaysLeader = {
  async runIfLeader<T>(run: () => Promise<T>): Promise<LeaderRun<T>> {
    return { led: true, result: await run() };
  },
};

const neverLeader = {
  async runIfLeader<T>(): Promise<LeaderRun<T>> {
    return { led: false };
  },
};

describe("retention cleanup worker", () => {
  it("runs on the configured schedule and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const cleanupExpired = vi.fn().mockResolvedValue({
        deletedDrafts: 0,
        reclaimedBlobs: 0,
        removedTemporaryFiles: 0,
      });
      const worker = new RetentionCleanupWorker(
        { cleanupExpired },
        60,
        { error: vi.fn(), info: vi.fn() },
        alwaysLeader,
      );
      worker.start();
      await vi.advanceTimersByTimeAsync(59_999);
      expect(cleanupExpired).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(cleanupExpired).toHaveBeenCalledOnce();
      await worker.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(cleanupExpired).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops cleanly while a failing run is still active", async () => {
    let rejectRun: (error: Error) => void = () => undefined;
    const worker = new RetentionCleanupWorker(
      {
        cleanupExpired: () =>
          new Promise((_resolve, reject) => {
            rejectRun = reject;
          }),
      },
      0,
      { error: vi.fn(), info: vi.fn() },
      alwaysLeader,
    );
    const run = worker.runOnce();
    const stopped = worker.stop();
    rejectRun(new Error("SQLITE_BUSY"));
    await expect(run).rejects.toThrow("SQLITE_BUSY");
    await expect(stopped).resolves.toBeUndefined();
  });

  it("coalesces overlapping runs and reports one cleanup result", async () => {
    let release: ((value: CleanupResult) => void) | undefined;
    const cleanupExpired = vi.fn(
      () =>
        new Promise<CleanupResult>((resolve) => {
          release = resolve;
        }),
    );
    const logger = { error: vi.fn(), info: vi.fn() };
    const worker = new RetentionCleanupWorker(
      { cleanupExpired },
      300,
      logger,
      alwaysLeader,
    );

    const first = worker.runOnce(new Date("2026-08-24T12:00:00.000Z"));
    const second = worker.runOnce(new Date("2026-08-24T13:00:00.000Z"));
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(cleanupExpired).toHaveBeenCalledOnce();
    const result = {
      deletedDrafts: 2,
      reclaimedBlobs: 2,
      removedTemporaryFiles: 0,
    };
    release?.(result);

    await expect(Promise.all([first, second])).resolves.toEqual([
      result,
      result,
    ]);
    expect(logger.info).toHaveBeenCalledOnce();
    await worker.stop();
  });

  it("skips a run while another instance leads the cleanup", async () => {
    const cleanupExpired = vi.fn();
    const logger = { error: vi.fn(), info: vi.fn() };
    const worker = new RetentionCleanupWorker(
      { cleanupExpired },
      300,
      logger,
      neverLeader,
    );

    await expect(worker.runOnce()).resolves.toBeNull();
    expect(cleanupExpired).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Retention cleanup skipped; another instance runs it.",
    );
  });
});
