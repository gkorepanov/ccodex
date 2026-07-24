#!/usr/bin/env node
import { join } from "node:path";
import { classifyInvocation, withProxySocket } from "./args.js";
import { delegate } from "./delegate.js";
import { loadConfig } from "../config/config.js";
import { Logger } from "../observability/logger.js";
import { publishDaemonChildRecord, withGatewayStartupFence } from "../daemon/supervisor.js";
import { publishGatewayOwner } from "../daemon/ownership.js";
import { runDaemonCommand } from "../daemon/daemon.js";
import { runEarlyManagementCommand, runManagementCommand } from "../management/commands.js";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const earlyManagement = await runEarlyManagementCommand(args);
  if (earlyManagement !== undefined) return earlyManagement;
  const config = loadConfig();
  const logger = new Logger(config.logLevel, {
    includeContent: config.logPrompts,
    ...(config.debugCapture ? { capturePath: join(config.dataDir, "debug.jsonl"), maxBytes: config.debugLogMaxBytes } : {}),
  });
  const management = await runManagementCommand(config, args);
  if (management !== undefined) return management;
  const invocation = classifyInvocation(args, config);

  if (invocation.kind === "delegate") return delegate(config.delegateCodex ?? config.realCodex, args);
  if (invocation.kind === "daemon") {
    const output = await runDaemonCommand(config, invocation, process.argv[1]!);
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return 0;
  }
  if (invocation.kind === "proxy") {
    await runDaemonCommand(config, { command: "start", remoteControl: false }, process.argv[1]!);
    return delegate(
      config.realCodex,
      withProxySocket(invocation.proxyArgs, invocation.socketPath),
    );
  }
  if (invocation.kind === "stdioFrontend") {
    const { runStdioFrontend } = await import("../desktop/stdioFrontend.js");
    return runStdioFrontend(config, invocation.socketPath);
  }

  const { startGateway } = await import("../gateway/server.js");
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  const stop = () => resolveStop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let releaseDaemonRecord: () => void = () => undefined;
  let releaseGatewayOwner: () => void = () => undefined;
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  try {
    gateway = await withGatewayStartupFence(async () => {
      // The PID handshake identifies the detached child, not gateway readiness.
      // Publish it before the potentially slow stock/Claude bootstrap; the
      // daemon independently waits for and verifies public-socket ownership.
      releaseDaemonRecord = await publishDaemonChildRecord();
      return startGateway(
        config,
        invocation.socketPath,
        invocation.stockArgs,
        logger,
      );
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
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`ccodex: ${message}\n`);
    process.exitCode = 1;
  });
