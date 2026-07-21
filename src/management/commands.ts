import type { HybridConfig } from "../config/config.js";
import { delegate } from "../cli/delegate.js";
import { printDoctor, runDoctor } from "./doctor.js";
import { setup } from "./setup.js";
import { rollback, uninstall, update } from "./lifecycle.js";

export async function runEarlyManagementCommand(args: readonly string[]): Promise<number | undefined> {
  if (args[0] === "setup") return setup(args.slice(1));
  if (args[0] === "update") return update(args.slice(1));
  if (args[0] === "rollback") return rollback(args.slice(1));
  if (args[0] === "uninstall") return uninstall(args.slice(1));
  return undefined;
}

export async function runManagementCommand(config: HybridConfig, args: readonly string[]): Promise<number | undefined> {
  if (args[0] === "doctor") {
    const unexpected = args.slice(1).filter((arg) => arg !== "--json" && arg !== "--deep");
    if (unexpected.length > 0) throw new Error(`Unexpected doctor options: ${unexpected.join(" ")}`);
    return printDoctor(await runDoctor(config, args.includes("--deep")), args.includes("--json"));
  }
  if (args[0] === "auth" && args[1] === "codex" && args.length === 2) {
    return delegate(config.realCodex, ["login"]);
  }
  if (args[0] === "auth" && args[1] === "claude" && args.length === 2) {
    return delegate(config.claudeBinary, ["auth", "login"]);
  }
  if (args[0] === "auth") throw new Error("Usage: ccodex auth codex|claude");
  return undefined;
}
