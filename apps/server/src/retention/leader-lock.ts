import path from "node:path";

import BetterSqlite3 from "better-sqlite3";

export type LeaderRun<T> = { led: true; result: T } | { led: false };

function isBusyError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "SQLITE_BUSY"
  );
}

export class RetentionLeaderLock {
  readonly #lock: BetterSqlite3.Database;

  constructor(dataDirectory: string) {
    this.#lock = new BetterSqlite3(
      path.join(dataDirectory, "yaaps-leader.sqlite"),
      { timeout: 0 },
    );
  }

  async runIfLeader<T>(run: () => Promise<T>): Promise<LeaderRun<T>> {
    try {
      this.#lock.exec("begin immediate");
    } catch (error) {
      if (isBusyError(error)) {
        return { led: false };
      }
      throw error;
    }
    try {
      return { led: true, result: await run() };
    } finally {
      this.#lock.exec("rollback");
    }
  }

  close(): void {
    this.#lock.close();
  }
}
