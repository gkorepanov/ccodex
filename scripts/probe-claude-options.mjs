import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";

const execFileAsync = promisify(execFile);
const claudeBinary = process.env.CODEX_HYBRID_CLAUDE_BINARY;
if (!claudeBinary) throw new Error("CODEX_HYBRID_CLAUDE_BINARY is required.");

const abort = new AbortController();
const sessionId = randomUUID();
async function* idle() {
  await new Promise((resolve) => abort.signal.addEventListener("abort", resolve, { once: true }));
}

const sdkQuery = query({
  prompt: idle(),
  options: {
    pathToClaudeCodeExecutable: claudeBinary,
    sessionId,
    persistSession: false,
    abortController: abort,
    model: "claude-opus-4-8",
    effort: "xhigh",
    settings: { fastMode: true },
    allowedTools: [],
    env: process.env,
  },
});

try {
  await sdkQuery.initializationResult();
  const { stdout } = await execFileAsync("ps", ["-eo", "args="], { maxBuffer: 4 * 1024 * 1024 });
  const command = stdout.split("\n").find((line) => line.includes(sessionId));
  assert.ok(command, "Claude CLI process for the probe session was not found.");
  assert.match(command, /--model claude-opus-4-8(?:\s|$)/u);
  assert.match(command, /--effort xhigh(?:\s|$)/u);
  assert.match(command, /--settings .*fastMode/u);
  process.stdout.write(`${JSON.stringify({ cliOptions: true, model: "claude-opus-4-8", effort: "xhigh", fastMode: true })}\n`);
} finally {
  abort.abort();
  sdkQuery.close();
}
