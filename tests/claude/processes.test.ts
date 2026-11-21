import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { cpuSeconds, killProcesses, sessionProcesses } from "../../src/claude/processes.js";

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
    // macOS ps hides the environment of its protected system binaries, including /bin/sleep.
    const args = ["-e", "setTimeout(() => {}, 30_000)"];
    const command = spawn(process.execPath, args, { env, stdio: "ignore" });
    let detached: number | undefined;
    try {
      // When this launcher exits, the command is reparented outside the session's tree.
      detached = Number(execFileSync(process.execPath, ["-e", `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, ${JSON.stringify(args)}, { detached: true, stdio: "ignore" });
        child.unref();
        console.log(child.pid);
      `], { env, encoding: "utf8" }).trim());
      expect(alive(detached)).toBe(true);
      const found = () => sessionProcesses().filter((entry) => entry.session === session).map((entry) => entry.pid);
      await expect.poll(found).toContain(command.pid);
      expect(found()).not.toContain(detached);

      killProcesses([command.pid!]);
      await expect.poll(() => alive(command.pid!)).toBe(false);
    } finally {
      command.kill("SIGKILL");
      try { if (detached) process.kill(detached, "SIGKILL"); } catch { /* gone */ }
    }
  });
});
