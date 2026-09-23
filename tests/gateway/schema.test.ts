// Protocol check without pins: everything the Claude layer puts on the wire must validate against the JSON schema
// of the codex that is installed (CCODEX_SCHEMA_CODEX, default: the dev dependency).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv } from "ajv";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fakeQuery } from "../fixtures/fakeClaude.js";
import { startTestGateway, type Client, type TestGateway } from "./harness.js";

process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "ccodex-claude-schema-"));
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({ ...await importOriginal<object>(), query: fakeQuery }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CODEX = process.env.CCODEX_SCHEMA_CODEX ?? fileURLToPath(new URL("../../node_modules/.bin/codex", import.meta.url));
const text = (value: string) => [{ type: "text", text: value, text_elements: [] }];

let gateway: TestGateway;
let client: Client;
let ajv: Ajv;

function validate(definition: string, value: unknown, context: string): string[] {
  const check = ajv.getSchema(definition === "ServerRequest" ? "server-request" : `v2#/definitions/${definition}`)!;
  return check(value) ? [] : [`${context} ✗ ${definition}: ${ajv.errorsText(check.errors, { separator: "; " }).slice(0, 600)}`];
}

describe("wire objects of Claude threads validate against the installed codex schema", () => {
  beforeAll(async () => {
    const out = mkdtempSync(join(tmpdir(), "ccodex-schema-"));
    execFileSync(CODEX, ["app-server", "generate-json-schema", "--out", out], { stdio: "ignore" });
    ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
    ajv.addSchema(JSON.parse(readFileSync(join(out, "codex_app_server_protocol.v2.schemas.json"), "utf8")), "v2");
    ajv.addSchema(JSON.parse(readFileSync(join(out, "ServerRequest.json"), "utf8")), "server-request");
    gateway = await startTestGateway();
    client = await gateway.connect();
  });
  afterAll(async () => { await gateway?.stop(); });

  it("thread lifecycle, turns, approvals, history, side chat, goals, synthetic turns", async () => {
    const errors: string[] = [];
    const call = async (method: string, params: unknown, definition?: string) => {
      const result = await client.request(method, params);
      if (definition) errors.push(...validate(definition, result, method));
      return result;
    };
    const started = await call("thread/start", { model: "claude:claude-opus-5-5", cwd: "/work" }, "ThreadStartResponse");
    const threadId: string = started.thread.id;
    errors.push(...validate("TurnStartResponse", await client.request("turn/start", { threadId, input: text("hello") }), "turn/start"));
    await client.waitFor("turn/completed", (params) => params.threadId === threadId);
    client.onRequest = () => ({ decision: "accept" });
    await client.turn(threadId, "this needs approval");
    await call("thread/read", { threadId, includeTurns: true }, "ThreadReadResponse");
    await call("thread/resume", { threadId }, "ThreadResumeResponse");
    await call("thread/turns/list", { threadId, limit: 10 }, "ThreadTurnsListResponse");
    await call("thread/items/list", { threadId, limit: 10 }, "ThreadItemsListResponse");
    await call("thread/list", { limit: 20 }, "ThreadListResponse");
    // The fake stock's own rows are minimal; only what CCodex adds is checked.
    for (const model of (await call("model/list", {})).data.filter((entry: any) => entry.id.startsWith("claude:"))) {
      errors.push(...validate("Model", model, `model ${model.id}`));
    }
    for (const skill of (await call("skills/list", { cwds: ["/work"] })).data[0].skills.filter((entry: any) => entry.name.startsWith("claude:"))) {
      errors.push(...validate("SkillMetadata", skill, `skill ${skill.name}`));
    }
    await call("account/rateLimits/read", {}, "GetAccountRateLimitsResponse");
    await call("thread/settings/update", { threadId, effort: "high" });
    await call("thread/goal/set", { threadId, objective: "ship it" }, "ThreadGoalSetResponse");
    await client.waitFor("turn/completed", (params) => params.threadId === threadId && client.notifications("thread/goal/updated").length > 0);
    await call("thread/goal/get", { threadId }, "ThreadGoalGetResponse");
    await client.turn(threadId, "/ccstate");
    const side = await call("thread/fork", { threadId, ephemeral: true, excludeTurns: true }, "ThreadForkResponse");
    await client.turn(side.thread.id, "side question");
    const fork = await call("thread/fork", { threadId, excludeTurns: true }, "ThreadForkResponse");
    await call("thread/name/set", { threadId: fork.thread.id, name: "Forked" }, "ThreadSetNameResponse");
    await call("thread/archive", { threadId: fork.thread.id }, "ThreadArchiveResponse");
    await call("thread/unarchive", { threadId: fork.thread.id }, "ThreadUnarchiveResponse");
    // Provider switch gpt → claude: the synthetic compaction turn and the Claude turn under the stock id.
    const { thread: gpt } = await client.request("thread/start", { model: "gpt-6-luna", cwd: "/work" });
    await client.turn(gpt.id, "first");
    await client.request("turn/start", { threadId: gpt.id, model: "claude:claude-opus-5-5", input: text("second") });
    await client.waitFor("item/completed", (params) => params.threadId === gpt.id && params.item.text === "claude: second");
    await call("thread/read", { threadId: gpt.id, includeTurns: true }, "ThreadReadResponse");
    await call("thread/resume", { threadId: gpt.id }, "ThreadResumeResponse");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const claudeIds = new Set([threadId, side.thread.id, fork.thread.id, gpt.id]);
    const ours = client.messages.filter((message) => message.method !== undefined
      && (claudeIds.has(message.params?.threadId) || claudeIds.has(message.params?.thread?.id)));
    for (const message of ours) {
      const definition = message.id === undefined ? "ServerNotification" : "ServerRequest";
      errors.push(...validate(definition, message.id === undefined ? { method: message.method, params: message.params } : message, message.method));
    }
    expect(ours.length).toBeGreaterThan(20);
    expect(errors).toEqual([]);
  });
});
