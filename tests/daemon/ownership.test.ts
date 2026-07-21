import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gatewayOwnerFile,
  identifySocketOwner,
  publishGatewayOwner,
  reconcileOwnedGateway,
  socketOwnerPids,
  type SocketOwnershipRuntime,
  stopSocketOwner,
} from "../../src/daemon/ownership.js";
import type { PidRecord } from "../../src/daemon/supervisor.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("gateway socket ownership", () => {
  it("publishes and compare-deletes ownership for the exact Unix socket process", async () => {
    const root = mkdtempSync(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "gateway-owner-"));
    temporary.push(root);
    const socketPath = join(root, "gateway.sock");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const connected = new Promise<void>((resolve) => server.once("connection", () => resolve()));
    const client = spawn(process.execPath, [
      "-e",
      "require('node:net').createConnection(process.argv[1]); setInterval(() => {}, 1000)",
      socketPath,
    ], { stdio: "ignore" });
    await connected;
    try {
      // A relay/proxy client connected to the same Unix socket is not the
      // listener owner and must never become a takeover signal target.
      expect(socketOwnerPids(socketPath)).toEqual([process.pid]);
      const release = publishGatewayOwner(socketPath);
      expect(reconcileOwnedGateway(socketPath)).toMatchObject({ pid: process.pid });
      release();
      expect(existsSync(gatewayOwnerFile(socketPath))).toBe(false);
    } finally {
      client.kill("SIGTERM");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("treats an owner exit during identification as a vacant endpoint", () => {
    const runtime: SocketOwnershipRuntime = {
      ownerPids: (() => {
        const observations = [[41], []];
        return () => observations.shift() ?? [];
      })(),
      processStartTime: () => undefined,
      processMatches: () => false,
      signal: () => undefined,
      now: () => 0,
      sleep: async () => undefined,
    };

    expect(identifySocketOwner("/test/socket", undefined, runtime)).toBeUndefined();
  });

  it("fails closed when an observed owner is replaced or multiplied", () => {
    const expected: PidRecord = { pid: 41, processStartTime: "start:41" };
    const runtime = (owners: number[]): SocketOwnershipRuntime => ({
      ownerPids: () => owners,
      processStartTime: (pid) => `start:${pid}`,
      processMatches: () => true,
      signal: () => undefined,
      now: () => 0,
      sleep: async () => undefined,
    });

    expect(() => identifySocketOwner("/test/socket", expected, runtime([42])))
      .toThrow("socket owner changed from 41 to 42");
    expect(() => identifySocketOwner("/test/socket", expected, runtime([41, 42])))
      .toThrow("expected one owner");
    expect(() => identifySocketOwner("/test/socket", expected, {
      ...runtime([41]),
      processStartTime: () => "reused:41",
    })).toThrow("owner 41 changed identity");
  });

  it("accepts an exact owner exit at the signal boundary without signaling a replacement", async () => {
    const expected: PidRecord = { pid: 41, processStartTime: "start:41" };
    const signaled: number[] = [];
    const observations = [[41], []];
    const runtime: SocketOwnershipRuntime = {
      ownerPids: () => observations.shift() ?? [],
      processStartTime: () => expected.processStartTime,
      processMatches: () => true,
      signal: (pid) => {
        signaled.push(pid);
        const error = new Error("already exited") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      },
      now: () => 0,
      sleep: async () => undefined,
    };

    await expect(stopSocketOwner("/test/socket", expected, runtime)).resolves.toBeUndefined();
    expect(signaled).toEqual([expected.pid]);
  });

  it("never signals when the expected owner has already released the endpoint", async () => {
    const expected: PidRecord = { pid: 41, processStartTime: "start:41" };
    const signaled: number[] = [];
    const runtime: SocketOwnershipRuntime = {
      ownerPids: () => [],
      processStartTime: () => expected.processStartTime,
      processMatches: () => true,
      signal: (pid) => {
        signaled.push(pid);
      },
      now: () => 0,
      sleep: async () => undefined,
    };

    await expect(stopSocketOwner("/test/socket", expected, runtime)).resolves.toBeUndefined();
    expect(signaled).toEqual([]);
  });

  it("fails closed without signaling when another owner appears before stop", async () => {
    const expected: PidRecord = { pid: 41, processStartTime: "start:41" };
    const signaled: number[] = [];
    const runtime: SocketOwnershipRuntime = {
      ownerPids: () => [42],
      processStartTime: () => expected.processStartTime,
      processMatches: () => true,
      signal: (pid) => {
        signaled.push(pid);
      },
      now: () => 0,
      sleep: async () => undefined,
    };

    await expect(stopSocketOwner("/test/socket", expected, runtime)).rejects.toThrow("socket owner changed");
    expect(signaled).toEqual([]);
  });
});
