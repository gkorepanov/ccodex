import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { claudeEnvironment } from "../environment.js";

export interface ShellProcess {
  readonly done: Promise<void>;
  start(): void;
  kill(): void;
}

export interface ShellProcessCallbacks {
  readonly ready: () => void;
  readonly output: (bytes: Buffer) => void;
  readonly terminal: (exitCode: number, errorMessage?: string) => void;
}

export class ShellRunner {
  public launch(
    cwd: string,
    command: string,
    callbacks: ShellProcessCallbacks,
  ): ShellProcess {
    const typescript = import.meta.url.endsWith(".ts");
    const supervisor = fileURLToPath(new URL(`../shellSupervisor.${typescript ? "ts" : "js"}`, import.meta.url));
    const payload = Buffer.from(JSON.stringify({
      shell: process.env.SHELL ?? "/bin/sh",
      cwd,
      command,
    })).toString("base64url");
    const child = spawn(process.execPath, [
      ...(typescript ? ["--import", import.meta.resolve("tsx")] : []),
      supervisor,
      payload,
    ], {
      cwd,
      env: claudeEnvironment(),
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    return new SupervisorProcess(child, callbacks);
  }
}

class SupervisorProcess implements ShellProcess {
  public readonly done: Promise<void>;
  private readonly settle: () => void;
  private terminal: { exitCode: number; errorMessage?: string } | undefined;
  private control = "";
  private closed = false;

  public constructor(
    private readonly child: ChildProcess,
    private readonly callbacks: ShellProcessCallbacks,
  ) {
    let settle!: () => void;
    this.done = new Promise<void>((resolve) => { settle = resolve; });
    this.settle = settle;
    child.stdin?.on("error", () => undefined);
    child.stdout?.on("data", callbacks.output);
    child.stderr?.on("data", callbacks.output);
    child.stdio[3]?.on("data", (bytes: Buffer) => this.acceptControl(bytes));
    child.once("error", (error) => {
      this.terminal = { exitCode: 1, errorMessage: String(error) };
    });
    child.once("close", (code) => this.close(code));
  }

  public start(): void {
    if (!this.closed) this.child.stdin?.write("start\n");
  }

  public kill(): void {
    if (this.closed) return;
    if (this.child.stdin?.writable) {
      this.child.stdin.end("kill\n");
      return;
    }
    this.killGroup();
  }

  private acceptControl(bytes: Buffer): void {
    this.control += bytes.toString();
    const lines = this.control.split("\n");
    this.control = lines.pop() ?? "";
    for (const line of lines) {
      const message = JSON.parse(line) as {
        type?: unknown;
        exitCode?: unknown;
        errorMessage?: unknown;
      };
      if (message.type === "ready") {
        this.callbacks.ready();
      } else if (message.type === "exit" && typeof message.exitCode === "number") {
        this.terminal = {
          exitCode: message.exitCode,
          ...(typeof message.errorMessage === "string" ? { errorMessage: message.errorMessage } : {}),
        };
      }
    }
  }

  private close(code: number | null): void {
    if (this.closed) return;
    this.closed = true;
    if (!this.terminal && this.child.pid) this.killGroup();
    const terminal = this.terminal ?? { exitCode: code ?? 1 };
    this.callbacks.terminal(terminal.exitCode, terminal.errorMessage);
    this.settle();
  }

  private killGroup(): void {
    const pid = this.child.pid;
    if (!pid) return;
    try {
      if (process.platform === "win32") this.child.kill("SIGKILL");
      else process.kill(-pid, "SIGKILL");
    } catch {
      // The supervisor group is already gone.
    }
  }
}
