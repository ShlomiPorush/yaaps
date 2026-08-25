import type { FastifyBaseLogger } from "fastify";

import type { CleanupResult, DraftStorage } from "../storage/draft-storage.js";

export class RetentionCleanupWorker {
  #active: Promise<CleanupResult> | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly drafts: DraftStorage,
    private readonly intervalSeconds: number,
    private readonly logger: Pick<FastifyBaseLogger, "error" | "info">,
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

  async runOnce(now = new Date()): Promise<CleanupResult> {
    if (this.#active) return this.#active;
    this.#active = this.drafts.cleanupExpired(now);
    try {
      const result = await this.#active;
      this.logger.info(result, "Retention cleanup completed.");
      return result;
    } finally {
      this.#active = null;
    }
  }

  async stop(): Promise<void> {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#active;
  }
}
