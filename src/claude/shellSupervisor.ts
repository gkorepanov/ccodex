import { writeSync } from "node:fs";
import { spawn } from "node:child_process";

type ShellSpec = {
  readonly shell: string;
  readonly cwd: string;
  readonly command: string;
};

const spec = JSON.parse(Buffer.from(process.argv[2]!, "base64url").toString()) as ShellSpec;
let terminating = false;
let started = false;
let input = "";

const notify = (message: object) => {
  try {
    writeSync(3, `${JSON.stringify(message)}\n`);
  } catch {
    // The gateway is gone; the process-group kill below remains authoritative.
  }
};
const killGroup = (signal: NodeJS.Signals) => {
  try {
    if (process.platform === "win32") process.kill(process.pid, signal);
    else process.kill(-process.pid, signal);
  } catch {
    if (signal === "SIGKILL") process.exit(1);
  }
};
const terminate = () => {
  if (terminating) return;
  terminating = true;
  killGroup("SIGTERM");
  setTimeout(() => killGroup("SIGKILL"), 100);
};
const start = () => {
  if (started || terminating) return;
  started = true;
  const command = spawn(spec.shell, ["-lc", spec.command], {
    cwd: spec.cwd,
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"],
  });
  command.once("error", (error) => {
    notify({ type: "exit", exitCode: 1, errorMessage: String(error) });
    terminate();
  });
  command.once("exit", (code) => {
    notify({ type: "exit", exitCode: code ?? 1 });
    terminate();
  });
};

process.stdin.resume();
process.stdin.on("data", (bytes: Buffer) => {
  input += bytes.toString();
  const lines = input.split("\n");
  input = lines.pop() ?? "";
  for (const line of lines) {
    if (line === "start") start();
    else terminate();
  }
});
process.stdin.once("end", terminate);
process.stdin.once("close", terminate);
process.on("SIGTERM", terminate);
process.on("SIGINT", terminate);

notify({ type: "ready" });
