#!/usr/bin/env node
import { delimiter, dirname } from "node:path";
import { classifyInvocation, withProxySocket } from "./args.js";
import { delegate } from "./delegate.js";
import { loadConfig } from "../config.js";
import { Logger } from "../log.js";
import { publishDaemonChildRecord, withGatewayStartupFence } from "../daemon/supervisor.js";
import { publishGatewayOwner } from "../daemon/ownership.js";
import { runDaemonCommand } from "../daemon/daemon.js";
import { loadDaemonSettings } from "../daemon/settings.js";
import { runManagementCommand } from "../management/commands.js";

async function main(): Promise<number> {
  // Desktop may start us with a minimal PATH: keep `npm i -g` binaries (codex, `env node` shebangs) reachable.
  process.env.PATH = `${process.env.PATH ?? ""}${delimiter}${dirname(process.execPath)}`;
  const args = process.argv.slice(2);
  const management = await runManagementCommand(args, loadConfig);
  if (management !== undefined) return management;
  const config = loadConfig();
  const invocation = classifyInvocation(args, config);

  if (invocation.kind === "delegate") return delegate(config.delegateCodex, args);
  if (invocation.kind === "mcpServer") {
    const { runMcpServer } = await import("../mcp/server.js");
    const { packageVersion } = await import("../management/commands.js");
    return runMcpServer(config, packageVersion());
  }
  if (invocation.kind === "daemon") {
    const output = await runDaemonCommand(config, invocation, process.argv[1]!);
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  }
  if (invocation.kind === "proxy") {
    await runDaemonCommand(config, { command: "start", remoteControl: false }, process.argv[1]!);
    return delegate(config.codex, withProxySocket(invocation.proxyArgs, invocation.socketPath));
  }
  if (invocation.kind === "stdioFrontend") {
    const { runStdioFrontend } = await import("../desktop/stdioFrontend.js");
    return runStdioFrontend(config, invocation.socketPath, { configOverrides: invocation.configOverrides });
  }

  const { startGateway } = await import("../gateway/server.js");
  const logger = new Logger(config.logLevel);
  const remoteControl = process.env.CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED !== "1"
    && (invocation.stockArgs.includes("--remote-control") || loadDaemonSettings().remoteControlEnabled);
  const stockArgs = invocation.stockArgs.filter((arg) => arg !== "--remote-control");
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => { stop = resolve; });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let releaseDaemonRecord: () => void = () => undefined;
  let releaseGatewayOwner: () => void = () => undefined;
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    gateway = await withGatewayStartupFence(async () => {
      // The PID handshake identifies the detached child; the daemon separately waits for socket ownership.
      releaseDaemonRecord = await publishDaemonChildRecord();
      return startGateway(config, invocation.socketPath, stockArgs, logger, remoteControl);
    });
    releaseGatewayOwner = publishGatewayOwner(invocation.socketPath);
    await stopped;
  } finally {
    try {
      await gateway?.stop();
    } finally {
      releaseGatewayOwner();
      releaseDaemonRecord();
    }
  }
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    process.stderr.write(`ccodex: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
