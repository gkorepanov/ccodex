import { createConnection } from "node:net";
import WebSocket from "ws";

const PROBE_TIMEOUT_MS = 2_000;

export interface ProbeInfo {
  readonly appServerVersion: string;
}

function parseVersion(userAgent: unknown): string {
  if (typeof userAgent !== "string") throw new Error("app-server initialize response omitted userAgent");
  const slash = userAgent.indexOf("/");
  const version = slash >= 0 ? userAgent.slice(slash + 1).split(/\s/u, 1)[0] : undefined;
  if (!version) throw new Error("app-server user-agent omitted version");
  return version;
}

export function probeAppServer(socketPath: string): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket("ws://codex-app-server/rpc", {
      createConnection: () => createConnection(socketPath),
      perMessageDeflate: false,
      maxPayload: 64 * 1024 * 1024,
    });
    const timer = setTimeout(() => finish(new Error(`timed out probing app-server control socket ${socketPath}`)), PROBE_TIMEOUT_MS);
    const finish = (error?: Error, info?: ProbeInfo) => {
      clearTimeout(timer);
      webSocket.removeAllListeners();
      webSocket.terminate();
      error ? reject(error) : resolve(info!);
    };
    webSocket.once("error", (error) => finish(error));
    webSocket.once("open", () => {
      webSocket.send(JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codex_app_server_daemon", title: "Codex App Server Daemon", version: "0.144.6" },
        },
      }));
    });
    webSocket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as { id?: unknown; result?: { userAgent?: unknown }; error?: { message?: string } };
        if (message.id !== 1) return;
        if (message.error) throw new Error(message.error.message ?? "app-server initialize failed");
        webSocket.send(JSON.stringify({ method: "initialized" }));
        finish(undefined, { appServerVersion: parseVersion(message.result?.userAgent) });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}
