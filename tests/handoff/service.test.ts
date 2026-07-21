import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeService } from "../../src/claude/service.js";
import type { Thread } from "../../src/codex/generated/v2/Thread.js";
import type { ThreadForkResponse } from "../../src/codex/generated/v2/ThreadForkResponse.js";
import type { ThreadSettings } from "../../src/codex/generated/v2/ThreadSettings.js";
import type { TurnStartParams } from "../../src/codex/generated/v2/TurnStartParams.js";
import type { Turn } from "../../src/codex/generated/v2/Turn.js";
import type { StockRpc } from "../../src/gateway/stockRpc.js";
import { CrossProviderForks } from "../../src/handoff/service.js";
import { HandoffStore } from "../../src/handoff/store.js";

const directories: string[] = [];

function turn(id: string, text: string): Turn {
  return {
    id,
    items: [{ type: "agentMessage", id: `${id}-item`, text, phase: null, memoryCitation: null }],
    itemsView: "full", status: "completed", error: null, startedAt: 1, completedAt: 2, durationMs: 1000,
  };
}

function thread(id: string, turns: Turn[] = []): Thread {
  return {
    id, extra: null, sessionId: id, forkedFromId: null, parentThreadId: null, preview: "source preview",
    ephemeral: false, historyMode: "legacy", modelProvider: "openai", createdAt: 1, updatedAt: 1, recencyAt: 1,
    status: { type: "idle" }, path: null, cwd: "/tmp", cliVersion: "0.144.4", source: "appServer",
    threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: "source", turns,
  };
}

function settings(model: string, provider: string): ThreadSettings {
  return {
    cwd: "/tmp", approvalPolicy: "on-request", approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: null,
    model, modelProvider: provider, serviceTier: "default", effort: "medium", summary: null,
    collaborationMode: { mode: "default", settings: { model, reasoning_effort: "medium", developer_instructions: null } },
    multiAgentMode: "explicitRequestOnly", personality: null,
  };
}

function response(value: Thread, model: string, provider: string): ThreadForkResponse {
  return {
    thread: value, model, modelProvider: provider, serviceTier: "default", cwd: value.cwd,
    runtimeWorkspaceRoots: [value.cwd], instructionSources: [], approvalPolicy: "on-request",
    approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, activePermissionProfile: null,
    reasoningEffort: "medium", multiAgentMode: "explicitRequestOnly",
  };
}

const capturedTitleText = `You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task that will be created from that prompt.
The task usually has to do with coding work, such as fixing a bug, changing a feature, or answering a question about a codebase.
Generate a concise UI title of at most 36 characters.
Use a single line of plain text only.
Do not include quotes, markdown, formatting characters, or trailing punctuation.
If the prompt includes a ticket reference, include it verbatim.
Prefer an imperative verb when the user is asking for a change.
Do not answer the user or attempt the task.

User prompt:
Build allergy pollen plots`;

