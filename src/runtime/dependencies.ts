import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const CLAUDE_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  "darwin-x64": "@anthropic-ai/claude-agent-sdk-darwin-x64",
  "linux-arm64-gnu": "@anthropic-ai/claude-agent-sdk-linux-arm64",
  "linux-arm64-musl": "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
  "linux-x64-gnu": "@anthropic-ai/claude-agent-sdk-linux-x64",
  "linux-x64-musl": "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
};

function linuxLibc(): "gnu" | "musl" {
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime ? "gnu" : "musl";
}

export function runtimePlatformKey(): string {
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  if (process.platform === "linux") return `linux-${process.arch}-${linuxLibc()}`;
  return `${process.platform}-${process.arch}`;
}

export function pinnedCodexExecutable(): string {
  try {
    return require.resolve("@openai/codex/bin/codex.js");
  } catch {
    throw new Error("Pinned @openai/codex@0.144.6 is missing. Reinstall @gkorepanov/ccodex.");
  }
}

export function bundledClaudeExecutable(): string {
  const key = runtimePlatformKey();
  const packageName = CLAUDE_PACKAGES[key];
  if (!packageName) throw new Error(`CCodex does not support Claude on '${key}'.`);
  try {
    const binary = join(dirname(require.resolve(`${packageName}/package.json`)), process.platform === "win32" ? "claude.exe" : "claude");
    if (existsSync(binary)) return binary;
  } catch {
    // A separately installed Claude CLI remains a valid runtime.
  }
  return "claude";
}
