import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { WebSocketServer } from "ws";

const pidFile = process.env.CODEX_HYBRID_DAEMON_PID_FILE;
const token = process.env.CODEX_HYBRID_DAEMON_TOKEN;
if (!pidFile || !token) throw new Error("missing daemon child handshake");

const processStartTime = (pid) => {
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return `linux:${stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u)[19]}`;
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8" });
  return `ps:${result.stdout.trim()}`;
};

const reservation = JSON.parse(readFileSync(pidFile, "utf8"));
if (reservation.pid !== 0 || reservation.processStartTime !== `starting:${token}`) {
  throw new Error("lost daemon child reservation");
}
const published = `${pidFile}.${process.pid}.tmp`;
writeFileSync(published, JSON.stringify({
  pid: process.pid,
  processStartTime: processStartTime(process.pid),
  wrapperPath: reservation.wrapperPath,
}), { mode: 0o600 });
renameSync(published, pidFile);
chmodSync(pidFile, 0o600);
delete process.env.CODEX_HYBRID_DAEMON_PID_FILE;
delete process.env.CODEX_HYBRID_DAEMON_TOKEN;

const recordPath = process.env.FAKE_DAEMON_RECORD;
const handoffComplete = `${pidFile}.handoff-complete`;
if (process.env.FAKE_DAEMON_HANDOFF === "1" && !existsSync(handoffComplete)) {
  writeFileSync(handoffComplete, "complete\n", { mode: 0o600 });
  const ready = `${pidFile}.unmanaged-ready`;
  const gate = `${pidFile}.unmanaged-gate`;
  mkdirSync(dirname(process.env.CODEX_HYBRID_SOCKET), { recursive: true, mode: 0o700 });
  const owner = spawn(process.execPath, [new URL("./fakeUnmanagedGateway.mjs", import.meta.url).pathname], {
    detached: true,
    env: { ...process.env, FAKE_UNMANAGED_READY: ready, FAKE_UNMANAGED_GATE: gate },
    stdio: "ignore",
  });
  owner.unref();
  if (recordPath) appendFileSync(recordPath, `${JSON.stringify({ pid: process.pid, handoffPid: owner.pid })}\n`);
  for (let index = 0; index < 200 && !existsSync(ready); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!existsSync(ready)) throw new Error("unmanaged handoff gateway did not become ready");
  rmSync(pidFile, { force: true });
  writeFileSync(gate, "go\n", { mode: 0o600 });
  process.exit(0);
}

const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
if (recordPath) appendFileSync(recordPath, `${JSON.stringify({ pid: process.pid, childPid: sleeper.pid, args: process.argv.slice(2) })}\n`);

const socketPath = process.env.CODEX_HYBRID_SOCKET;
if (!socketPath) throw new Error("missing fake gateway socket");
mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
const serving = await new Promise((resolve) => {
  const socket = createConnection(socketPath);
  const finish = (connected) => {
    socket.removeAllListeners();
    socket.destroy();
    resolve(connected);
  };
  socket.setTimeout(100);
  socket.once("connect", () => finish(true));
  socket.once("timeout", () => finish(false));
  socket.once("error", () => finish(false));
});
if (serving) throw new Error(`socket ${socketPath} is already serving`);
rmSync(socketPath, { force: true });
const webSockets = new WebSocketServer({ noServer: true });
const server = createServer((request, response) => {
  if (request.url === "/readyz") response.writeHead(200).end("ok\n");
  else response.writeHead(404).end();
});
server.on("upgrade", (request, socket, head) => {
  webSockets.handleUpgrade(request, socket, head, (client) => {
    client.on("message", (bytes) => {
      const message = JSON.parse(bytes.toString());
      if (message.method === "initialize") {
        client.send(JSON.stringify({ id: message.id, result: { userAgent: "codex_app_server_daemon/0.144.6 (test)" } }));
      }
    });
  });
});
server.listen(socketPath);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  for (const client of webSockets.clients) client.terminate();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
