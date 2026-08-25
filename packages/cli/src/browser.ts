import { spawn } from "node:child_process";

type SpawnImplementation = typeof spawn;

export async function openExternalUrl(
  value: string,
  platform = process.platform,
  spawnImplementation: SpawnImplementation = spawn,
): Promise<void> {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTTP and HTTPS verification URLs can be opened.");
  }

  const invocation =
    platform === "win32"
      ? { arguments: [url.href], executable: "explorer.exe" }
      : platform === "darwin"
        ? { arguments: [url.href], executable: "open" }
        : platform === "linux"
          ? { arguments: [url.href], executable: "xdg-open" }
          : undefined;
  if (!invocation) {
    throw new Error(`Opening a browser is not supported on ${platform}.`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawnImplementation(
      invocation.executable,
      invocation.arguments,
      {
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