function capturedTitleTurn(threadId: string, text = capturedTitleText): TurnStartParams {
  return {
    threadId,
    effort: "low",
    input: [{ type: "text", text, text_elements: [] }],
    outputSchema: {
      additionalProperties: false,
      properties: { title: { maxLength: 36, minLength: 1, type: "string" } },
      required: ["title"],
      type: "object",
    },
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CrossProviderForks", () => {
  it("routes the captured system title fork through a silent ephemeral stock thread", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-title-fork-"));
    directories.push(directory);
    const sourceTurn = turn("claude-turn", "Fable answer used for the title");
    sourceTurn.items.unshift({
      type: "userMessage", id: "claude-user", clientId: null,
      content: [{ type: "text", text: "Investigate the title generator", text_elements: [] }],
    });
    const source = thread("claude-source", [sourceTurn]);
    source.modelProvider = "claude";
    const claude = {
      ownsThread: (id: string) => id === source.id,
      ownsModel: (model: string) => model.startsWith("claude:"),
      handoffSource: () => ({ thread: source, turns: [sourceTurn], settings: settings("claude:fable", "claude") }),
      summarizeHandoff: async () => { throw new Error("system title fork must not compact Claude context"); },
    } as unknown as ClaudeService;
    const target = thread("title-target");
    target.ephemeral = true;
    target.threadSource = "system";
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let handoffs: CrossProviderForks;
    const stock = {
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          expect(handoffs.suppressStockTargetMessage("title-connection", {
            method: "thread/started", params: { thread: target },
          })).toBe(true);
          return response(target, "gpt-5.4-mini", "openai");
        }
        if (method === "thread/inject_items" || method === "thread/delete") return {};
        throw new Error(`Unexpected ${method}`);
      },
    } as unknown as StockRpc;
    handoffs = new CrossProviderForks(new HandoffStore(join(directory, "handoffs.sqlite")), claude);
    const captured: Parameters<CrossProviderForks["forkSystemEphemeral"]>[0] = {
      threadId: source.id,
      path: null,
      model: "gpt-5.4-mini",
      modelProvider: null,
      serviceTier: null,
      cwd: "/tmp",
      approvalPolicy: "never",
      permissions: ":read-only",
      runtimeWorkspaceRoots: [],
      config: {
        "features.enable_fanout": false,
        "features.hooks": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
        web_search: "disabled",
        model_reasoning_effort: "low",
      },
      ephemeral: true,
      threadSource: "system",
    };

    expect(handoffs.isSystemEphemeralFork(captured)).toBe(true);
    const fork = await handoffs.forkSystemEphemeral(captured, stock, "title-connection");

    expect(fork).toMatchObject({
      thread: {
        id: target.id, ephemeral: true, threadSource: "system", forkedFromId: source.id,
        turns: [{ id: sourceTurn.id }],
      },
      model: "gpt-5.4-mini",
    });
    expect(requests.map((request) => request.method)).toEqual(["thread/start", "thread/inject_items"]);
    expect(requests[0]?.params).toMatchObject({
      model: "gpt-5.4-mini", modelProvider: "openai", cwd: "/tmp", approvalPolicy: "never",
      permissions: ":read-only", runtimeWorkspaceRoots: [], ephemeral: true, threadSource: "system",
      config: { model_reasoning_effort: "low" },
    });
    expect(requests[1]?.params).toEqual({
      threadId: target.id,
      items: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Investigate the title generator" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Fable answer used for the title" }] },
      ],
    });
    expect(handoffs.overlay(target.id)).toBeUndefined();
    expect(handoffs.suppressStockTargetMessage("title-connection", {
      method: "thread/started", params: { thread: target },
    })).toBe(true);
    expect(handoffs.ownsSystemEphemeral("title-connection", target.id)).toBe(true);

    const rewritten = handoffs.prepareTitleTurn("title-connection", capturedTitleTurn(target.id));
    expect((rewritten.input[0] as { text: string }).text).toContain(
      "Start with exactly one rare, expressive, context-relevant emoji",
    );
    expect((rewritten.input[0] as { text: string }).text)
      .not.toContain("The task usually has to do with coding work");
    expect((rewritten.input[0] as { text: string }).text).not.toContain("✳️");
    const output = handoffs.rewriteTitleMessages({
      method: "item/completed",
      params: {
        threadId: target.id,
        turnId: "title-turn",
        item: { type: "agentMessage", id: "title-item", text: "{\"title\":\"Allergy plots\",\"extra\":\"drop me\"}" },
      },
    });
    expect(output).toEqual([
      {
        method: "item/agentMessage/delta",
        params: {
          threadId: target.id, turnId: "title-turn", itemId: "title-item",
          delta: "{\"title\":\"🤧 Allergy plots ✳️\"}",
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: target.id,
          turnId: "title-turn",
          item: { type: "agentMessage", id: "title-item", text: "{\"title\":\"🤧 Allergy plots ✳️\"}" },
        },
      },
    ]);
    expect(handoffs.rewriteTitleMessages({
      method: "item/agentMessage/delta",
      params: { threadId: target.id, turnId: "title-turn", itemId: "title-item", delta: "ignored" },
    })).toEqual([]);
    expect(handoffs.rewriteTitleMessages({
      method: "turn/completed",
      params: {
        threadId: target.id,
        turn: { id: "title-turn", items: [{ type: "agentMessage", id: "title-item", text: "raw" }] },
      },
    })).toEqual([{
      method: "turn/completed",
      params: {
        threadId: target.id,
        turn: {
          id: "title-turn",
          items: [{ type: "agentMessage", id: "title-item", text: "{\"title\":\"🤧 Allergy plots ✳️\"}" }],
        },
      },
    }]);
    await handoffs.detachConnection("title-connection", stock);
    expect(requests.map((request) => request.method)).toEqual(["thread/start", "thread/inject_items", "thread/delete"]);
    expect(handoffs.suppressStockTargetMessage("title-connection", {
      method: "thread/started", params: { thread: target },
    })).toBe(false);
    handoffs.close();
  });

  it("rewrites only the captured title prompt on managed system ephemeral threads", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-title-detection-"));
    directories.push(directory);
    const claude = {
      ownsThread: (id: string) => id === "claude-durable",
      ownsModel: (model: string) => model.startsWith("claude:"),
    } as unknown as ClaudeService;
    const handoffs = new CrossProviderForks(new HandoffStore(join(directory, "handoffs.sqlite")), claude);
    handoffs.registerForwardedEphemeralCandidate("connection", "stock-title", {
      threadId: "stock-durable", model: "gpt-5.4-mini", ephemeral: true, threadSource: "system",
    });
    handoffs.registerForwardedEphemeralCandidate("connection", "user-side", {
      threadId: "stock-durable", model: "gpt-5.4-mini", ephemeral: true, threadSource: "user",
    });
    handoffs.registerForwardedEphemeralCandidate("connection", "direct-near-miss", {
      model: "gpt-5.4-mini", ephemeral: true,
    });

    const exact = capturedTitleTurn("stock-title");
    const rewritten = handoffs.prepareTitleTurn("connection", exact);
    expect(rewritten).not.toBe(exact);
    expect((rewritten.input[0] as { text: string }).text)
      .toContain("Start with exactly one rare, expressive, context-relevant emoji");
    const userSide = capturedTitleTurn("user-side");
    expect(handoffs.prepareTitleTurn("connection", userSide)).toBe(userSide);
    const nearMiss = capturedTitleTurn("stock-title", "Please generate a short title for this user task");
    expect(handoffs.prepareTitleTurn("connection", nearMiss)).toBe(nearMiss);
    const directNearMiss = capturedTitleTurn("direct-near-miss", "Please generate a short title for this user task");
    expect(handoffs.prepareTitleTurn("connection", directNearMiss)).toBe(directNearMiss);
    expect(handoffs.ownsSystemEphemeral("connection", "direct-near-miss")).toBe(false);
    const missingSchema = { ...capturedTitleTurn("stock-title"), outputSchema: null };
    expect(handoffs.prepareTitleTurn("connection", missingSchema)).toBe(missingSchema);
    handoffs.close();
  });

  it("replaces the stock instructions with the configured rename_prompt and appends user input", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-custom-title-prompt-"));
    directories.push(directory);
    const claude = {
      ownsThread: () => false,
      ownsModel: (model: string) => model.startsWith("claude:"),
    } as unknown as ClaudeService;
    const handoffs = new CrossProviderForks(
      new HandoffStore(join(directory, "handoffs.sqlite")),
      claude,
      "CUSTOM TITLE RULES",
    );
    handoffs.registerForwardedEphemeralCandidate("connection", "title", {
      threadId: "stock-durable", model: "gpt-5.4-mini", ephemeral: true, threadSource: "system",
    });

    const rewritten = handoffs.prepareTitleTurn("connection", capturedTitleTurn("title"));
    expect((rewritten.input[0] as { text: string }).text)
      .toBe("CUSTOM TITLE RULES\n\nUser prompt:\nBuild allergy pollen plots");
    handoffs.close();
  });

  it("keeps title traffic byte-exact when rename_prompt is absent while retaining cleanup ownership", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-title-ux-disabled-"));
    directories.push(directory);
    const claude = {
      ownsThread: (id: string) => id === "claude-durable",
      ownsModel: (model: string) => model.startsWith("claude:"),
    } as unknown as ClaudeService;
    const handoffs = new CrossProviderForks(
      new HandoffStore(join(directory, "handoffs.sqlite")),
      claude,
      null,
    );
    handoffs.registerForwardedEphemeralCandidate("connection", "title", {
      threadId: "claude-durable", model: "gpt-5.4-mini", ephemeral: true, threadSource: "system",
    });
    const request = capturedTitleTurn("title");
    request.outputSchema = {
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 36 },
        description: { type: "string", minLength: 1, maxLength: 100 },
      },
      required: ["title", "description"],
      type: "object",
    };

    expect(handoffs.prepareTitleTurn("connection", request)).toBe(request);
    expect(handoffs.ownsSystemEphemeral("connection", "title")).toBe(true);
    expect(handoffs.rewriteTitleMessages({
      method: "item/completed",
      params: {
        threadId: "title",
        turnId: "turn",
        item: {
          type: "agentMessage",
          id: "item",
          text: "{\"title\":\"Plain stock title\",\"extra\":\"drop me\"}",
        },
      },
    })).toBeUndefined();
    expect(handoffs.rewriteTitleMessages({
      method: "turn/completed",
      params: {
        threadId: "title",
        turn: { id: "turn", items: [{ type: "agentMessage", id: "item", text: "raw" }] },
      },
    })).toBeUndefined();
    expect(handoffs.releaseSystemEphemeral("connection", "title")).toBe(true);
    expect(handoffs.ownsSystemEphemeral("connection", "title")).toBe(false);
    handoffs.close();
  });

  it("uses the durable provider for the Claude marker, never the title-generator model", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-title-provider-"));
    directories.push(directory);
    const claude = {
      ownsThread: (id: string) => id === "initial-claude" || id === "codex-to-claude-target",
      ownsModel: (model: string) => model.startsWith("claude:"),
    } as unknown as ClaudeService;
    const handoffs = new CrossProviderForks(new HandoffStore(join(directory, "handoffs.sqlite")), claude);

    handoffs.observeDurableTurn("direct", {
      threadId: "initial-claude", input: [{ type: "text", text: "Build allergy pollen plots", text_elements: [] }],
    });
    handoffs.registerForwardedEphemeralCandidate("direct", "direct-title", {
      model: "gpt-5.4-mini", ephemeral: true,
    });
    const direct = handoffs.prepareTitleTurn("direct", capturedTitleTurn("direct-title"));
    expect((direct.input[0] as { text: string }).text).not.toContain("✳️");

    for (const source of ["initial-claude", "codex-to-claude-target"]) {
      const ephemeral = `${source}-title`;
      handoffs.registerForwardedEphemeralCandidate("connection", ephemeral, {
        threadId: source, model: "gpt-5.4-mini", ephemeral: true, threadSource: "system",
      });
      const rewritten = handoffs.prepareTitleTurn("connection", capturedTitleTurn(ephemeral));
      expect((rewritten.input[0] as { text: string }).text).not.toContain("✳️");
      const completed = handoffs.rewriteTitleMessages({
        method: "item/completed",
        params: {
          threadId: ephemeral,
          item: { type: "agentMessage", id: "item", text: "{\"title\":\"🧯 ✳️ 🧪 Pollen model ✳️ ✳️\"}" },
        },
      });
      expect((completed?.at(-1)?.params as { item: { text: string } }).item.text)
        .toBe("{\"title\":\"🧯 Pollen model ✳️\"}");
    }

    handoffs.registerForwardedEphemeralCandidate("connection", "claude-to-codex-title", {
      threadId: "claude-to-codex-target", model: "gpt-5.4-mini", ephemeral: true, threadSource: "system",
    });
    const native = handoffs.prepareTitleTurn("connection", capturedTitleTurn("claude-to-codex-title"));
    expect((native.input[0] as { text: string }).text).not.toContain("✳️");
    const completed = handoffs.rewriteTitleMessages({
      method: "item/completed",
      params: {
        threadId: "claude-to-codex-title",
        item: { type: "agentMessage", id: "item", text: "{\"title\":\"🧯 Pollen model ✳️\"}" },
      },
    });
    expect((completed?.at(-1)?.params as { item: { text: string } }).item.text)
      .toBe("{\"title\":\"🧯 Pollen model\"}");
    handoffs.close();
  });

  it("preserves the captured title schema when the system worker starts before the first Claude turn", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-title-start-race-"));
    directories.push(directory);
    const claude = {
      ownsThread: (id: string) => id === "fresh-claude",
      ownsModel: (model: string) => model.startsWith("claude:"),
    } as unknown as ClaudeService;
    const handoffs = new CrossProviderForks(new HandoffStore(join(directory, "handoffs.sqlite")), claude);

    // Captured order: durable Claude thread/start response, direct system
    // ephemeral title worker, title turn/start, then the first durable turn.
    handoffs.observeDurableThread("captured", "claude");
    handoffs.registerForwardedEphemeralCandidate("captured", "title-worker", {
      model: "gpt-5.4-mini", ephemeral: true, threadSource: "system",
    });
    const titleTurn = capturedTitleTurn(
      "title-worker",
      capturedTitleText.replace("Build allergy pollen plots", "Explain why octopuses have three hearts"),
    );
    titleTurn.outputSchema = {
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 36 },
        description: { type: "string", minLength: 1 },
      },
      required: ["title", "description"],
      type: "object",
    };
    const rewritten = handoffs.prepareTitleTurn("captured", titleTurn);
    expect((rewritten.input[0] as { text: string }).text).not.toContain("✳️");

    handoffs.observeDurableTurn("captured", {
      threadId: "fresh-claude",
      input: [{ type: "text", text: "Explain why octopuses have three hearts", text_elements: [] }],
    });
    const completed = handoffs.rewriteTitleMessages({
      method: "item/completed",
      params: {
        threadId: "title-worker",
        turnId: "title-turn",
        item: {
          type: "agentMessage",
          id: "title-item",
          text: JSON.stringify({
            title: "🦑 Explain octopus hearts ✳️",
            description: "Why octopuses need two gill hearts and one systemic heart",
            ignored: "not allowed by the schema",
          }),
        },
      },
    });
    expect((completed?.at(-1)?.params as { item: { text: string } }).item.text).toBe(JSON.stringify({
      title: "🦑 Explain octopus hearts ✳️",
      description: "Why octopuses need two gill hearts and one systemic heart",
    }));

    handoffs.observeDurableThread("captured", "stock");
    handoffs.registerForwardedEphemeralCandidate("captured", "next-stock-title", {
      model: "gpt-5.4-mini", ephemeral: true, threadSource: "system",
    });
    const stockTitle = handoffs.prepareTitleTurn("captured", capturedTitleTurn("next-stock-title"));
    expect((stockTitle.input[0] as { text: string }).text).not.toContain("✳️");
    handoffs.close();
  });

  it("lets the durable owner and late durable turn override stale same-text title correlation", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-title-provider-race-"));
    directories.push(directory);
    const claude = {
      ownsThread: (id: string) => id === "old-claude" || id === "fresh-claude",
      ownsModel: (model: string) => model.startsWith("claude:"),
    } as unknown as ClaudeService;
    const handoffs = new CrossProviderForks(new HandoffStore(join(directory, "handoffs.sqlite")), claude);
    const prompt = "Start a background reminder";
    const titleRequest = (threadId: string) => capturedTitleTurn(
      threadId,
      capturedTitleText.replace("Build allergy pollen plots", prompt),
    );
    const title = (threadId: string, value: string) => {
      const completed = handoffs.rewriteTitleMessages({
        method: "item/completed",
        params: {
          threadId,
          item: { type: "agentMessage", id: `${threadId}-item`, text: JSON.stringify({ title: value }) },
        },
      });
      return (JSON.parse((completed?.at(-1)?.params as { item: { text: string } }).item.text) as { title: string }).title;
    };

    handoffs.observeDurableTurn("captured", {
      threadId: "old-claude",
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    handoffs.observeDurableThread("captured", "stock");
    handoffs.registerForwardedEphemeralCandidate("captured", "stock-title", {
      model: "gpt-5.6-luna", ephemeral: true, threadSource: "system",
    });
    handoffs.prepareTitleTurn("captured", titleRequest("stock-title"));
    handoffs.observeDurableTurn("captured", {
      threadId: "fresh-stock",
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    expect(title("stock-title", "⏰ Background reminder ✳️")).toBe("⏰ Background reminder");

    handoffs.observeDurableThread("captured", "claude");
    handoffs.registerForwardedEphemeralCandidate("captured", "claude-title", {
      model: "gpt-5.6-luna", ephemeral: true, threadSource: "system",
    });
    handoffs.prepareTitleTurn("captured", titleRequest("claude-title"));
    handoffs.observeDurableTurn("captured", {
      threadId: "fresh-claude",
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    expect(title("claude-title", "⏰ Background reminder ✳️ ✳️")).toBe("⏰ Background reminder ✳️");
    handoffs.close();
  });

  it("repairs a missing required title description instead of triggering App fallback", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-title-description-"));
    directories.push(directory);
    const claude = {
      ownsThread: () => true,
      ownsModel: (model: string) => model.startsWith("claude:"),
    } as unknown as ClaudeService;
    const handoffs = new CrossProviderForks(new HandoffStore(join(directory, "handoffs.sqlite")), claude);
    handoffs.registerForwardedEphemeralCandidate("connection", "title", {
      threadId: "claude-durable", model: "gpt-5.4-mini", ephemeral: true, threadSource: "system",
    });
    const request = capturedTitleTurn("title");
    request.outputSchema = {
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 36 },
        description: { type: "string", minLength: 1, maxLength: 24 },
      },
      required: ["title", "description"],
      type: "object",
    };
    handoffs.prepareTitleTurn("connection", request);
    const completed = handoffs.rewriteTitleMessages({
      method: "item/completed",
      params: {
        threadId: "title",
        item: { type: "agentMessage", id: "item", text: "{\"title\":\"Allergy plots\"}" },
      },
    });
    expect(JSON.parse((completed?.at(-1)?.params as { item: { text: string } }).item.text)).toEqual({
      title: "🤧 Allergy plots ✳️",
      description: "Build allergy pollen plo",
    });
    handoffs.close();
  });

  it("repairs malformed title output and enforces the 36-code-point contract", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-title-output-"));
    directories.push(directory);
    const claude = {
      ownsThread: (id: string) => id === "claude-durable",
      ownsModel: (model: string) => model.startsWith("claude:"),
    } as unknown as ClaudeService;
    const handoffs = new CrossProviderForks(new HandoffStore(join(directory, "handoffs.sqlite")), claude);
    handoffs.registerForwardedEphemeralCandidate("connection", "title", {
      threadId: "claude-durable", model: "gpt-5.4-mini", ephemeral: true, threadSource: "system",
    });
    handoffs.prepareTitleTurn("connection", capturedTitleTurn(
      "title", capturedTitleText.replace("Build allergy pollen plots", "Organize release workflow"),
    ));
    const completed = handoffs.rewriteTitleMessages({
      method: "item/completed",
      params: {
        threadId: "title",
        item: { type: "agentMessage", id: "item", text: "A title far too long for the compact sidebar contract" },
      },
    });
    const text = (completed?.at(-1)?.params as { item: { text: string } }).item.text;
    const title = (JSON.parse(text) as { title: string }).title;
    expect(Array.from(title).length).toBeLessThanOrEqual(36);
    expect(title).toMatch(/^🪄 /u);
    expect(title).toMatch(/ ✳️$/u);
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual(["title"]);
    handoffs.close();
  });

  it("retires an unfinished legacy cross-provider fork after gateway restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ccodex-recovered-handoff-"));
    directories.push(directory);
    const path = join(directory, "handoffs.sqlite");
    const sourceTurn = turn("source-turn", "source answer");
    const source = thread("source", [sourceTurn]);
    source.modelProvider = "claude";
    const persisted = new HandoffStore(path);
    persisted.createJob({
      id: "recovered-job",
      sourceThreadId: "source",
      params: {
        threadId: "source",
        model: "gpt-5.6-sol",
        lastTurnId: "source-turn",
      },
    });
    persisted.checkpointJobTarget(
      "recovered-job",
      response(thread("interrupted-target"), "gpt-5.6-sol", "openai") as unknown as Record<string, unknown>,
    );
    persisted.close();
    const claude = {
      ownsThread: (id: string) => id === "source",
      ownsModel: (model: string) => model.startsWith("claude:"),
      handoffSource: () => ({ thread: source, turns: [sourceTurn], settings: settings("claude:sonnet", "claude") }),
      summarizeHandoff: async () => "recovered summary",
    } as unknown as ClaudeService;
    const target = thread("recovered-target");
    const deleted: string[] = [];
    const stock = {
      request: async (method: string, params: { threadId?: string }) => {
        if (method === "thread/delete") {
          deleted.push(params.threadId!);
          return {};
        }
        if (method === "thread/start") return response(target, "gpt-5.6-sol", "openai");
        if (["thread/inject_items", "thread/name/set", "thread/settings/update"].includes(method)) return {};
        throw new Error(`Unexpected ${method}`);
      },
    } as unknown as StockRpc;
    const handoffs = new CrossProviderForks(new HandoffStore(path), claude);
    handoffs.configureDaemonStock(stock);
    await handoffs.drain();

    expect(deleted).toEqual(["interrupted-target"]);
    expect(handoffs.claimFailedFork("source")).toContain("Legacy cross-provider Fork was retired");
    handoffs.close();
  });
});
