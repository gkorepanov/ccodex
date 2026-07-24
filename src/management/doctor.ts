import { constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { access } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import type { HybridConfig } from "../config/config.js";
import {
  claudeAgentSdkVersion, compatibilityManifest, executableVersion,
} from "../compatibility/probe.js";
import { relayBinary } from "../gateway/remoteRelay.js";
import { runtimePlatformKey } from "../runtime/dependencies.js";
import { probeAppServer } from "../daemon/probe.js";
import { reconcileManagedProcess } from "../daemon/supervisor.js";
import {
  getCodexCliPathEnv,
  launchAgentLoaded,
  managedCliPath,
} from "../desktop/launchAgent.js";
import { installLayout } from "./layout.js";
import { readInstallManifest } from "./setup.js";
import {
  probeClaudeAvailability, probeCodexAvailability, type ProviderAvailability,
} from "../runtime/providerAvailability.js";

const execute = promisify(execFile);

type CheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detected: string;
  readonly expected: string;
  readonly repair?: string;
}

function check(id: string, valid: boolean, detected: string, expected: string, repair?: string): DoctorCheck {
  return { id, status: valid ? "ok" : "error", detected, expected, ...(!valid && repair ? { repair } : {}) };
}

function availabilityCheck(id: string, availability: ProviderAvailability): DoctorCheck {
  return availability.state === "ready"
    ? { id, status: "ok", detected: availability.detail ?? "authenticated", expected: "authenticated" }
    : {
        id,
        status: "warning",
        detected: availability.detail ?? availability.state,
        expected: "authenticated",
        ...(availability.action ? { repair: availability.action } : {}),
      };
}

function hasVersion(output: string, expected: string): boolean {
  return new RegExp(`(^|[^0-9.])${expected.replaceAll(".", "\\.")}([^0-9.]|$)`).test(output);
}

async function output(command: string, args: readonly string[]): Promise<string> {
  const result = await execute(command, args, { timeout: 10_000, maxBuffer: 128 * 1024 });
  return `${result.stdout}${result.stderr}`.trim();
}

async function authChecks(config: HybridConfig): Promise<DoctorCheck[]> {
  const [codex, claude] = await Promise.all([
    probeCodexAvailability(config.realCodex),
    probeClaudeAvailability(config.claudeBinary),
  ]);
  return [
    availabilityCheck("codex-auth", codex),
    availabilityCheck("claude-auth", claude),
  ];
}

