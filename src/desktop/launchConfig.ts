import { parse } from "smol-toml";

type JsonObject = Record<string, unknown>;

const CONFIG_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOverride(raw: string): [string, unknown] {
  const separator = raw.indexOf("=");
  if (separator <= 0) throw new Error(`invalid -c override '${raw}'`);
  const key = raw.slice(0, separator).trim();
  const source = raw.slice(separator + 1).trim();
  try {
    return [key, parse(`value = ${source}`).value];
  } catch {
    return [key, source.replace(/^(['"])(.*)\1$/, "$2")];
  }
}

function setPath(target: JsonObject, path: readonly string[], value: unknown): void {
  let current = target;
  for (const part of path.slice(0, -1)) {
    const child = current[part];
    current = object(child) ? child : (current[part] = {}) as JsonObject;
  }
  current[path.at(-1)!] = value;
}

function mergedOverrides(entries: readonly [string, unknown][]): JsonObject {
  const result = new Map<string, unknown>();
  for (const [key, value] of entries) {
    const ancestor = [...result.keys()]
      .filter((candidate) => key.startsWith(`${candidate}.`))
      .sort((left, right) => right.length - left.length)[0];
    if (ancestor) {
      const merged = structuredClone(object(result.get(ancestor)) ? result.get(ancestor)! : {});
      setPath(merged as JsonObject, key.slice(ancestor.length + 1).split("."), value);
      result.set(ancestor, merged);
      continue;
    }
    for (const candidate of result.keys()) {
      if (candidate.startsWith(`${key}.`)) result.delete(candidate);
    }
    result.set(key, value);
  }
  return Object.fromEntries(result);
}

export function applyLaunchConfig(line: string, rawOverrides: readonly string[]): string {
  if (rawOverrides.length === 0) return line;
  let message: JsonObject;
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!object(parsed)) return line;
    message = parsed;
  } catch {
    return line;
  }
  if (typeof message.method !== "string" || !CONFIG_METHODS.has(message.method)) return line;
  const params = object(message.params) ? message.params : {};
  const requestConfig = object(params.config) ? params.config : {};
  params.config = mergedOverrides([
    ...rawOverrides.map(parseOverride),
    ...Object.entries(requestConfig),
  ]);
  message.params = params;
  return JSON.stringify(message);
}
