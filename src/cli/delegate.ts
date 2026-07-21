import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function refuseManagedEntrypoint(command: string): void {
  if (!existsSync(command)) return;
  const home = resolve(process.env.CCODEX_HOME ?? join(homedir(), ".ccodex"));
  const own = realpathSync(command);
  const managed = [
    process.argv[1],
    join(home, "bin", "codex"),
    join(home, "bin", "ccodex"),
    join(home, "current", "node_modules", ".bin", "ccodex"),
    join(home, "current", "node_modules", ".bin", "codex-hybrid"),
  ].filter((path): path is string => typeof path === "string" && existsSync(path));
  if (managed.some((path) => realpathSync(path) === own)) {
    throw new Error(`Refusing recursive delegation to managed CCodex entrypoint '${command}'.`);
  }
}

export function delegate(command: string, args: readonly string[]): Promise<number> {
  refuseManagedEntrypoint(command);
  const env = { ...process.env };
  delete env.CCODEX_SHIM_ACTIVE;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
