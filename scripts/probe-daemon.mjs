import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cli = process.env.CODEX_HYBRID_CLI;
const expectedVersion = process.env.CODEX_HYBRID_EXPECT_CODEX_VERSION ?? "0.144.6";
if (!cli) throw new Error("CODEX_HYBRID_CLI is required.");

const invoke = async (...args) => {
  const { stdout } = await execFileAsync(cli, ["app-server", "daemon", ...args], {
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout.trim());
};

const assertVersion = (output) => {
  assert.equal(output.cliVersion, expectedVersion);
  if ("managedCodexVersion" in output) assert.equal(output.managedCodexVersion, expectedVersion);
  if ("appServerVersion" in output) assert.equal(output.appServerVersion, expectedVersion);
  assert.match(output.socketPath, /\.sock$/u);
};

try {
  assert.equal((await invoke("stop")).status, "notRunning");

  const started = await invoke("start");
  assert.equal(started.status, "started");
  assert.equal(started.backend, "pid");
  assert.ok(Number.isInteger(started.pid));
  assertVersion(started);

  const alreadyRunning = await invoke("start");
  assert.equal(alreadyRunning.status, "alreadyRunning");
  assertVersion(alreadyRunning);

  const version = await invoke("version");
  assert.equal(version.status, "running");
  assertVersion(version);

  const enabled = await invoke("enable-remote-control");
  assert.deepEqual([enabled.status, enabled.remoteControlEnabled], ["enabled", true]);
  assertVersion(enabled);

  const alreadyEnabled = await invoke("enable-remote-control");
  assert.deepEqual([alreadyEnabled.status, alreadyEnabled.remoteControlEnabled], ["alreadyEnabled", true]);
  assertVersion(alreadyEnabled);

  const disabled = await invoke("disable-remote-control");
  assert.deepEqual([disabled.status, disabled.remoteControlEnabled], ["disabled", false]);
  assertVersion(disabled);

  const restarted = await invoke("restart");
  assert.equal(restarted.status, "restarted");
  assertVersion(restarted);

  assert.equal((await invoke("stop")).status, "stopped");
  assert.equal((await invoke("stop")).status, "notRunning");

  const bootstrapped = await invoke("bootstrap", "--remote-control");
  assert.deepEqual(
    [bootstrapped.status, bootstrapped.backend, bootstrapped.autoUpdateEnabled, bootstrapped.remoteControlEnabled],
    ["bootstrapped", "pid", false, true],
  );
  assertVersion(bootstrapped);

  process.stdout.write(`${JSON.stringify({ daemonLifecycle: true, version: expectedVersion }, null, 2)}\n`);
} finally {
  await invoke("stop").catch(() => undefined);
}
