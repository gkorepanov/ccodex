import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const socketPath = process.env.CODEX_HYBRID_SOCKET;
const ready = process.env.FAKE_UNMANAGED_READY;
const gate = process.env.FAKE_UNMANAGED_GATE;
if (!socketPath || !ready || !gate) throw new Error("missing unmanaged handoff configuration");

const webSockets = new WebSocketServer({ noServer: true });
const server = createServer((request, response) => {
  if (request.url === "/readyz") response.writeHead(200).end("ok\n");
  else response.writeHead(404).end();
});
server.on("upgrade", (request, socket, head) => {
  webSockets.handleUpgrade(request, socket, head, (client) => {
    client.on("message", async (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.method !== "initialize") return;
      while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 5));
      client.send(
        JSON.stringify({ id: message.id, result: { userAgent: "codex_app_server_daemon/0.144.6 (unmanaged-test)" } }),
        () => {
          if (process.env.FAKE_UNMANAGED_EXIT_AFTER_PROBE === "1") process.exit(0);
        },
      );
    });
  });
});
server.listen(socketPath, () => writeFileSync(ready, "ready\n", { mode: 0o600 }));

const stop = () => {
  for (const client of webSockets.clients) client.terminate();
  server.close(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
