import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HybridConfig } from "../../src/config/config.js";
import { ClaudeService } from "../../src/claude/service.js";
import type { TranscriptBrancher } from "../../src/claude/transcriptBrancher.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";

const directories: string[] = [];
const originalShell = process.env.SHELL;
const immediateCompactionBoundary: TranscriptBrancher = {
  forkWithProvenance: async () => { throw new Error("unused transcript fork"); },
  resolveCompactionBoundary: async (_sessionId, _cwd, boundary) => boundary.uuid,
  delete: async () => undefined,
};

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false",
    claudeBinary: "/bin/false",
    dataDir,
    publicSocket: join(dataDir, "gateway.sock"),
    modelPrefix: "claude:",
    idleTimeoutSeconds: 900,
    modelCacheSeconds: 300,
    logLevel: "error",
    logPrompts: false,
    debugCapture: false,
    debugLogMaxBytes: 1_048_576,
  };
}

function directory(name: string): string {
  const value = mkdtempSync(join(tmpdir(), `ccodex-${name}-`));
  directories.push(value);
  return value;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnSupervisor(cwd: string, command: string): ReturnType<typeof spawnProcess> {
  const supervisor = fileURLToPath(new URL("../../src/claude/shellSupervisor.ts", import.meta.url));
  const payload = Buffer.from(JSON.stringify({
    shell: process.env.SHELL ?? "/bin/sh",
    cwd,
    command,
  })).toString("base64url");
  return spawnProcess(process.execPath, [
    "--import",
    import.meta.resolve("tsx"),
    supervisor,
    payload,
  ], {
    cwd,
    detached: true,
    stdio: ["pipe", "ignore", "ignore", "pipe"],
  });
}

async function waitForSupervisorReady(supervisor: ReturnType<typeof spawnProcess>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let control = "";
    const timeout = setTimeout(() => reject(new Error("Shell supervisor did not become ready.")), 2_000);
    supervisor.stdio[3]?.on("data", (bytes: Buffer) => {
      control += bytes.toString();
      if (!control.split("\n").some((line) => line.includes('"type":"ready"'))) return;
      clearTimeout(timeout);
      resolve();
    });
    supervisor.once("error", reject);
    supervisor.once("exit", (code) => reject(new Error(`Shell supervisor exited before ready (${code}).`)));
  });
}

