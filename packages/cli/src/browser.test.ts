import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { openExternalUrl } from "./browser.js";

describe("default browser opening", () => {
  it.each([
    ["win32", "explorer.exe"],
    ["darwin", "open"],
    ["linux", "xdg-open"],
  ] as const)(
    "opens safely on %s without a shell",
    async (platform, executable) => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      const spawnImplementation = vi.fn(() => {
        queueMicrotask(() => child.emit("spawn"));
        return child;
      });

      await openExternalUrl(
        "https://share.example/dashboard/connect/approve?code=ABCD-EFGH&x=$HOME",
        platform,
        spawnImplementation as never,
      );

      expect(spawnImplementation).toHaveBeenCalledWith(
        executable,
        [
          "https://share.example/dashboard/connect/approve?code=ABCD-EFGH&x=$HOME",
        ],
        expect.objectContaining({ shell: false }),
      );
      expect(child.unref).toHaveBeenCalledOnce();
    },
  );

  it("refuses non-web protocols", async () => {
    await expect(
      openExternalUrl("file:///C:/secret", "win32", vi.fn() as never),
    ).rejects.toThrow("Only HTTP and HTTPS");
  });
});
