import { randomUUID } from "node:crypto";
import type {
  CanUseTool,
  ElicitationRequest,
  ElicitationResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncQueue } from "../../src/claude/asyncQueue.js";
import type { ClaudeQueryFactory, ClaudeQueryInput } from "../../src/claude/queryFactory.js";

export class FakeClaudeQuery {
  public readonly inputs: ClaudeQueryInput[] = [];
  public readonly prompts: SDKUserMessage[] = [];
  public readonly permissionResults: unknown[] = [];
  public readonly providerAllowedTools: string[] = [];
  public readonly providerHookAllowedTools: string[] = [];
  public readonly toolExecutionErrors: string[] = [];
  public readonly elicitationResults: ElicitationResult[] = [];
  public readonly preToolHookResults: unknown[] = [];
  public readonly stoppedTaskIds: string[] = [];
  public readonly controls: Array<{ method: string; value: unknown }> = [];
  public failControlOnce: string | undefined;
  public interruptCalls = 0;
  public interruptWait?: Promise<void>;
  public interruptReceipt = false;
  public cancelAsyncMessages = true;
  public returnCalls = 0;
  public returnWait?: Promise<void>;
  public returnError: Error | undefined;
  public streamPermissionTool = false;
  public compactBoundaryWait?: Promise<void>;
  public compactFailure?: string;
  public compactSummary?: string;
  public compactSummaryAfterBoundary = false;
  public duplicateCompactBoundary = false;
  public emitSessionStateChanges = true;
  public compactIdleBeforeBoundary = false;
  public compactLateBoundaryWait?: Promise<void>;
  public contextUsage: { totalTokens: number; maxTokens: number } | Error = { totalTokens: 24, maxTokens: 200_000 };
  public contextUsageWait?: Promise<void>;
  public contextUsageCalls = 0;
  public experimentalUsage: unknown | Error = {
    session: {
      total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0,
      total_lines_added: 0, total_lines_removed: 0, model_usage: {},
    },
    subscription_type: "max",
    rate_limits_available: false,
    rate_limits: null,
  };
  public experimentalUsageWait?: Promise<void>;
  public experimentalUsageCalls = 0;
  public afterResultPause?: { afterIndex: number; wait: Promise<void> };
  public deferPermissionResultUntilAfterPrimaryResult = false;
  public permissionSuggestions: PermissionUpdate[] | undefined;
  public permissionMatchedAskRule: Parameters<CanUseTool>[2]["matchedAskRule"];
  public noQueryAcknowledgementBatchSize = 1;
  private permissionToolSequence = 0;
  private readonly outputs: AsyncQueue<SDKMessage>[] = [];

  public constructor(
    public toolRequest?: { name: string; input: Record<string, unknown> },
    private readonly toolExecution?: { name: string; input: Record<string, unknown>; execute: () => void | Promise<void> },
    private readonly afterResultMessages: SDKMessage[] = [],
    private readonly compactBoundary = false,
    private readonly structuredOutput?: unknown,
    public resultMessage?: SDKMessage,
    private readonly elicitationRequest?: ElicitationRequest,
    private readonly beforeResultMessages: SDKMessage[] = [],
    private readonly beforeResultPause?: { afterIndex: number; wait: Promise<void> },
    private readonly noQueryAcknowledgementWait?: Promise<void>,
  ) {
    this.permissionSuggestions = toolRequest
      ? [{
          type: "addRules",
          rules: [{ toolName: toolRequest.name }],
          behavior: "allow",
          destination: "session",
        }]
      : undefined;
  }

  public readonly factory: ClaudeQueryFactory = (input) => {
    this.inputs.push(input);
    const sessionId = input.options.resume ?? input.options.sessionId ?? "session";
    const output = new AsyncQueue<SDKMessage>();
    this.outputs.push(output);
    const iterator = output[Symbol.asyncIterator]();
    output.push({
      type: "system", subtype: "init", model: input.options.model ?? "haiku",
      claude_code_version: "test", session_id: sessionId, uuid: randomUUID(),
      apiKeySource: "none", cwd: input.options.cwd ?? process.cwd(), tools: [], mcp_servers: [],
      permissionMode: input.options.permissionMode ?? "default", slash_commands: [], output_style: "default", skills: [], plugins: [],
      ...(this.interruptReceipt ? { capabilities: ["interrupt_receipt_v1"] } : {}),
    } as unknown as SDKMessage);
    void this.consumePrompts(input, output);
    return this.query(
      sessionId,
      output,
      iterator,
      input.options.allowDangerouslySkipPermissions === true,
    );
  };

  public emit(message: SDKMessage, queryIndex = this.outputs.length - 1): void {
    this.outputs[queryIndex]!.push(message);
  }

