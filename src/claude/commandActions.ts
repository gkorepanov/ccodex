import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { ThreadItem } from "../codex/generated/v2/ThreadItem.js";
import { relayBinary } from "../gateway/remoteRelay.js";

type CommandAction = Extract<ThreadItem, { type: "commandExecution" }>["commandActions"][number];

type ParsedCommand =
  | { type: "read"; cmd: string; name: string; path: string }
  | { type: "list_files"; cmd: string; path: string | null }
  | { type: "search"; cmd: string; query: string | null; path: string | null }
  | { type: "unknown"; cmd: string };

const cache = new Map<string, readonly ParsedCommand[]>();
const maxCacheEntries = 512;

function parsed(command: string): readonly ParsedCommand[] | undefined {
  let binary: string;
  try {
    binary = process.env.CCODEX_COMMAND_PARSER ?? relayBinary();
  } catch {
    return undefined;
  }
  const key = `${binary}\0${command}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const result = spawnSync(binary, ["parse-command"], {
    input: command,
    encoding: "utf8",
    timeout: 2_000,
    maxBuffer: 1_048_576,
  });
  if (result.error || result.status !== 0) return undefined;
  try {
    const value = JSON.parse(result.stdout) as ParsedCommand[];
    if (!Array.isArray(value)) return undefined;
    if (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value!);
    cache.set(key, value);
    return value;
  } catch {
    return undefined;
  }
}

export function bashCommandActions(command: string, cwd: string): CommandAction[] {
  if (!command) return [];
  const actions = parsed(command);
  if (!actions) return [{ type: "unknown", command }];
  return actions.map((action): CommandAction => {
    if (action.type === "read") {
      const path = isAbsolute(action.path) ? action.path : resolve(cwd, action.path);
      return { type: "read", command: action.cmd, name: action.name, path };
    }
    if (action.type === "list_files") return { type: "listFiles", command: action.cmd, path: action.path };
    if (action.type === "search") return { type: "search", command: action.cmd, query: action.query, path: action.path };
    return { type: "unknown", command: action.cmd };
  });
}
