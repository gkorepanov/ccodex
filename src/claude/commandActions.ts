import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { relayBinary } from "../gateway/remote.js";
import type { CommandAction } from "../protocol/codex.js";

type ParsedCommand =
  | { type: "read"; cmd: string; name: string; path: string }
  | { type: "list_files"; cmd: string; path: string | null }
  | { type: "search"; cmd: string; query: string | null; path: string | null }
  | { type: "unknown"; cmd: string };

/** Each command's parse, a failed one too (history projects the same commands page after page). */
const cache = new Map<string, readonly ParsedCommand[] | undefined>();
const maxCacheEntries = 16_384;
let binary: string | null | undefined;

function parserBinary(): string | null {
  if (binary !== undefined) return binary;
  try {
    return binary = process.env.CCODEX_COMMAND_PARSER ?? relayBinary();
  } catch {
    return binary = null;
  }
}

function parse(parser: string, commands: readonly string[]): readonly (readonly ParsedCommand[])[] | undefined {
  const result = spawnSync(parser, ["parse-commands"], {
    input: JSON.stringify(commands),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 << 20,
  });
  if (result.error || result.status !== 0) return undefined;
  try {
    const value = JSON.parse(result.stdout) as ParsedCommand[][];
    return Array.isArray(value) && value.length === commands.length ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Parses the commands not parsed yet in one run of the parser (a page of history has hundreds). */
export function parseCommands(commands: readonly string[]): void {
  const parser = parserBinary();
  const fresh = [...new Set(commands)].filter((command) => command && !cache.has(command));
  if (!parser || !fresh.length) return;
  const values = parse(parser, fresh);
  fresh.forEach((command, index) => {
    if (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value!);
    cache.set(command, values?.[index]);
  });
}

function parsed(command: string): readonly ParsedCommand[] | undefined {
  parseCommands([command]);
  return cache.get(command);
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
