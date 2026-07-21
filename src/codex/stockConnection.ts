import { createConnection } from "node:net";
import WebSocket from "ws";

export function connectStock(socketPath: string): WebSocket {
  return new WebSocket("ws://codex-app-server/rpc", {
    createConnection: () => createConnection(socketPath),
    perMessageDeflate: false,
    maxPayload: 64 * 1024 * 1024,
  });
}
