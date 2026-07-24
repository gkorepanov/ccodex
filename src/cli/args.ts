import { resolve } from "node:path";
import type { HybridConfig } from "../config/config.js";

const delegatedAppServerCommands = new Set([
  "generate-ts",
  "generate-json-schema",
  "help",
]);

export type DaemonCommand =
  | "bootstrap"
  | "start"
  | "restart"
  | "stop"
  | "version"
  | "enable-remote-control"
  | "disable-remote-control";

export type Invocation =
  | { readonly kind: "delegate" }
  | { readonly kind: "daemon"; readonly command: DaemonCommand; readonly remoteControl: boolean }
  | { readonly kind: "proxy"; readonly socketPath: string; readonly proxyArgs: string[] }
  | { readonly kind: "stdioFrontend"; readonly socketPath: string }
  | { readonly kind: "gateway"; readonly socketPath: string; readonly stockArgs: string[] };

const daemonCommands = new Set<DaemonCommand>([
  "bootstrap",
  "start",
  "restart",
  "stop",
  "version",
  "enable-remote-control",
  "disable-remote-control",
]);

function daemonInvocation(args: readonly string[]): Invocation {
  const command = args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    return { kind: "delegate" };
  }
  if (!daemonCommands.has(command as DaemonCommand)) {
    throw new Error(`Unsupported app-server daemon command '${command}'.`);
  }
  const options = args.slice(1);
  const remoteControl = options.includes("--remote-control");
  const unexpected = options.filter((option) => option !== "--remote-control");
  if (unexpected.length > 0 || (command !== "bootstrap" && remoteControl)) {
    throw new Error(`Unexpected options for app-server daemon ${command}: ${options.join(" ")}`);
  }
  return { kind: "daemon", command: command as DaemonCommand, remoteControl };
}

function optionValue(args: readonly string[], name: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === name) return args[index + 1];
    if (value.startsWith(`${name}=`)) return value.slice(name.length + 1);
  }
  return undefined;
}

function stripOption(args: readonly string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === name) {
      index += 1;
      continue;
    }
    if (value.startsWith(`${name}=`)) continue;
    result.push(value);
  }
  return result;
}

function socketPathFromListen(listen: string | undefined, config: HybridConfig): string {
  if (!listen || listen === "unix://") return config.publicSocket;
  if (!listen.startsWith("unix://")) {
    throw new Error(`CCodex currently requires a Unix listener, received '${listen}'.`);
  }
  const value = listen.slice("unix://".length);
  return value.startsWith("/") ? value : resolve(value);
}

export function classifyInvocation(args: readonly string[], config: HybridConfig): Invocation {
  const appServerIndex = args.indexOf("app-server");
  if (appServerIndex < 0) return { kind: "delegate" };

  const prefix = args.slice(0, appServerIndex);
  const appArgs = args.slice(appServerIndex + 1);
  const daemonIndex = appArgs.indexOf("daemon");
  if (daemonIndex >= 0) return daemonInvocation(appArgs.slice(daemonIndex + 1));
  const command = appArgs.find((value) =>
    value === "proxy" || delegatedAppServerCommands.has(value),
  );
  if (command && delegatedAppServerCommands.has(command)) return { kind: "delegate" };

  if (command === "proxy") {
    const configuredSocket = optionValue(appArgs, "--sock");
    const proxyArgs = stripOption(appArgs.filter((value) => value !== "proxy"), "--sock");
    return {
      kind: "proxy",
      socketPath: configuredSocket ? resolve(configuredSocket) : config.publicSocket,
      proxyArgs: [...prefix, "app-server", "proxy", ...proxyArgs],
    };
  }

  const listen = optionValue(appArgs, "--listen");
  if (!listen || appArgs.includes("--stdio")) {
    return { kind: "stdioFrontend", socketPath: config.publicSocket };
  }
  const socketPath = socketPathFromListen(listen, config);
  const cleanAppArgs = stripOption(appArgs, "--listen").filter((value) => value !== "--stdio");
  return {
    kind: "gateway",
    socketPath,
    stockArgs: [
      ...prefix,
      "app-server",
      ...cleanAppArgs,
    ],
  };
}

export function withProxySocket(args: readonly string[], socketPath: string): string[] {
  return [...args, "--sock", socketPath];
}
