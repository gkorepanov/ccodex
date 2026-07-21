import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { HybridConfig } from "../config/config.js";
import type { Logger } from "../observability/logger.js";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);

export interface CompatibilityManifest {
  readonly schemaVersion: number;
  readonly productVersion: string;
  readonly node: string;
  readonly codexCli: string;
  readonly codexGitRevision: string;
  readonly claudeAgentSdk: string;
  readonly claudeCode: string;
  readonly protocolFixture: string;
  readonly relayPackages: Readonly<Record<string, string>>;
}

export function compatibilityManifest(): CompatibilityManifest {
  const path = fileURLToPath(new URL("../../compatibility.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as CompatibilityManifest;
}

export async function executableVersion(command: string): Promise<string> {
  const { stdout, stderr } = await execute(command, ["--version"], { timeout: 5_000, maxBuffer: 64 * 1024 });
  return `${stdout}${stderr}`.trim();
}

export function claudeAgentSdkVersion(): string {
  const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
  const manifest = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { version: string };
  return manifest.version;
}

function nodeSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major >= 22 && major < 27 && (major !== 22 || minor >= 13);
}

function exactVersion(output: string, expected: string): boolean {
  return new RegExp(`(^|[^0-9.])${expected.replaceAll(".", "\\.")}([^0-9.]|$)`).test(output);
}

export async function probeHostCompatibility(config: HybridConfig, logger: Logger): Promise<void> {
  const expected = compatibilityManifest();
  if (!nodeSupported(process.versions.node)) {
    throw new Error(`Node.js ${expected.node} is required, found ${process.versions.node}.`);
  }
  const codexVersion = await executableVersion(config.realCodex)
    .catch((error) => { throw new Error(`Pinned Codex version probe failed: ${String(error)}`); });
  const claudeVersion = await executableVersion(config.claudeBinary).catch((error) => {
    logger.warn("compatibility.claude-unavailable", {
      error: String(error),
      repair: "npm i -g @anthropic-ai/claude-code",
    });
    return undefined;
  });
  const sdkVersion = claudeAgentSdkVersion();
  if (!exactVersion(codexVersion, expected.codexCli)) {
    throw new Error(`Unsupported pinned Codex: expected ${expected.codexCli}, found '${codexVersion}'. Reinstall @gkorepanov/ccodex.`);
  }
  if (claudeVersion && !exactVersion(claudeVersion, expected.claudeCode)) {
    throw new Error(`Unsupported bundled Claude: expected ${expected.claudeCode}, found '${claudeVersion}'. Reinstall @gkorepanov/ccodex.`);
  }
  if (sdkVersion !== expected.claudeAgentSdk) {
    throw new Error(`Unsupported Claude Agent SDK: expected ${expected.claudeAgentSdk}, found ${sdkVersion}. Reinstall @gkorepanov/ccodex.`);
  }
  logger.info("compatibility.versions", {
    nodeVersion: process.versions.node,
    codexVersion,
    claudeVersion: claudeVersion ?? "not installed",
    claudeAgentSdkVersion: sdkVersion,
    expected,
  });
}
