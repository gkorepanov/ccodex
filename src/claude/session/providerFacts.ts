import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeFactSource } from "./commands.js";

export interface RuntimeFactContext extends RuntimeFactSource {
  readonly activeTurnId: string | null;
  readonly readOnly: boolean;
}

export interface ProviderEventIdentity {
  readonly providerEventId: string | null;
  readonly providerEventType: string;
}

interface ProviderFactEnvelope extends ProviderEventIdentity {
  readonly runtimeGeneration: number;
}

export type ProviderMessageFact =
  | ProviderFactEnvelope & {
    readonly kind: "message";
    readonly message: Exclude<SDKMessage, SDKResultMessage>;
  }
  | ProviderFactEnvelope & {
    readonly kind: "terminal";
    readonly message: SDKResultMessage;
  };

export type ClaudeProviderFact =
  | ProviderMessageFact
  | {
    readonly kind: "inputPending";
    readonly runtimeGeneration: number;
    readonly pendingInputs: number;
  }
  | {
    readonly kind: "exit";
    readonly runtimeGeneration: number;
    readonly error?: unknown;
  };

export function providerEventIdentity(message: SDKMessage): ProviderEventIdentity {
  return {
    providerEventId: "uuid" in message && typeof message.uuid === "string" ? message.uuid : null,
    providerEventType: message.type === "system" ? `system/${message.subtype}` : message.type,
  };
}

export function normalizeProviderMessage(
  runtimeGeneration: number,
  message: SDKMessage,
): ProviderMessageFact {
  const envelope = {
    runtimeGeneration,
    ...providerEventIdentity(message),
  };
  return message.type === "result"
    ? { ...envelope, kind: "terminal", message }
    : { ...envelope, kind: "message", message };
}

function isGoalMcpToolBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const value = block as { type?: unknown; name?: unknown };
  return ["tool_use", "server_tool_use", "mcp_tool_use"].includes(String(value.type))
    && typeof value.name === "string"
    && value.name.startsWith("mcp__ccodex_goal__");
}

export function assistantHasTools(message: Extract<SDKMessage, { type: "assistant" }>): boolean {
  return Array.isArray(message.message.content) && message.message.content.some((block) =>
    !isGoalMcpToolBlock(block)
      && (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use"),
  );
}

export interface ToolResult {
  readonly toolUseId: string;
  readonly output: string;
  readonly isError: boolean;
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const candidate = block as Record<string, unknown>;
    return typeof candidate.text === "string" ? [candidate.text] : [];
  }).join("\n");
}

export function toolResults(message: SDKMessage): ToolResult[] {
  if (message.type !== "user" || !Array.isArray(message.message.content)) return [];
  return message.message.content.flatMap((block) => {
    if (!block || typeof block !== "object" || block.type !== "tool_result") return [];
    return [{ toolUseId: block.tool_use_id, output: outputText(block.content), isError: block.is_error === true }];
  });
}

export function backgroundTaskId(message: SDKMessage): string | undefined {
  if (message.type !== "user") return undefined;
  const value = message.tool_use_result;
  if (!value || typeof value !== "object") return undefined;
  const id = (value as Record<string, unknown>).backgroundTaskId;
  return typeof id === "string" ? id : undefined;
}

export function backgroundOutputFile(output: string): string | undefined {
  return /Output is being written to: (.+?)(?:\. You will|$)/s.exec(output)?.[1]?.trim();
}

export function serverToolResult(value: unknown): ToolResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const block = value as Record<string, unknown>;
  if (typeof block.type !== "string" || !block.type.endsWith("_tool_result") || typeof block.tool_use_id !== "string") return undefined;
  const content = block.content;
  const errorType = content && typeof content === "object" && !Array.isArray(content)
    ? (content as Record<string, unknown>).type
    : undefined;
  return {
    toolUseId: block.tool_use_id,
    output: typeof content === "string" ? content : content === undefined ? "" : JSON.stringify(content),
    isError: typeof errorType === "string" && errorType.endsWith("_error"),
  };
}

export function isNoQueryAcknowledgement(message: Extract<SDKMessage, { type: "result" }>): boolean {
  return message.subtype === "success"
    && message.is_error === false
    && message.num_turns === 0
    && message.result === ""
    && message.stop_reason === null;
}