async function waitForProcessClose(child: ReturnType<typeof spawnProcess>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

afterEach(() => {
  if (originalShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = originalShell;
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Claude session shell/error ownership", () => {
  it.each(["kill", "eof"] as const)(
    "does not spawn a command when the supervisor receives %s before start",
    async (control) => {
      const root = directory(`supervisor-prestart-${control}`);
      const marker = join(root, "must-not-exist");
      const supervisor = spawnSupervisor(root, `printf side-effect > '${marker}'`);
      try {
        await waitForSupervisorReady(supervisor);
        expect(existsSync(marker)).toBe(false);
        supervisor.stdin?.end(control === "kill" ? "kill\n" : undefined);
        await waitForProcessClose(supervisor);
        expect(existsSync(marker)).toBe(false);
      } finally {
        if (supervisor.pid && processExists(supervisor.pid)) {
          try { process.kill(-supervisor.pid, "SIGKILL"); } catch { /* already gone */ }
        }
      }
    },
  );

  it("starts only after admission and cleans descendants on natural exit", async () => {
    const root = directory("supervisor-start");
    const marker = join(root, "started");
    const childPidPath = join(root, "child.pid");
    const supervisor = spawnSupervisor(
      root,
      `printf started > '${marker}'; sleep 1000 & printf '%s' "$!" > '${childPidPath}'`,
    );
    try {
      await waitForSupervisorReady(supervisor);
      expect(existsSync(marker)).toBe(false);
      supervisor.stdin?.write("start\n");
      await waitForProcessClose(supervisor);
      expect(readFileSync(marker, "utf8")).toBe("started");
      const childPid = Number(readFileSync(childPidPath, "utf8"));
      await waitFor(() => !processExists(childPid), "supervisor natural-exit descendant cleanup");
    } finally {
      if (supervisor.pid && processExists(supervisor.pid)) {
        try { process.kill(-supervisor.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });

  it("persists interleaved stdout and stderr before publishing each delta", async () => {
    const root = directory("shell-stream-order");
    const store = new SqliteHybridStore(join(root, "state.sqlite"));
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(root), hub, new Logger("error"), store, new FakeClaudeQuery().factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: root });
    const deltas: string[] = [];
    hub.subscribe(started.thread.id, "shell-stream", (method, params) => {
      if (method !== "item/commandExecution/outputDelta") return;
      const delta = (params as { delta: string }).delta;
      const persisted = store.listTurns(started.thread.id).at(-1)?.items[0];
      expect(persisted).toMatchObject({
        type: "commandExecution",
        aggregatedOutput: expect.stringContaining(delta),
      });
      deltas.push(delta);
    });

    await service.shellCommand({
      threadId: started.thread.id,
      command: "printf 'out-1\\n'; sleep 0.03; printf 'err-1\\n' >&2; sleep 0.03; printf 'out-2\\n'",
    });

    expect(deltas).toEqual(["out-1\n", "err-1\n", "out-2\n"]);
    expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({
      status: "completed",
      items: [{
        type: "commandExecution",
        source: "userShell",
        aggregatedOutput: "out-1\nerr-1\nout-2\n",
        exitCode: 0,
        status: "completed",
      }],
    });
    await service.close();
  });

  it("persists a nonzero exit before publishing failed completion", async () => {
    const root = directory("shell-nonzero");
    const store = new SqliteHybridStore(join(root, "state.sqlite"));
    const hub = new SubscriptionHub();
    const service = new ClaudeService(
      config(root), hub, new Logger("error"), store, new FakeClaudeQuery().factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: root });
    const methods: string[] = [];
    hub.subscribe(started.thread.id, "shell-failure", (method) => {
      if (method === "item/completed" || method === "turn/completed") {
        expect(store.listTurns(started.thread.id).at(-1)).toMatchObject({
          status: "failed",
          error: { message: "Shell command exited with code 7." },
          items: [{ status: "failed", exitCode: 7, aggregatedOutput: "bad\n" }],
        });
      }
      methods.push(method);
    });

    await service.shellCommand({
      threadId: started.thread.id,
      command: "printf 'bad\\n' >&2; exit 7",
    });

    expect(methods.indexOf("item/completed")).toBeLessThan(methods.indexOf("turn/completed"));
    expect(service.readThread(started.thread.id, false).thread.status).toEqual({ type: "idle" });
    await service.close();
  });

  it("turns a shell spawn error into one durable terminal failure", async () => {
    const root = directory("shell-spawn-error");
    process.env.SHELL = join(root, "missing-shell");
    const hub = new SubscriptionHub();
    const methods: string[] = [];
    const service = new ClaudeService(
      config(root), hub, new Logger("error"),
      new SqliteHybridStore(join(root, "state.sqlite")), new FakeClaudeQuery().factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: root });
    hub.subscribe(started.thread.id, "spawn-error", (method) => methods.push(method));

    await service.shellCommand({ threadId: started.thread.id, command: "printf unreachable" })
      .catch(() => undefined);

    expect(service.readThread(started.thread.id, true).thread).toMatchObject({
      status: { type: "idle" },
      turns: [{
        status: "failed",
        error: { message: expect.stringContaining("ENOENT") },
        items: [{ type: "commandExecution", status: "failed", exitCode: 1 }],
      }],
    });
    expect(methods.filter((method) => method === "turn/completed")).toHaveLength(1);
    await service.close();
  });

  it("kills the command process group on gateway SIGKILL and recovers its durable turn", async () => {
    const root = directory("shell-gateway-crash");
    const shellPidPath = join(root, "shell.pid");
    const childPidPath = join(root, "child.pid");
    const markerPath = join(root, "ticks");
    const fixture = fileURLToPath(new URL("../fixtures/shellGatewayCrash.ts", import.meta.url));
    const gateway = spawnProcess(process.execPath, [
      "--import",
      import.meta.resolve("tsx"),
      fixture,
      root,
      shellPidPath,
      childPidPath,
      markerPath,
    ], { cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let shellPid = 0;
    let childPid = 0;
    try {
      const ready = await new Promise<{ threadId: string }>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error("Gateway crash fixture did not become ready.")), 5_000);
        gateway.stdout.on("data", (bytes: Buffer) => {
          output += bytes.toString();
          const line = output.split("\n").find((value) => value.startsWith("{"));
          if (!line) return;
          clearTimeout(timeout);
          resolve(JSON.parse(line) as { threadId: string });
        });
        gateway.once("error", reject);
        gateway.once("exit", (code) => reject(new Error(`Gateway crash fixture exited early (${code}).`)));
      });
      shellPid = Number(readFileSync(shellPidPath, "utf8"));
      childPid = Number(readFileSync(childPidPath, "utf8"));
      expect(processExists(shellPid)).toBe(true);
      expect(processExists(childPid)).toBe(true);
      process.kill(-gateway.pid!, "SIGKILL");
      await new Promise<void>((resolve) => gateway.once("close", () => resolve()));
      await waitFor(
        () => !processExists(shellPid) && !processExists(childPid),
        "supervised shell process group exit",
        3_000,
      );
      const sizeAfterKill = statSync(markerPath).size;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(statSync(markerPath).size).toBe(sizeAfterKill);

      const restarted = new ClaudeService(
        config(root), new SubscriptionHub(), new Logger("error"),
        new SqliteHybridStore(join(root, "state.sqlite")), new FakeClaudeQuery().factory,
      );
      await restarted.ready();
      const recovered = restarted.readThread(ready.threadId, true).thread.turns[0]!;
      expect(recovered).toMatchObject({
        status: "failed",
        items: [{ type: "commandExecution", status: "failed" }],
      });
      const output = (recovered.items[0] as { aggregatedOutput?: string }).aggregatedOutput;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(restarted.readThread(ready.threadId, true).thread.turns[0]?.items[0])
        .toMatchObject({ aggregatedOutput: output });
      await restarted.close();
    } finally {
      if (processExists(gateway.pid!)) {
        try { process.kill(-gateway.pid!, "SIGKILL"); } catch { /* already gone */ }
      }
      if (shellPid && processExists(shellPid)) {
        try { process.kill(shellPid, "SIGKILL"); } catch { /* already gone */ }
      }
      if (childPid && processExists(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });

  it("guardian closes the cancel-before-kill crash gap without durable PID state", async () => {
    const root = directory("shell-cancel-gap");
    const shellPidPath = join(root, "shell.pid");
    const childPidPath = join(root, "child.pid");
    const markerPath = join(root, "ticks");
    const fixture = fileURLToPath(new URL("../fixtures/shellGatewayCrash.ts", import.meta.url));
    const gateway = spawnProcess(process.execPath, [
      "--import",
      import.meta.resolve("tsx"),
      fixture,
      root,
      shellPidPath,
      childPidPath,
      markerPath,
      "cancel-gap",
    ], { cwd: process.cwd(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let shellPid = 0;
    let childPid = 0;
    try {
      const ready = await new Promise<{ threadId: string; cancelKillReached: boolean }>((resolve, reject) => {
        let output = "";
        const timeout = setTimeout(() => reject(new Error("Cancel-gap fixture did not become ready.")), 5_000);
        gateway.stdout.on("data", (bytes: Buffer) => {
          output += bytes.toString();
          const line = output.split("\n").find((value) => value.startsWith("{"));
          if (!line) return;
          clearTimeout(timeout);
          resolve(JSON.parse(line) as { threadId: string; cancelKillReached: boolean });
        });
        gateway.once("error", reject);
        gateway.once("exit", (code) => reject(new Error(`Cancel-gap fixture exited early (${code}).`)));
      });
      expect(ready.cancelKillReached).toBe(true);
      shellPid = Number(readFileSync(shellPidPath, "utf8"));
      childPid = Number(readFileSync(childPidPath, "utf8"));
      expect(processExists(shellPid)).toBe(true);
      expect(processExists(childPid)).toBe(true);
      process.kill(-gateway.pid!, "SIGKILL");
      await new Promise<void>((resolve) => gateway.once("close", () => resolve()));
      await waitFor(
        () => !processExists(shellPid) && !processExists(childPid),
        "cancel-gap guardian cleanup",
        3_000,
      );

      const restarted = new ClaudeService(
        config(root), new SubscriptionHub(), new Logger("error"),
        new SqliteHybridStore(join(root, "state.sqlite")), new FakeClaudeQuery().factory,
      );
      await restarted.ready();
      expect(restarted.readThread(ready.threadId, true).thread.turns[0]).toMatchObject({
        status: "failed",
        items: [{ type: "commandExecution", status: "failed" }],
      });
      await restarted.close();
    } finally {
      if (processExists(gateway.pid!)) {
        try { process.kill(-gateway.pid!, "SIGKILL"); } catch { /* already gone */ }
      }
      if (shellPid && processExists(shellPid)) {
        try { process.kill(shellPid, "SIGKILL"); } catch { /* already gone */ }
      }
      if (childPid && processExists(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });

  it("cleans background descendants after a successful shell exits", async () => {
    const root = directory("shell-background-exit");
    const childPidPath = join(root, "background.pid");
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(root, "state.sqlite")), new FakeClaudeQuery().factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: root });

    await service.shellCommand({
      threadId: started.thread.id,
      command: `sleep 1000 & printf '%s' "$!" > '${childPidPath}'`,
    });

    const childPid = Number(readFileSync(childPidPath, "utf8"));
    await waitFor(() => !processExists(childPid), "background descendant cleanup");
    expect(service.readThread(started.thread.id, true).thread.turns[0]).toMatchObject({
      status: "completed",
      items: [{ type: "commandExecution", status: "completed", exitCode: 0 }],
    });
    await service.close();
  });

  it("rejects normal-turn admission while a shell owns the thread", async () => {
    const root = directory("shell-admission");
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(root, "state.sqlite")), new FakeClaudeQuery().factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: root });
    const shell = service.shellCommand({
      threadId: started.thread.id,
      command: "sleep 0.12; printf shell-done",
    });
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "inProgress",
      "active shell",
    );
    let admitted = false;
    await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "must wait", text_elements: [] }],
    }).then(() => { admitted = true; }, () => undefined);
    await shell;
    expect(admitted).toBe(false);
    await service.close();
  });

  it("rejects shell admission while a normal turn owns the thread", async () => {
    const root = directory("normal-admission");
    const fake = new FakeClaudeQuery({ name: "Bash", input: { command: "printf provider" } });
    const hub = new SubscriptionHub();
    const requests: string[] = [];
    const service = new ClaudeService(
      config(root), hub, new Logger("error"),
      new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({
      model: "claude:sonnet", cwd: root, approvalPolicy: "on-request",
    });
    hub.subscribe(started.thread.id, "admission", () => undefined, (requestId) => requests.push(requestId));
    const normal = await service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "provider approval", text_elements: [] }],
    });
    normal.announce();
    normal.start();
    await waitFor(() => requests.length === 1, "provider approval");
    await expect(service.shellCommand({
      threadId: started.thread.id,
      command: "printf must-not-run",
    })).rejects.toThrow("active Claude turn");
    await service.resolveServerRequest(requests[0]!, { decision: "decline" });
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns.at(-1)?.status !== "inProgress",
      "provider turn terminal",
    );
    expect(service.readThread(started.thread.id, true).thread.turns).toHaveLength(1);
    await service.close();
  });

  it("rejects shell admission while manual compaction owns the thread", async () => {
    const root = directory("compact-shell-admission");
    let releaseBoundary!: () => void;
    const boundary = new Promise<void>((resolve) => { releaseBoundary = resolve; });
    const fake = new FakeClaudeQuery(undefined, undefined, [], true);
    fake.compactBoundaryWait = boundary;
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
      undefined, undefined, immediateCompactionBoundary,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: root });
    await service.compactThread(started.thread.id);
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "inProgress",
      "active compaction",
    );
    let admitted = false;
    await service.shellCommand({
      threadId: started.thread.id,
      command: "printf must-not-run",
    }).then(() => { admitted = true; }, () => undefined);
    releaseBoundary();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status !== "inProgress",
      "compaction terminal",
    );
    expect(admitted).toBe(false);
    expect(service.readThread(started.thread.id, true).thread.turns).toHaveLength(1);
    await service.close();
  });

  it("rejects shell admission while a synthetic status turn owns the thread", async () => {
    const root = directory("status-shell-admission");
    let releaseStatus!: () => void;
    const status = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const fake = new FakeClaudeQuery();
    fake.experimentalUsageWait = status;
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(root, "state.sqlite")), fake.factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: root });
    const prepared = await service.prepareStatusTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "/ccodex-status", text_elements: [] }],
    }, async () => {
      await service.readRateLimitStatus(started.thread.id);
      return "status";
    });
    prepared.announce();
    prepared.start();
    await waitFor(() => fake.experimentalUsageCalls === 1, "active status turn");
    let admitted = false;
    await service.shellCommand({
      threadId: started.thread.id,
      command: "printf must-not-run",
    }).then(() => { admitted = true; }, () => undefined);
    releaseStatus();
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status !== "inProgress",
      "status terminal",
    );
    expect(admitted).toBe(false);
    expect(service.readThread(started.thread.id, true).thread.turns).toHaveLength(1);
    await service.close();
  });

  it("stops an active shell without accepting its late output or close", async () => {
    const root = directory("shell-stop");
    const service = new ClaudeService(
      config(root), new SubscriptionHub(), new Logger("error"),
      new SqliteHybridStore(join(root, "state.sqlite")), new FakeClaudeQuery().factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: root });
    const shell = service.shellCommand({
      threadId: started.thread.id,
      command: "sleep 0.2; printf SHOULD_NOT_APPEAR",
    });
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "inProgress",
      "stoppable shell",
    );
    const turnId = service.readThread(started.thread.id, true).thread.turns[0]!.id;
    await service.interruptTurn({ threadId: started.thread.id, turnId });
    await shell.catch(() => undefined);

    expect(service.readThread(started.thread.id, true).thread).toMatchObject({
      status: { type: "idle" },
      turns: [{
        id: turnId,
        status: "interrupted",
        items: [{ type: "commandExecution", status: "failed" }],
      }],
    });
    expect(service.readThread(started.thread.id, true).thread.turns[0]?.items[0]).toMatchObject({
      type: "commandExecution",
      aggregatedOutput: "",
    });
    await service.close();
  });

  it("keeps the turn active until Stop has drained the shell guardian", async () => {
    const root = directory("shell-stop-fence");
    const hub = new SubscriptionHub();
    const methods: string[] = [];
    const service = new ClaudeService(
      config(root), hub, new Logger("error"),
      new SqliteHybridStore(join(root, "state.sqlite")), new FakeClaudeQuery().factory,
    );
    const started = await service.startThread({ model: "claude:sonnet", cwd: root });
    hub.subscribe(started.thread.id, "shell-stop-fence", (method) => methods.push(method));
    const shell = service.shellCommand({
      threadId: started.thread.id,
      command: "trap '' TERM; sleep 30",
    });
    await waitFor(
      () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "inProgress",
      "active fenced shell",
    );
    const turnId = service.readThread(started.thread.id, true).thread.turns[0]!.id;
    const stopping = Promise.all([
      service.interruptTurn({ threadId: started.thread.id, turnId }),
      service.interruptTurn({ threadId: started.thread.id, turnId }),
    ]);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(methods).not.toContain("turn/completed");
    await expect(service.prepareTurn({
      threadId: started.thread.id,
      input: [{ type: "text", text: "must remain fenced", text_elements: [] }],
    })).rejects.toThrow("active turn");

    await stopping;
    await shell;
    expect(methods.filter((method) => method === "turn/completed")).toHaveLength(1);
    expect(service.readThread(started.thread.id, true).thread.turns[0])
      .toMatchObject({ status: "interrupted" });
    await service.close();
  });

  it.each(["archive", "delete"] as const)(
    "%s kills or fences an active shell before durable removal",
    async (operation) => {
      const root = directory(`shell-${operation}`);
      const hub = new SubscriptionHub();
      const methods: string[] = [];
      const service = new ClaudeService(
        config(root), hub, new Logger("error"),
        new SqliteHybridStore(join(root, "state.sqlite")), new FakeClaudeQuery().factory,
      );
      const started = await service.startThread({ model: "claude:sonnet", cwd: root });
      hub.subscribe(started.thread.id, operation, (method) => methods.push(method));
      const shell = service.shellCommand({
        threadId: started.thread.id,
        command: "sleep 0.25; printf LATE_AFTER_REMOVAL",
      });
      await waitFor(
        () => service.readThread(started.thread.id, true).thread.turns[0]?.status === "inProgress",
        `${operation} shell`,
      );
      const terminal = operation === "archive" ? "thread/archived" : "thread/deleted";
      if (operation === "archive") await service.archiveThread(started.thread.id);
      else await service.deleteThread(started.thread.id);
      await Promise.race([
        shell.catch(() => undefined),
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error(`${operation} left the shell running`)), 100)),
      ]);
      const terminalIndex = methods.lastIndexOf(terminal);
      expect(terminalIndex).toBeGreaterThanOrEqual(0);
      expect(methods.slice(terminalIndex + 1)).toEqual([]);
      if (operation === "archive") {
        expect(service.listThreads({ archived: true, limit: 10 })).toContainEqual(
          expect.objectContaining({ id: started.thread.id }),
        );
        expect(service.readThread(started.thread.id, true).thread.turns[0]?.items[0]).toMatchObject({
          type: "commandExecution",
          aggregatedOutput: "",
        });
      } else {
        expect(service.ownsThread(started.thread.id)).toBe(false);
      }
      await service.close();
    },
  );

  it("persists generic errors before live delivery for active and idle threads", async () => {
    const root = directory("report-error");
    const store = new SqliteHybridStore(join(root, "state.sqlite"));
    const hub = new SubscriptionHub();
    const fake = new FakeClaudeQuery({ name: "Bash", input: { command: "printf provider" } });
    const service = new ClaudeService(config(root), hub, new Logger("error"), store, fake.factory);
    const active = await service.startThread({
      model: "claude:sonnet", cwd: root, approvalPolicy: "on-request",
    });
    let requestId: string | undefined;
    const seen: Array<{ threadId: string; turnId: string }> = [];
    hub.subscribe(active.thread.id, "active-error", (method, params) => {
      if (method !== "error") return;
      const error = params as { threadId: string; turnId: string };
      expect(store.listEventsAfter(error.threadId, 0).at(-1)).toMatchObject({
        method: "error",
        turnId: error.turnId,
        params,
      });
      seen.push(error);
    }, (id) => { requestId = id; });
    const turn = await service.prepareTurn({
      threadId: active.thread.id,
      input: [{ type: "text", text: "active", text_elements: [] }],
    });
    turn.announce();
    turn.start();
    await waitFor(() => requestId !== undefined, "active error turn");
    await service.reportError(active.thread.id, undefined, "active failure", "badRequest");
    expect(seen).toMatchObject([{
      threadId: active.thread.id,
      turnId: turn.response.turn.id,
    }]);
    await service.resolveServerRequest(requestId!, { decision: "decline" });
    await waitFor(
      () => service.readThread(active.thread.id, true).thread.turns[0]?.status !== "inProgress",
      "active error cleanup",
    );

    const idle = await service.startThread({ model: "claude:sonnet", cwd: root });
    hub.subscribe(idle.thread.id, "idle-error", (method, params) => {
      if (method !== "error") return;
      const error = params as { threadId: string; turnId: string };
      expect(store.listEventsAfter(error.threadId, 0).at(-1)).toMatchObject({
        method: "error",
        turnId: error.turnId,
        params,
      });
      seen.push(error);
    });
    await service.reportError(idle.thread.id, undefined, "idle failure", "internalServerError");
    expect(seen[1]).toMatchObject({ threadId: idle.thread.id, turnId: expect.any(String) });
    expect(store.listTurns(idle.thread.id)).toEqual([]);
    await service.close();
  });

  it.each(["archive", "delete"] as const)(
    "%s control overtakes a queued generic error without late publication",
    async (operation) => {
      const root = directory(`report-error-${operation}`);
      const hub = new SubscriptionHub();
      const methods: string[] = [];
      const service = new ClaudeService(
        config(root), hub, new Logger("error"),
        new SqliteHybridStore(join(root, "state.sqlite")), new FakeClaudeQuery().factory,
        undefined, undefined, immediateCompactionBoundary,
        { rename: async () => undefined, delete: async () => undefined },
      );
      const started = await service.startThread({ model: "claude:sonnet", cwd: root });
      hub.subscribe(started.thread.id, `error-${operation}`, (method) => methods.push(method));

      const admin = operation === "archive"
        ? service.archiveThread(started.thread.id)
        : service.deleteThread(started.thread.id);
      const error = service.reportError(
        started.thread.id,
        undefined,
        "must not outlive terminal admin",
        "internalServerError",
      );
      const results = await Promise.allSettled([admin, error]);

      expect(results).toEqual([
        expect.objectContaining({ status: "fulfilled" }),
        expect.objectContaining({ status: "fulfilled" }),
      ]);
      expect(methods).not.toContain("error");
      const terminal = operation === "archive" ? "thread/archived" : "thread/deleted";
      expect(methods.at(-1)).toBe(terminal);
      await service.close();
    },
  );
});
