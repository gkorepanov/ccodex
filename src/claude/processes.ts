/**
 * The processes a Claude session's commands run. Claude starts every command (its Bash tool, a background task) with
 * the session's id and its own pid in the environment (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`); a command still in
 * the session's process tree ends with it, one it detached (`nohup … &`) lives on and is none of ours.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

export interface SessionProcess {
  readonly pid: number;
  readonly session: string;
  /** CPU seconds used so far. */
  readonly cpu: number;
}

interface Sample {
  readonly pid: number;
  readonly ppid: number;
  readonly cpu: number;
  readonly environment: string;
}

const CLOCK_TICKS = 100;

/** Linux: /proc (CPU in clock ticks); elsewhere `ps` with the environment after the command (CPU in centiseconds). */
function samples(): Sample[] {
  try {
    return readdirSync("/proc").filter((name) => /^\d+$/u.test(name)).flatMap((name) => {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        let environment = "";
        try { environment = readFileSync(`/proc/${name}/environ`, "utf8"); } catch { /* another user's */ }
        return [{ pid: Number(name), ppid: Number(fields[1]), cpu: (Number(fields[11]) + Number(fields[12])) / CLOCK_TICKS, environment }];
      } catch {
        return [];
      }
    });
  } catch {
    return execFileSync("ps", ["axeww", "-o", "pid=,ppid=,time=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\n").flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s(.*)$/u.exec(line);
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), cpu: cpuSeconds(match[3]!), environment: match[4]! }] : [];
      });
  }
}

/** `[DD-]HH:MM:SS` or `M:SS.ss`. */
export function cpuSeconds(time: string): number {
  const [days, clock] = time.includes("-") ? time.split("-") : ["0", time];
  return Number(days) * 86_400 + clock!.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

/** The commands Claude sessions still run in their process trees, by session. */
export function sessionProcesses(): SessionProcess[] {
  const all = samples();
  const parents = new Map(all.map((sample) => [sample.pid, sample.ppid]));
  const inTree = (pid: number, root: number) => {
    for (let current = parents.get(pid); current !== undefined && current > 1; current = parents.get(current)) {
      if (current === root) return true;
    }
    return false;
  };
  return all.flatMap((sample) => {
    const session = /(?:^|[\0 ])CLAUDE_CODE_SESSION_ID=([^\0 ]+)/u.exec(sample.environment)?.[1];
    const claude = Number(/(?:^|[\0 ])CLAUDE_PID=(\d+)/u.exec(sample.environment)?.[1]);
    return session && claude && inTree(sample.pid, claude) ? [{ pid: sample.pid, session, cpu: sample.cpu }] : [];
  });
}

/** SIGTERM now, SIGKILL whatever is left a moment later. */
export function killProcesses(pids: readonly number[]): void {
  const signal = (name: NodeJS.Signals) => {
    for (const pid of pids) {
      try { process.kill(pid, name); } catch { /* gone */ }
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 5_000).unref();
}