async function modelCatalog(socketPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket("ws://ccodex/rpc", {
      createConnection: () => createConnection(socketPath),
      perMessageDeflate: false,
      maxPayload: 64 * 1024 * 1024,
    });
    const timer = setTimeout(() => finish(new Error("timed out reading merged model catalog")), 10_000);
    const finish = (error?: Error, models?: string[]) => {
      clearTimeout(timer);
      webSocket.removeAllListeners();
      webSocket.terminate();
      error ? reject(error) : resolve(models!);
    };
    webSocket.once("error", (error) => finish(error));
    webSocket.once("open", () => webSocket.send(JSON.stringify({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "ccodex_doctor", title: "CCodex Doctor", version: compatibilityManifest().productVersion } },
    })));
    webSocket.on("message", (bytes) => {
      try {
        const message = JSON.parse(bytes.toString()) as {
          id?: number;
          result?: { data?: Array<{ id?: unknown }> };
          error?: { message?: string };
        };
        if (message.error) throw new Error(message.error.message ?? "app-server RPC failed");
        if (message.id === 1) {
          webSocket.send(JSON.stringify({ method: "initialized", params: {} }));
          webSocket.send(JSON.stringify({ id: 2, method: "model/list", params: { limit: 100 } }));
        } else if (message.id === 2) {
          finish(undefined, (message.result?.data ?? []).map((entry) => entry.id).filter((id): id is string => typeof id === "string"));
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stdioModelCatalog(nodeExecutable: string, cliPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeExecutable, [cliPath, "app-server", "--analytics-default-enabled"], {
      env: { ...process.env, CCODEX_SHIM_ACTIVE: undefined },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const reader = createInterface({ input: child.stdout });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`timed out reading stdio model catalog: ${stderr}`)), 10_000);
    const finish = (error?: Error, models?: string[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader.close();
      child.kill();
      error ? reject(error) : resolve(models!);
    };
    child.stderr.on("data", (bytes: Buffer) => { stderr = `${stderr}${bytes.toString()}`.slice(-8_192); });
    child.once("error", finish);
    child.once("exit", (code, signal) => {
      if (!settled) finish(new Error(`stdio frontend exited before model/list (${signal ?? code}): ${stderr}`));
    });
    reader.on("line", (line) => {
      try {
        const message = JSON.parse(line) as {
          id?: number;
          result?: { data?: Array<{ id?: unknown }> };
          error?: { message?: string };
        };
        if (message.error) throw new Error(message.error.message ?? "stdio app-server RPC failed");
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: "model/list", params: { limit: 100 } })}\n`);
        } else if (message.id === 2) {
          finish(undefined, (message.result?.data ?? [])
            .map((entry) => entry.id)
            .filter((id): id is string => typeof id === "string"));
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "ccodex_doctor_stdio",
          title: "CCodex Doctor stdio",
          version: compatibilityManifest().productVersion,
        },
      },
    })}\n`);
  });
}

async function desktopChecks(config: HybridConfig, layout: ReturnType<typeof installLayout>): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const manifest = readInstallManifest(layout);
  const entry = join(layout.bin, "codex");
  const expectedHash = manifest?.shimHashes.codex;
  const entryOk = existsSync(entry) && expectedHash !== undefined && hashFile(entry) === expectedHash;
  checks.push(check("desktop-entry", entryOk, existsSync(entry) ? entry : "missing", "managed bin/codex", "ccodex setup --repair"));

  const nodeExecutable = manifest?.nodeExecutable;
  try {
    if (!nodeExecutable) throw new Error("not recorded");
    await access(nodeExecutable, constants.X_OK);
    checks.push(check("desktop-node", true, `${nodeExecutable} (${await output(nodeExecutable, ["--version"])})`, "working absolute Node executable"));
  } catch (error) {
    checks.push(check("desktop-node", false, String(error), "working absolute Node executable", "npm install -g @gkorepanov/ccodex && ccodex setup --repair"));
  }

  try {
    const detected = getCodexCliPathEnv();
    checks.push(check("desktop-cli-path", detected === entry, detected ?? "unset", entry, "ccodex setup --repair"));
  } catch (error) {
    checks.push(check("desktop-cli-path", false, String(error), entry, "ccodex setup --repair"));
  }

  const gatewayAgent = manifest?.desktopApp?.gatewayAgent;
  const gatewayAgentOk = Boolean(
    gatewayAgent
    && existsSync(gatewayAgent.path)
    && hashFile(gatewayAgent.path) === gatewayAgent.contentHash,
  );
  checks.push(check(
    "desktop-agent",
    gatewayAgentOk && launchAgentLoaded(),
    gatewayAgentOk ? "installed" : "missing or modified",
    "loaded, byte-identical LaunchAgent",
    "ccodex setup --repair",
  ));

  try {
    if (!nodeExecutable) throw new Error("desktop Node executable is not recorded");
    const models = await stdioModelCatalog(nodeExecutable, managedCliPath(layout));
    const stock = models.filter((id) => id.startsWith("gpt-")).length;
    const claude = models.filter((id) => id.startsWith(config.modelPrefix)).length;
    checks.push(check("desktop-stdio", stock > 0 && claude > 0, `${stock} Codex, ${claude} Claude`, "stdio frontend reaches merged model catalog", "ccodex setup --repair"));
  } catch (error) {
    checks.push(check("desktop-stdio", false, String(error), "stdio frontend reaches merged model catalog", "ccodex setup --repair"));
  }
  return checks;
}