  public exit(queryIndex = this.outputs.length - 1): void {
    this.outputs[queryIndex]!.close();
  }

  private async consumePrompts(input: ClaudeQueryInput, output: AsyncQueue<SDKMessage>): Promise<void> {
    let pendingNoQueryAcknowledgements = 0;
    for await (const _message of input.prompt) {
      this.prompts.push(_message);
      const sessionId = input.options.resume ?? input.options.sessionId ?? "session";
      if (_message.shouldQuery === false) {
        pendingNoQueryAcknowledgements += 1;
        if (pendingNoQueryAcknowledgements < this.noQueryAcknowledgementBatchSize) continue;
        pendingNoQueryAcknowledgements = 0;
        await this.noQueryAcknowledgementWait;
        try {
          output.push({
            type: "result", subtype: "success", duration_ms: 0, duration_api_ms: 0,
            is_error: false, num_turns: 0, result: "", stop_reason: null, total_cost_usd: 0,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            modelUsage: {}, permission_denials: [], uuid: randomUUID(), session_id: sessionId,
          } as unknown as SDKMessage);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "Queue is closed.") throw error;
          return;
        }
        continue;
      }
      if (this.emitSessionStateChanges) {
        output.push({
          type: "system", subtype: "session_state_changed", state: "running",
          uuid: randomUUID(), session_id: sessionId,
        } as unknown as SDKMessage);
      }
      const content = Array.isArray(_message.message.content) ? _message.message.content : [];
      if (this.compactBoundary && content.some((block) =>
        block.type === "text" && /^\/compact(?:\s|$)/u.test(block.text))) {
        await this.compactBoundaryWait;
        if (this.compactIdleBeforeBoundary) {
          output.push({
            type: "system", subtype: "session_state_changed", state: "idle",
            uuid: randomUUID(), session_id: sessionId,
          } as unknown as SDKMessage);
          await this.compactLateBoundaryWait;
        }
        if (this.compactFailure) {
          output.push({
            type: "system", subtype: "status", status: null, permissionMode: input.options.permissionMode ?? "default",
            compact_result: "failed", compact_error: this.compactFailure, uuid: randomUUID(), session_id: sessionId,
          } as unknown as SDKMessage);
        } else {
          const postCompact = async () => {
            if (this.compactSummary === undefined) return;
            const hookId = randomUUID();
            output.push({
              type: "system", subtype: "hook_started", hook_id: hookId,
              hook_name: "CCodex PostCompact", hook_event: "PostCompact",
              uuid: randomUUID(), session_id: sessionId,
            } as unknown as SDKMessage);
            await input.options.hooks?.PostCompact?.[0]?.hooks[0]?.({
              session_id: sessionId,
              transcript_path: "/tmp/fake.jsonl",
              cwd: input.options.cwd ?? process.cwd(),
              permission_mode: input.options.permissionMode ?? "default",
              hook_event_name: "PostCompact",
              trigger: "manual",
              compact_summary: this.compactSummary,
            }, undefined, { signal: new AbortController().signal });
            output.push({
              type: "system", subtype: "hook_response", hook_id: hookId,
              output: "", stdout: "", stderr: "", outcome: "success",
              uuid: randomUUID(), session_id: sessionId,
            } as unknown as SDKMessage);
          };
          if (!this.compactSummaryAfterBoundary) await postCompact();
          const boundary = () => ({
            type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 100, post_tokens: 25 },
            uuid: randomUUID(), session_id: sessionId,
          }) as unknown as SDKMessage;
          output.push(boundary());
          if (this.duplicateCompactBoundary) output.push(boundary());
          if (this.compactSummaryAfterBoundary) await postCompact();
        }
        if (this.emitSessionStateChanges) {
          output.push({
            type: "system", subtype: "session_state_changed", state: "idle",
            uuid: randomUUID(), session_id: sessionId,
          } as unknown as SDKMessage);
        }
        continue;
      }
      let deferredPermission: Promise<unknown> | undefined;
      let deferredPermissionToolId: string | undefined;
      const preToolHook = input.options.hooks?.PreToolUse?.[0]?.hooks[0];
      let hookAllowed = false;
      if (this.toolRequest && preToolHook) {
        const toolUseId = `tool-permission-${++this.permissionToolSequence}`;
        const result = await preToolHook({
          session_id: sessionId,
          transcript_path: "/tmp/fake.jsonl",
          cwd: input.options.cwd ?? process.cwd(),
          permission_mode: input.options.permissionMode ?? "default",
          hook_event_name: "PreToolUse",
          tool_name: this.toolRequest.name,
          tool_input: this.toolRequest.input,
          tool_use_id: toolUseId,
        }, toolUseId, { signal: new AbortController().signal });
        this.preToolHookResults.push(result);
        hookAllowed = Boolean(result && "hookSpecificOutput" in result
          && result.hookSpecificOutput?.hookEventName === "PreToolUse"
          && result.hookSpecificOutput.permissionDecision === "allow");
        if (hookAllowed) this.providerHookAllowedTools.push(this.toolRequest.name);
      }
      if (this.toolRequest && !hookAllowed && input.options.allowedTools?.includes(this.toolRequest.name)) {
        this.providerAllowedTools.push(this.toolRequest.name);
      } else if (this.toolRequest && !hookAllowed && input.options.canUseTool) {
        const permissionToolId = `tool-permission-${++this.permissionToolSequence}`;
        if (this.streamPermissionTool) {
          output.push({
            type: "stream_event", event: { type: "message_start", message: {} },
            parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId,
          } as unknown as SDKMessage);
          output.push({
            type: "stream_event", event: {
              type: "content_block_start", index: 0,
              content_block: { type: "tool_use", id: permissionToolId, name: this.toolRequest.name, input: {} },
            },
            parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId,
          } as unknown as SDKMessage);
          output.push({
            type: "stream_event", event: {
              type: "content_block_delta", index: 0,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(this.toolRequest.input) },
            },
            parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId,
          } as unknown as SDKMessage);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        const permission = input.options.canUseTool(this.toolRequest.name, this.toolRequest.input, {
          signal: new AbortController().signal,
          ...(this.permissionSuggestions ? { suggestions: this.permissionSuggestions } : {}),
          ...(this.permissionMatchedAskRule ? { matchedAskRule: this.permissionMatchedAskRule } : {}),
          toolUseID: permissionToolId,
          requestId: `claude-permission-${this.permissionToolSequence}`,
        });
        if (this.deferPermissionResultUntilAfterPrimaryResult) {
          deferredPermission = permission;
          deferredPermissionToolId = permissionToolId;
        } else {
          this.permissionResults.push(await permission);
        }
        if (this.streamPermissionTool && !deferredPermission) {
          output.push({
            type: "user", message: {
              role: "user", content: [{ type: "tool_result", tool_use_id: permissionToolId, content: "ok" }],
            },
            parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId,
          } as unknown as SDKMessage);
        }
      }
      if (this.elicitationRequest && input.options.onElicitation) {
        this.elicitationResults.push(await input.options.onElicitation(this.elicitationRequest, {
          signal: new AbortController().signal,
        }));
      }
      if (this.toolExecution) {
        const toolUseId = "tool-execution-1";
        output.push({
          type: "stream_event", event: { type: "message_start", message: {} },
          parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId,
        } as unknown as SDKMessage);
        output.push({
          type: "stream_event",
          event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolUseId, name: this.toolExecution.name, input: this.toolExecution.input } },
          parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId,
        } as unknown as SDKMessage);
        const preHook = input.options.hooks?.PreToolUse?.[0]?.hooks[0];
        const postHook = input.options.hooks?.PostToolUse?.[0]?.hooks[0];
        const hookBase = {
          session_id: sessionId, transcript_path: "/tmp/fake.jsonl", cwd: input.options.cwd ?? process.cwd(),
          permission_mode: input.options.permissionMode ?? "default", tool_name: this.toolExecution.name,
          tool_input: this.toolExecution.input, tool_use_id: toolUseId,
        };
        this.preToolHookResults.push(await preHook?.(
          { ...hookBase, hook_event_name: "PreToolUse" }, toolUseId, { signal: new AbortController().signal },
        ));
        let executionError: string | undefined;
        try {
          await this.toolExecution.execute();
        } catch (error) {
          executionError = error instanceof Error ? error.message : String(error);
          this.toolExecutionErrors.push(executionError);
        }
        await postHook?.({ ...hookBase, hook_event_name: "PostToolUse", tool_response: "ok" }, toolUseId, { signal: new AbortController().signal });
        output.push({
          type: "user", message: {
            role: "user", content: [{
              type: "tool_result", tool_use_id: toolUseId,
              content: executionError ?? "ok", ...(executionError ? { is_error: true } : {}),
            }],
          },
          parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId,
        } as unknown as SDKMessage);
      }
      for (const [index, message] of this.beforeResultMessages.entries()) {
        output.push(message);
        if (this.beforeResultPause?.afterIndex === index) await this.beforeResultPause.wait;
      }
      if (this.toolExecution) {
        output.push({
          type: "stream_event", event: { type: "message_start", message: {} },
          parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId,
        } as unknown as SDKMessage);
      }
      const textIndex = 0;
      output.push({
        type: "stream_event",
        event: { type: "content_block_start", index: textIndex, content_block: { type: "text", text: "" } },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: sessionId,
      } as unknown as SDKMessage);
      output.push({
        type: "stream_event",
        event: { type: "content_block_delta", index: textIndex, delta: { type: "text_delta", text: "OK" } },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: sessionId,
      } as unknown as SDKMessage);
      output.push({
        type: "stream_event",
        event: { type: "content_block_stop", index: textIndex },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: sessionId,
      } as unknown as SDKMessage);
      output.push({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "OK" }] },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: sessionId,
      } as unknown as SDKMessage);
      output.push(this.resultMessage ?? {
        type: "result",
        subtype: "success",
        duration_ms: 10,
        duration_api_ms: 8,
        is_error: false,
        num_turns: 1,
        result: "OK",
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: { input_tokens: 4, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        modelUsage: { haiku: { inputTokens: 4, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0, contextWindow: 200_000, maxOutputTokens: 8_192 } },
        permission_denials: [],
        ...(this.structuredOutput === undefined ? {} : { structured_output: this.structuredOutput }),
        uuid: randomUUID(),
        session_id: sessionId,
      } as unknown as SDKMessage);
      if (deferredPermission) {
        this.permissionResults.push(await deferredPermission);
        if (this.streamPermissionTool) {
          output.push({
            type: "user", message: {
              role: "user", content: [{ type: "tool_result", tool_use_id: deferredPermissionToolId!, content: "ok" }],
            },
            parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId,
          } as unknown as SDKMessage);
        }
      }
      for (const [index, message] of this.afterResultMessages.entries()) {
        output.push(message);
        if (this.afterResultPause?.afterIndex === index) await this.afterResultPause.wait;
      }
      if (this.emitSessionStateChanges) {
        output.push({
          type: "system", subtype: "session_state_changed", state: "idle",
          uuid: randomUUID(), session_id: sessionId,
        } as unknown as SDKMessage);
      }
    }
  }

  private query(
    sessionId: string,
    output: AsyncQueue<SDKMessage>,
    iterator: AsyncIterator<SDKMessage>,
    allowDangerouslySkipPermissions: boolean,
  ): Query {
    const control = async (method: string, value: unknown): Promise<void> => {
      this.controls.push({ method, value });
      if (this.failControlOnce !== method) return;
      this.failControlOnce = undefined;
      throw new Error(`fake ${method} failure`);
    };
    return {
      next: () => iterator.next(),
      return: async () => {
        this.returnCalls += 1;
        await this.returnWait;
        output.close();
        if (this.returnError) throw this.returnError;
        return { value: undefined, done: true };
      },
      throw: async (error?: unknown) => Promise.reject(error),
      [Symbol.asyncIterator]() { return this; },
      initializationResult: async () => ({}),
      getContextUsage: async () => {
        this.contextUsageCalls += 1;
        await this.contextUsageWait;
        if (this.contextUsage instanceof Error) throw this.contextUsage;
        return this.contextUsage;
      },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        this.experimentalUsageCalls += 1;
        await this.experimentalUsageWait;
        if (this.experimentalUsage instanceof Error) throw this.experimentalUsage;
        return this.experimentalUsage;
      },
      reinitialize: async () => ({}),
      setModel: async (model: Parameters<Query["setModel"]>[0]) => control("setModel", model),
      applyFlagSettings: async (settings: Parameters<Query["applyFlagSettings"]>[0]) =>
        control("applyFlagSettings", settings),
      setMaxThinkingTokens: async (
        tokens: Parameters<Query["setMaxThinkingTokens"]>[0],
        display: Parameters<Query["setMaxThinkingTokens"]>[1],
      ) =>
        control("setMaxThinkingTokens", { tokens, display }),
      setPermissionMode: async (mode: Parameters<Query["setPermissionMode"]>[0]) => {
        if (mode === "bypassPermissions" && !allowDangerouslySkipPermissions) {
          throw new Error("fake bypassPermissions requires allowDangerouslySkipPermissions");
        }
        await control("setPermissionMode", mode);
      },
      stopTask: async (taskId: string) => { this.stoppedTaskIds.push(taskId); },
      interrupt: async () => {
        this.interruptCalls += 1;
        await this.interruptWait;
        return this.interruptReceipt
          ? { still_queued: this.prompts.map((message) => message.uuid) }
          : undefined;
      },
      ...(this.interruptReceipt
        ? { cancelAsyncMessage: async () => this.cancelAsyncMessages }
        : {}),
      close: () => output.close(),
    } as unknown as Query;
  }
}
