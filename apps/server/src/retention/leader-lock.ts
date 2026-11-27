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
  readonly #path: string;

  constructor(dataDirectory: string) {
    this.#path = path.join(dataDirectory, "yaaps-leader.sqlite");
  }

  async runIfLeader<T>(run: () => Promise<T>): Promise<LeaderRun<T>> {
    const lock = new BetterSqlite3(this.#path, { timeout: 0 });
    try {
      try {
        lock.exec("begin immediate");
      } catch (error) {
        if (isBusyError(error)) {
          return { led: false };
        }
        throw error;
      }
      return { led: true, result: await run() };
    } finally {
      lock.close();
    }
  }
}
