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
): Promise<{
  methods: string[];
  service: ClaudeService;
  threadId: string;
  events: Array<{ method: string; params: unknown }>;
}> {
  const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-adapter-variant-"));
  directories.push(directory);
  const hub = new SubscriptionHub();
  const service = new ClaudeService(
    config(directory), hub, new Logger("error"), new SqliteHybridStore(join(directory, "state.sqlite")), fake.factory,
  );
  const started = await service.startThread({ model: "claude:haiku", cwd: directory, approvalPolicy: "on-request" });
  const methods: string[] = [];
  const events: Array<{ method: string; params: unknown }> = [];
  let terminal = false;
  hub.subscribe(started.thread.id, "test", (method, params) => {
    events.push({ method, params });
    if (method === "turn/completed") terminal = true;
  }, (id, method) => {
    methods.push(method);
    void service.resolveServerRequest(id, response);
  });
  const prepared = await service.prepareTurn({
    threadId: started.thread.id, input: [{ type: "text", text: "fixture interaction", text_elements: [] }],
  });
  prepared.announce();
  prepared.start();
  await new Promise<void>((resolve) => {
    const poll = () => terminal ? resolve() : setTimeout(poll, 5);
    poll();
  });
  return { methods, service, threadId: started.thread.id, events };
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
    const { methods, service } = await runInteraction(fake, variants.askUser.response);
    expect(methods).toEqual([variants.askUser.expectedMethod]);
    expect(fake.permissionResults).toEqual([{
      behavior: "allow",
      updatedInput: { ...variants.askUser.input, answers: variants.askUser.expectedAnswers },
    }]);
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
