import { writeFileSync } from "node:fs";
import { createServer } from "node:net";

const socketPath = process.env.FAKE_UNRELATED_SOCKET;
const ready = process.env.FAKE_UNRELATED_READY;
if (!socketPath || !ready) throw new Error("missing unrelated socket configuration");

const server = createServer((socket) => {
  socket.on("error", () => undefined);
  socket.end("not an app server\n");
});
server.listen(socketPath, () => writeFileSync(ready, "ready\n", { mode: 0o600 }));
const stop = () => server.close(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