async function deepChecks(config: HybridConfig): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const expected = compatibilityManifest();
  try {
    const info = await probeAppServer(config.publicSocket);
    checks.push(check("daemon-ready", hasVersion(info.appServerVersion, expected.codexCli), info.appServerVersion, expected.codexCli, "codex app-server daemon restart"));
  } catch (error) {
    checks.push(check("daemon-ready", false, String(error), "managed gateway responding", "codex app-server daemon start"));
  }
  try {
    const models = await modelCatalog(config.publicSocket);
    const stock = models.filter((id) => id.startsWith("gpt-")).length;
    const claude = models.filter((id) => id.startsWith(config.modelPrefix)).length;
    checks.push(check("merged-models", stock > 0 && claude > 0, `${stock} Codex, ${claude} Claude`, "both provider catalogs", "codex app-server daemon restart"));
  } catch (error) {
    checks.push(check("merged-models", false, String(error), "both provider catalogs", "codex app-server daemon restart"));
  }

  const layout = installLayout();
  try {
    const { stdout } = await execute(process.env.SHELL ?? "/bin/sh", ["-lc", "command -v codex"], { timeout: 10_000, maxBuffer: 64 * 1024 });
    const detected = stdout.trim().split("\n").at(-1) ?? "";
    checks.push(check("shell-routing", detected === join(layout.bin, "codex"), detected || "not found", join(layout.bin, "codex"), "ccodex setup --repair"));
  } catch (error) {
    checks.push(check("shell-routing", false, String(error), join(layout.bin, "codex"), "ccodex setup --repair"));
  }

  if (process.platform === "darwin") checks.push(...await desktopChecks(config, layout));

  const socketParent = dirname(config.publicSocket);
  const parentMode = existsSync(socketParent) ? statSync(socketParent).mode & 0o777 : 0;
  checks.push(check("socket-dir-mode", parentMode !== 0 && (parentMode & 0o077) === 0, parentMode.toString(8), "0700", `chmod 700 ${socketParent}`));
  const captures = ["rpc.jsonl", "rpc.jsonl.1", "debug.jsonl"].map((name) => join(config.dataDir, name)).filter(existsSync);
  const unsafeCapture = captures.find((path) => (statSync(path).mode & 0o077) !== 0);
  checks.push(check("capture-modes", !unsafeCapture, unsafeCapture ?? `${captures.length} private capture files`, "0600", unsafeCapture ? `chmod 600 ${unsafeCapture}` : undefined));

  const pidFile = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-daemon", "app-server.pid");
  const managed = reconcileManagedProcess(pidFile);
  const manifest = readInstallManifest(layout);
  const launchd = process.platform === "darwin"
    && manifest?.desktopAppActive !== false
    && Boolean(manifest?.desktopApp)
    && launchAgentLoaded();
  const singleOwner = launchd ? !managed : Boolean(managed);
  checks.push(check(
    "managed-process",
    singleOwner,
    launchd && managed ? `launchd + stale pid ${managed.pid}` : launchd ? "launchd" : managed ? `pid ${managed.pid}` : "not managed",
    "one owned gateway process",
    "codex app-server daemon restart",
  ));
  return checks;
}

