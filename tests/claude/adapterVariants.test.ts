import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ElicitationRequest, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { adapterSamples as variants } from "../fixtures/protocolSamples.js";
import { ClaudeService } from "../../src/claude/service.js";
import { startTool } from "../../src/claude/toolMapper.js";
import type { HybridConfig } from "../../src/config/config.js";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";
import { Logger } from "../../src/observability/logger.js";
import { SqliteHybridStore } from "../../src/store/sqliteStore.js";
import { FakeClaudeQuery } from "../fixtures/fakeClaudeQuery.js";

const directories: string[] = [];

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false", claudeBinary: "/bin/false", dataDir, publicSocket: join(dataDir, "gateway.sock"),
    modelPrefix: "claude:", idleTimeoutSeconds: 900, modelCacheSeconds: 300, logLevel: "error",
    logPrompts: false, debugCapture: false, debugLogMaxBytes: 1_048_576,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function runInteraction(
  fake: FakeClaudeQuery,
  response: unknown,
  approvalsReviewer: "user" | "auto_review" = "user",
  interactiveQuestions = true,
  ephemeral = false,
): Promise<{
  methods: string[];
  service: ClaudeService;
  threadId: string;
  events: Array<{ method: string; params: unknown }>;
  requests: Array<{ method: string; params: unknown }>;
}> {
  const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-adapter-variant-"));
  directories.push(directory);
  const hub = new SubscriptionHub();
  const service = new ClaudeService(
    {
      ...config(directory),
      features: { statusCommand: true, sideChatPromotion: true, interactiveQuestions },
    },
    hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
  );
  const started = await service.startThread({
    model: "claude:haiku",
    cwd: directory,
    approvalPolicy: "on-request",
    approvalsReviewer,
    ephemeral,
  });
  const methods: string[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const events: Array<{ method: string; params: unknown }> = [];
  let terminal = false;
  const requestSink = (id: string, method: string, params: unknown) => {
    methods.push(method);
    requests.push({ method, params });
    void service.resolveServerRequest(id, response);
  };
  hub.attach("test", () => undefined, requestSink);
  hub.subscribe(started.thread.id, "test", (method, params) => {
    events.push({ method, params });
    if (method === "turn/completed") terminal = true;
  }, requestSink);
  const prepared = await service.prepareTurn({
    threadId: started.thread.id, input: [{ type: "text", text: "fixture interaction", text_elements: [] }],
  });
  prepared.announce();
  prepared.start();
  await new Promise<void>((resolve) => {
    const poll = () => terminal ? resolve() : setTimeout(poll, 5);
    poll();
  });
  return { methods, service, threadId: started.thread.id, events, requests };
}

describe("Claude adapter golden variants", () => {
  it.each(variants.toolMappings)("maps $block.name without privileged-name guessing", ({ block, expected }) => {
    expect(startTool(0, block, "/workspace", "thread").item).toMatchObject(expected);
  });

  it("completes an SDK server tool from its assistant result block before terminal accounting", async () => {
    const session_id = "session";
    const messages = [
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), session_id,
        event: {
          type: "content_block_start", index: 4,
          content_block: { type: "server_tool_use", id: "web-live", name: "web_search", input: { query: "hybrid protocol" } },
        },
      },
      {
        type: "stream_event", parent_tool_use_id: null, uuid: randomUUID(), session_id,
        event: {
          type: "content_block_start", index: 5,
          content_block: {
            type: "web_search_tool_result", tool_use_id: "web-live",
            content: [{ type: "web_search_result", title: "Result", url: "https://example.com" }],
          },
        },
      },
    ] as unknown as SDKMessage[];
    const fake = new FakeClaudeQuery(undefined, undefined, [], false, undefined, undefined, undefined, messages);
    const { service, threadId, events } = await runInteraction(fake, undefined);
    expect(service.readThread(threadId, true).thread.turns[0]?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "webSearch", id: "web-live", query: "hybrid protocol" }),
    ]));
    const completed = events.findIndex((event) =>
      event.method === "item/completed" && (event.params as { item?: { id?: string } }).item?.id === "web-live",
    );
    const usage = events.findIndex((event) => event.method === "thread/tokenUsage/updated");
    expect(completed).toBeGreaterThanOrEqual(0);
    expect(completed).toBeLessThan(usage);
    await service.close();
  });

  it("round-trips AskUserQuestion through the Codex user-input request", async () => {
    const fake = new FakeClaudeQuery({ name: "AskUserQuestion", input: variants.askUser.input });
    const { methods, service } = await runInteraction(fake, variants.askUser.response, "auto_review");
    expect(methods).toEqual([variants.askUser.expectedMethod]);
    expect(fake.permissionResults).toEqual([{
      behavior: "allow",
      updatedInput: { ...variants.askUser.input, answers: variants.askUser.expectedAnswers },
    }]);
    await service.close();
  });

  it("disables Claude structured questions without changing the legacy Auto callback behavior", async () => {
    const fake = new FakeClaudeQuery({ name: "AskUserQuestion", input: variants.askUser.input });
    const { methods, service } = await runInteraction(fake, variants.askUser.response, "auto_review", false);
    expect(methods).toEqual([]);
    expect(fake.permissionResults).toEqual([]);
    expect(fake.inputs[0]?.options.canUseTool).toBeUndefined();
    expect(fake.inputs[0]?.options.disallowedTools).toEqual([
      "SendFeedback",
      "ProposeSkills",
      "AskUserQuestion",
    ]);
    await service.close();
  });

  it.each([
    ["Bash", { command: "curl example.com" }],
    ["Edit", { file_path: "/workspace/a.ts", old_string: "a", new_string: "b" }],
    ["mcp__project__write", { value: "x" }],
  ])("keeps Auto headless when %s reaches the permission callback", async (name, input) => {
    const fake = new FakeClaudeQuery({ name, input });
    fake.permissionDecisionReason = `${name} was not approved by Claude Auto`;
    const { methods, service } = await runInteraction(fake, undefined, "auto_review");
    expect(methods).toEqual([]);
    expect(fake.permissionResults).toEqual([{
      behavior: "deny",
      message: `${name} was not approved by Claude Auto`,
    }]);
    await service.close();
  });

  it("returns a cancelled App question to Claude without leaking an error RPC", async () => {
    const fake = new FakeClaudeQuery({ name: "AskUserQuestion", input: variants.askUser.input });
    const { methods, events, service } = await runInteraction(fake, { cancelled: true }, "auto_review");
    expect(methods).toEqual([variants.askUser.expectedMethod]);
    expect(fake.permissionResults).toEqual([{ behavior: "deny", message: "User cancelled the question." }]);
    expect(events.some((event) => event.method === "error")).toBe(false);
    await service.close();
  });

  it("routes an Auto question from an ephemeral side runtime to that side thread", async () => {
    const fake = new FakeClaudeQuery({ name: "AskUserQuestion", input: variants.askUser.input });
    const { requests, service, threadId } = await runInteraction(
      fake, variants.askUser.response, "auto_review", true, true,
    );
    expect(requests).toEqual([expect.objectContaining({
      method: variants.askUser.expectedMethod,
      params: expect.objectContaining({ threadId }),
    })]);
    expect(service.readThread(threadId, false).thread.ephemeral).toBe(true);
    await service.close();
  });

  it("routes a subagent question to the child projection while the root owns the runtime", async () => {
    const taskId = "question-agent-task";
    const fake = new FakeClaudeQuery(
      { name: "AskUserQuestion", input: variants.askUser.input },
      undefined,
      [],
      false,
      undefined,
      undefined,
      undefined,
      [{
        type: "system",
        subtype: "task_notification",
        task_id: taskId,
        tool_use_id: "question-agent-tool",
        status: "completed",
        summary: "Question answered",
        uuid: randomUUID(),
        session_id: "session",
      } as unknown as SDKMessage],
    );
    fake.permissionAgentID = taskId;
    fake.beforePermissionMessages.push({
      type: "system",
      subtype: "task_started",
      task_id: taskId,
      tool_use_id: "question-agent-tool",
      task_type: "agent",
      subagent_type: "Explore",
      description: "Ask one question",
      uuid: randomUUID(),
      session_id: "session",
    } as unknown as SDKMessage);
    const { requests, service, threadId } = await runInteraction(
      fake, variants.askUser.response, "auto_review",
    );
    const child = service.listThreads({ limit: 10, parentThreadId: threadId })[0];
    expect(child).toBeDefined();
    expect(requests).toEqual([expect.objectContaining({
      method: variants.askUser.expectedMethod,
      params: expect.objectContaining({ threadId: child!.id }),
    })]);
    expect(fake.permissionResults).toEqual([expect.objectContaining({ behavior: "allow" })]);
    await service.close();
  });

  it("round-trips MCP form elicitation with content intact", async () => {
    const fake = new FakeClaudeQuery(
      undefined, undefined, [], false, undefined, undefined,
      variants.mcpElicitation.request as ElicitationRequest,
    );
    const { methods, service } = await runInteraction(fake, variants.mcpElicitation.response);
    expect(methods).toEqual([variants.mcpElicitation.expectedMethod]);
    expect(fake.elicitationResults).toEqual([variants.mcpElicitation.expectedResult]);
    await service.close();
  });
});
