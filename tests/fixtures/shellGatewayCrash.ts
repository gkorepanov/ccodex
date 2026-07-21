import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HybridConfig } from "../../src/config/config.js";
import { ClaudeService } from "../../src/claude/service.js";
import { ShellRunner, type ShellProcess } from "../../src/claude/session/shellRunner.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "./fakeClaudeQuery.js";

const [dataDir, shellPidPath, childPidPath, markerPath, mode] = process.argv.slice(2) as [
  string, string, string, string, string | undefined,
];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const config: HybridConfig = {
  realCodex: "/bin/false",
  claudeBinary: "/bin/false",
  dataDir,
  publicSocket: join(dataDir, "gateway.sock"),
  modelPrefix: "claude:",
  idleTimeoutSeconds: 900,
  modelCacheSeconds: 300,
  logLevel: "error",
  logPrompts: false,
  debugCapture: false,
  debugLogMaxBytes: 1_048_576,
};
let releaseKillBoundary!: () => void;
const killBoundary = new Promise<void>((resolve) => { releaseKillBoundary = resolve; });
class CancelGapShellRunner extends ShellRunner {
  public override launch(...args: Parameters<ShellRunner["launch"]>): ShellProcess {
    const process = super.launch(...args);
    return {
      done: process.done,
      start: () => process.start(),
      kill: releaseKillBoundary,
    };
  }
}
const service = new ClaudeService(
  config,
  new SubscriptionHub(),
  new Logger("error"),
  new SqliteHybridStore(join(dataDir, "state.sqlite")),
  new FakeClaudeQuery().factory,
  undefined,
  undefined,
  undefined,
  undefined,
  mode === "cancel-gap" ? new CancelGapShellRunner() : undefined,
);
const started = await service.startThread({ model: "claude:sonnet", cwd: dataDir });
const shell = service.shellCommand({
  threadId: started.thread.id,
  command: [
    "trap '' TERM",
    `printf '%s' "$$" > ${quote(shellPidPath)}`,
    `sh -c 'trap "" TERM; while :; do sleep 1; done' & printf '%s' "$!" > ${quote(childPidPath)}`,
    `while :; do printf tick >> ${quote(markerPath)}; sleep 0.03; done`,
  ].join("; "),
});
while (!existsSync(shellPidPath) || !existsSync(childPidPath) || !existsSync(markerPath)) {
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
}
if (mode === "cancel-gap") {
  void service.interruptTurn(started.thread.id);
  await killBoundary;
}
process.stdout.write(`${JSON.stringify({
  threadId: started.thread.id,
  ...(mode === "cancel-gap" ? { cancelKillReached: true } : {}),
})}\n`);
await shell;
await service.close();