export async function runDoctor(config: HybridConfig, deep = false): Promise<DoctorCheck[]> {
  const expected = compatibilityManifest();
  const checks: DoctorCheck[] = [];
  const key = runtimePlatformKey();
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  const glibc = report?.header?.glibcVersionRuntime;
  const [glibcMajor = 0, glibcMinor = 0] = glibc?.split(".").map(Number) ?? [];
  const supportedPlatform = /^(darwin-arm64|linux-(arm64|x64)-gnu)$/.test(key) &&
    (process.platform !== "linux" || glibcMajor > 2 || (glibcMajor === 2 && glibcMinor >= 31));
  checks.push(check(
    "platform",
    supportedPlatform,
    glibc ? `${key} (glibc ${glibc})` : key,
    "macOS 11+ arm64 or Linux glibc >=2.31 arm64/x64",
    "Use macOS 11+ or a supported glibc-based Linux host; Alpine/musl is not supported.",
  ));
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  checks.push(check(
    "node",
    major >= 22 && major < 27 && (major !== 22 || minor >= 13),
    process.versions.node,
    expected.node,
    "Install Node.js 22 or 24 LTS.",
  ));
  try {
    const detected = await output("npm", ["--version"]);
    checks.push(check("npm", Number(detected.split(".")[0]) >= 10, detected, ">=10", "Update npm: npm install -g npm@latest"));
  } catch (error) {
    checks.push(check("npm", false, String(error), ">=10", "Install npm with Node.js 22 or 24 LTS."));
  }
  try {
    const binary = relayBinary();
    await access(binary, constants.X_OK);
    checks.push(check("relay", true, binary, "installed executable"));
  } catch (error) {
    checks.push(check("relay", false, String(error), "installed executable", "npm install -g @gkorepanov/ccodex --include=optional"));
  }
  try {
    const detected = await executableVersion(config.realCodex);
    checks.push(check("codex-version", hasVersion(detected, expected.codexCli), detected, expected.codexCli, "npm install -g @gkorepanov/ccodex"));
  } catch (error) {
    checks.push(check("codex-version", false, String(error), expected.codexCli, "npm install -g @gkorepanov/ccodex"));
  }
  if (config.delegateCodex) {
    try {
      checks.push(check("delegated-codex", true, `${await executableVersion(config.delegateCodex)} (${config.delegateCodex})`, "any user-selected Codex CLI"));
    } catch (error) {
      checks.push(check("delegated-codex", false, String(error), "working Codex CLI", "Unset CCODEX_DELEGATE_CODEX or point it at a working Codex."));
    }
  }
  try {
    const detected = await executableVersion(config.claudeBinary);
    checks.push(check("claude-version", hasVersion(detected, expected.claudeCode), detected, expected.claudeCode, "npm install -g @gkorepanov/ccodex --include=optional"));
  } catch (error) {
    checks.push({
      id: "claude-version",
      status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "warning" : "error",
      detected: String(error),
      expected: expected.claudeCode,
      repair: "npm i -g @anthropic-ai/claude-code",
    });
  }
  const sdk = claudeAgentSdkVersion();
  checks.push(check("claude-sdk", sdk === expected.claudeAgentSdk, sdk, expected.claudeAgentSdk, "npm install -g @gkorepanov/ccodex"));

  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const mode = statSync(config.dataDir).mode & 0o777;
  checks.push(check("data-dir-mode", (mode & 0o077) === 0, mode.toString(8), "0700", `chmod 700 ${config.dataDir}`));
  try {
    await access(config.dataDir, constants.W_OK);
    checks.push(check("data-dir-writable", true, config.dataDir, "writable"));
  } catch (error) {
    checks.push(check("data-dir-writable", false, String(error), "writable", `chmod u+w ${config.dataDir}`));
  }
  checks.push(...await authChecks(config));
  if (deep) checks.push(...await deepChecks(config));
  return checks;
}

export function printDoctor(checks: readonly DoctorCheck[], json: boolean): number {
  const ok = checks.every((item) => item.status !== "error");
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok, checks }, null, 2)}\n`);
  } else {
    for (const item of checks) {
      process.stdout.write(`${item.status === "ok" ? "✓" : item.status === "warning" ? "⚠" : "✗"} ${item.id}: ${item.detected}\n`);
      if (item.status !== "ok") process.stdout.write(`  expected: ${item.expected}\n  repair: ${item.repair}\n`);
    }
  }
  return ok ? 0 : 1;
}
