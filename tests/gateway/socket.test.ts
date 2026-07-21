import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { acquireSocketStartupLock, prepareUnixSocket } from "../../src/gateway/socket.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function socketPath(): string {
  const root = mkdtempSync(join(tmpdir(), "gateway-lock-"));
  roots.push(root);
  return join(root, "app-server.sock");
}

describe("app-server startup lock", () => {
  it("serializes concurrent owners", async () => {
    const path = socketPath();
    const releaseFirst = await acquireSocketStartupLock(path);
    let acquired = false;
    const second = acquireSocketStartupLock(path).then((release) => {
      acquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(acquired).toBe(false);
    releaseFirst();
    const releaseSecond = await second;
    expect(acquired).toBe(true);
    releaseSecond();
  });

  it("recovers a stale owner record", async () => {
    const path = socketPath();
    writeFileSync(`${path}.startup.lock`, JSON.stringify({ pid: 2_147_483_647, token: "stale" }));
    const release = await acquireSocketStartupLock(path);
    release();
  });

  it("never unlinks a socket owned by a live gateway", async () => {
    const path = socketPath();
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(path, resolve));
    await expect(prepareUnixSocket(path)).rejects.toThrow("already serving a process");
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
