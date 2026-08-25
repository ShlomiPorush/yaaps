import { describe, expect, it, vi } from "vitest";

import type { DraftStorage } from "../storage/draft-storage.js";
import { RetentionCleanupWorker } from "./cleanup-worker.js";

describe("retention cleanup worker", () => {
  it("runs on the configured schedule and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const cleanupExpired = vi.fn().mockResolvedValue({
        deletedDrafts: 0,
        reclaimedBlobs: 0,
      });
      const worker = new RetentionCleanupWorker(
        { cleanupExpired } as unknown as DraftStorage,
        60,
        { error: vi.fn(), info: vi.fn() },
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

  it("coalesces overlapping runs and reports one cleanup result", async () => {
    let release:
      | ((value: { deletedDrafts: number; reclaimedBlobs: number }) => void)
      | undefined;
    const cleanupExpired = vi.fn(
      () =>
        new Promise<{ deletedDrafts: number; reclaimedBlobs: number }>(
          (resolve) => {
            release = resolve;
          },
        ),
    );
    const logger = { error: vi.fn(), info: vi.fn() };
    const worker = new RetentionCleanupWorker(
      { cleanupExpired } as unknown as DraftStorage,
      300,
      logger,
    );

    const first = worker.runOnce(new Date("2026-08-24T12:00:00.000Z"));
    const second = worker.runOnce(new Date("2026-08-24T13:00:00.000Z"));
    expect(cleanupExpired).toHaveBeenCalledOnce();
    release?.({ deletedDrafts: 2, reclaimedBlobs: 2 });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { deletedDrafts: 2, reclaimedBlobs: 2 },
      { deletedDrafts: 2, reclaimedBlobs: 2 },
    ]);
    expect(logger.info).toHaveBeenCalledOnce();
    await worker.stop();
  });
});
