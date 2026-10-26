import { resolve } from "node:path";
import type { Config } from "../config.js";

/** What only prints and exits, no server (help, schemas, Desktop's startup config check): stock answers it. */
function printsAndExits(value: string): boolean {
  return value === "help" || value === "-h" || value === "--help" || value.startsWith("generate-") || value.startsWith("--print-");
}

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
  | { readonly kind: "mcpServer" }
  | { readonly kind: "daemon"; readonly command: DaemonCommand; readonly remoteControl: boolean; readonly ignored: string[] }
  | { readonly kind: "proxy"; readonly socketPath: string; readonly proxyArgs: string[] }
  | {
      readonly kind: "stdioFrontend";
      readonly socketPath: string;
      readonly configOverrides: string[];
      readonly ignored: string[];
    }
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
  // A command CCodex doesn't run itself (help, stock's newer ones) is stock's to answer; its own (start, stop...) run
  // with options it doesn't know ignored, never handed to stock: stock's daemon would take the socket from CCodex's.
  if (!command || printsAndExits(command) || !daemonCommands.has(command as DaemonCommand)) return { kind: "delegate" };
  const options = args.slice(1);
  const remoteControl = command === "bootstrap" && options.includes("--remote-control");
  return { kind: "daemon", command: command as DaemonCommand, remoteControl, ignored: options.filter((option) => !(remoteControl && option === "--remote-control")) };
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

function configOverrides(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value === "-c" || value === "--config") {
      const override = args[index + 1];
      if (override !== undefined) result.push(override);
      index += 1;
    } else if (value.startsWith("--config=")) {
      result.push(value.slice("--config=".length));
    } else if (value.startsWith("-c") && value.length > 2) {
      result.push(value.slice(2));
    }
  }
  return result;
}

function socketPathFromListen(listen: string | undefined, config: Config): string {
  if (!listen || listen === "unix://") return config.publicSocket;
  if (!listen.startsWith("unix://")) {
    throw new Error(`CCodex currently requires a Unix listener, received '${listen}'.`);
  }
  const value = listen.slice("unix://".length);
  return value.startsWith("/") ? value : resolve(value);
}

export function classifyInvocation(args: readonly string[], config: Config): Invocation {
  if (args[0] === "mcp-server") return { kind: "mcpServer" };
  const appServerIndex = args.indexOf("app-server");
  if (appServerIndex < 0) return { kind: "delegate" };

  const prefix = args.slice(0, appServerIndex);
  const appArgs = args.slice(appServerIndex + 1);
  const daemonIndex = appArgs.indexOf("daemon");
  if (daemonIndex >= 0) return daemonInvocation(appArgs.slice(daemonIndex + 1));
  // Desktop (26.1021+) reads its startup requirements with `--print-startup-config` before it starts.
  if (appArgs.some(printsAndExits)) return { kind: "delegate" };

  if (appArgs.includes("proxy")) {
    const configuredSocket = optionValue(appArgs, "--sock");
    const proxyArgs = stripOption(appArgs.filter((value) => value !== "proxy"), "--sock");
    return {
      kind: "proxy",
      socketPath: configuredSocket ? resolve(configuredSocket) : config.publicSocket,
      proxyArgs: [...prefix, "app-server", "proxy", ...proxyArgs],
    };
  }

  const listen = optionValue(appArgs, "--listen");
  // Stock's default listener, spelled out by some clients (Desktop's Browser Use helper).
  if (!listen || listen === "stdio://" || appArgs.includes("--stdio")) {
    return {
      kind: "stdioFrontend",
      socketPath: config.publicSocket,
      configOverrides: configOverrides(args),
      // The gateway runs on: a launch option it doesn't take (stock's newer ones) is only noted.
      ignored: stripOption(stripOption(stripOption(appArgs, "--listen"), "-c"), "--config").filter((value) => value !== "--stdio" && !value.startsWith("-c")),
    };
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
