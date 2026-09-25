import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { cpuSeconds, killProcesses, sessionProcesses } from "../../src/claude/processes.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("a Claude session's commands", () => {
  it("reads ps CPU times of Linux and macOS", () => {
    expect(cpuSeconds("00:01:05")).toBe(65);
    expect(cpuSeconds("2-01:00:00")).toBe(2 * 86_400 + 3_600);
    expect(cpuSeconds("0:03.25")).toBeCloseTo(3.25);
  });

  it("finds the commands still in the session's process tree, not one it detached", async () => {
    const session = `test-${process.pid}-${Date.now()}`;
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: String(process.pid) };
    const command = spawn("sleep", ["30"], { env });
    // `nohup … &` from a shell: the command outlives the shell and is reparented away from the tree.
    const detached = Number(spawnSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { env, encoding: "utf8" }).stdout.trim());
    try {
      await sleep(100);
      const found = sessionProcesses().filter((entry) => entry.session === session).map((entry) => entry.pid);
      expect(found).toContain(command.pid);
      expect(found).not.toContain(detached);

      killProcesses([command.pid!]);
      await sleep(200);
      expect(alive(command.pid!)).toBe(false);
    } finally {
      command.kill("SIGKILL");
      try { process.kill(detached, "SIGKILL"); } catch { /* gone */ }
    }
  });
});
