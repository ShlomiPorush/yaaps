import type { FastifyBaseLogger } from "fastify";

import type { CleanupResult, DraftStorage } from "../storage/draft-storage.js";
import type { RetentionLeaderLock } from "./leader-lock.js";

export class RetentionCleanupWorker {
  #active: Promise<CleanupResult | null> | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly drafts: Pick<DraftStorage, "cleanupExpired">,
    private readonly intervalSeconds: number,
    private readonly logger: Pick<FastifyBaseLogger, "error" | "info">,
    private readonly leader: Pick<RetentionLeaderLock, "runIfLeader">,
  ) {}

  start(): void {
    if (this.#timer || this.intervalSeconds <= 0) return;
    this.#timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.logger.error({ err: error }, "Retention cleanup failed.");
      });
    }, this.intervalSeconds * 1_000);
    this.#timer.unref();
  }

  async runOnce(now = new Date()): Promise<CleanupResult | null> {
    if (this.#active) return this.#active;
    this.#active = this.#runAsLeader(now);
    try {
      return await this.#active;
    } finally {
      this.#active = null;
    }
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#active?.catch(() => undefined);
  }

  async #runAsLeader(now: Date): Promise<CleanupResult | null> {
    const run = await this.leader.runIfLeader(() =>
      this.drafts.cleanupExpired(now),
    );
    if (!run.led) {
      this.logger.info("Retention cleanup skipped; another instance runs it.");
      return null;
    }
    this.logger.info(run.result, "Retention cleanup completed.");
    return run.result;
  }
}
