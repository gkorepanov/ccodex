import {
  type CanUseTool,
  type ElicitationRequest,
  type ElicitationResult,
  type HookInput,
  type HookJSONOutput,
  type McpSdkServerConfigWithInstance,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import type { Logger } from "../../observability/logger.js";
import type { ClaudeQueryFactory } from "../queryFactory.js";
import { invalidParams } from "../../protocol/errors.js";
import { normalizeClaudeModelIdentifier } from "../modelSelection.js";
import { claudeEnvironment } from "../environment.js";
import {
  ProviderRuntime,
  type ProviderRuntimeFact,
  type ProviderRuntimeSettings,
} from "./providerRuntime.js";
import type { RuntimeTransportSettings } from "./commands.js";
export type { RuntimeTransportSettings } from "./commands.js";

export interface GoalRuntimeEvents {
  readonly mcpServer: McpSdkServerConfigWithInstance;
}

export interface ProviderRuntimeCallbacks {
  readonly canUseTool: CanUseTool;
  readonly onElicitation: (request: ElicitationRequest, signal: AbortSignal) => Promise<ElicitationResult>;
  readonly beforeToolUse: (input: HookInput, toolUseId: string | undefined) => Promise<HookJSONOutput>;
  readonly captureFileAfter: (input: HookInput, toolUseId: string | undefined) => Promise<HookJSONOutput>;
  readonly afterCompact: (input: HookInput) => Promise<HookJSONOutput>;
}

const unsupportedProviderReviewTools = ["SendFeedback", "ProposeSkills"];

export class StaleClaudeRuntimeSettingsError extends Error {
  public constructor(
    message: string,
    public readonly reason: "runtime" | "settings",
    public readonly settings: RuntimeTransportSettings,
  ) {
    super(message);
  }
}

function appendInstructions(startup: RuntimeStartup): string | undefined {
  const parts = [startup.baseInstructions, startup.developerInstructions];
  if (startup.personality === "friendly") parts.push("Use a friendly, collaborative communication style.");
  if (startup.personality === "pragmatic") parts.push("Be direct, pragmatic, and focused on concrete outcomes.");
  const value = parts.filter((part): part is string => Boolean(part)).join("\n\n");
  return value || undefined;
}

function effort(value: string | null | undefined): Options["effort"] {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max"
    ? value
    : undefined;
}

export function providerPermissionMode(
  settings: RuntimeTransportSettings,
): NonNullable<Options["permissionMode"]> {
  if (settings.approvalsReviewer !== "user") return "auto";
  const sandbox = settings.sandboxPolicy && typeof settings.sandboxPolicy === "object" && "type" in settings.sandboxPolicy
    ? settings.sandboxPolicy as { type: unknown }
    : undefined;
  if (settings.approvalPolicy === "never" && sandbox?.type === "dangerFullAccess") return "bypassPermissions";
  if (settings.approvalPolicy === "never") return "dontAsk";
  return "default";
}

export function runtimeTransportSettings(startup: RuntimeStartup): RuntimeTransportSettings {
  return {
    cwd: startup.cwd,
    model: startup.model,
    settingsGeneration: startup.settingsGeneration,
    approvalPolicy: startup.approvalPolicy,
    approvalsReviewer: startup.approvalsReviewer,
    sandboxPolicy: startup.sandboxPolicy,
    serviceTier: startup.serviceTier,
    reasoningEffort: startup.reasoningEffort,
    reasoningSummary: startup.reasoningSummary,
    collaborationMode: startup.collaborationMode,
  };
}

export function providerRuntimeSettings(
  settings: RuntimeTransportSettings,
): ProviderRuntimeSettings {
  const selectedEffort = effort(settings.reasoningEffort);
  return {
    model: normalizeClaudeModelIdentifier(settings.model),
    permissionMode: providerPermissionMode(settings),
    effort: selectedEffort ?? null,
    fastMode: settings.serviceTier === "fast",
    thinkingDisplay: settings.reasoningSummary === "none"
      ? "omitted"
      : settings.reasoningSummary ? "summarized" : null,
  };
}

function claudeOutputSchema(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { $schema: _dialect, ...schema } = value as Record<string, unknown>;
  return schema;
}

export interface RuntimeStartup {
  readonly threadId: string;
  readonly runtimeGeneration: number;
  readonly providerSessionId: string;
  readonly resume: boolean;
  readonly cwd: string;
  readonly ephemeral: boolean;
  readonly persistSession: boolean;
  readonly claudeBinary: string;
  readonly model: string;
  readonly settingsGeneration: number;
  readonly lastCompletedTurnId: string | null;
  readonly modelContextWindow: number | null;
  readonly approvalPolicy: unknown;
  readonly approvalsReviewer: string;
  readonly sandboxPolicy: unknown;
  readonly baseInstructions: string | null;
  readonly developerInstructions: string | null;
  readonly personality: string | null;
  readonly serviceTier: string | null;
  readonly reasoningEffort: string | null;
  readonly reasoningSummary: string | null;
  readonly collaborationMode: unknown | null;
  readonly outputSchema: unknown | null;
  readonly interactiveQuestions: boolean;
}

export function createProviderRuntime(
  startup: RuntimeStartup,
  logger: Logger,
  queryFactory: ClaudeQueryFactory,
  submitFact: (fact: ProviderRuntimeFact) => Promise<void>,
  callbacks: ProviderRuntimeCallbacks,
  goalEvents?: GoalRuntimeEvents,
): ProviderRuntime {
  const transportSettings = runtimeTransportSettings(startup);
  const append = appendInstructions(startup);
  const selectedPermissionMode = providerPermissionMode(transportSettings);
  const selectedEffort = effort(startup.reasoningEffort);
  if (startup.reasoningEffort && !selectedEffort) throw new Error(`Unsupported Claude effort '${startup.reasoningEffort}'.`);
  const outputSchema = claudeOutputSchema(startup.outputSchema);
  return new ProviderRuntime(
    startup.runtimeGeneration,
    {
        cwd: startup.cwd,
        model: normalizeClaudeModelIdentifier(startup.model),
        ...(startup.resume ? { resume: startup.providerSessionId } : { sessionId: startup.providerSessionId }),
        pathToClaudeCodeExecutable: startup.claudeBinary,
        persistSession: startup.persistSession,
        includePartialMessages: true,
        includeHookEvents: true,
        forwardSubagentText: true,
        disallowedTools: startup.interactiveQuestions
          ? unsupportedProviderReviewTools
          : [...unsupportedProviderReviewTools, "AskUserQuestion"],
        settingSources: ["user", "project", "local"],
        ...(goalEvents ? { mcpServers: { ccodex_goal: goalEvents.mcpServer } } : {}),
        systemPrompt: { type: "preset", preset: "claude_code", ...(append ? { append } : {}) },
        permissionMode: selectedPermissionMode,
        ...(startup.ephemeral || selectedPermissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        ...(!startup.interactiveQuestions && selectedPermissionMode === "auto" && !startup.ephemeral
          ? {}
          : {
              canUseTool: (
                name: Parameters<CanUseTool>[0],
                input: Parameters<CanUseTool>[1],
                options: Parameters<CanUseTool>[2],
              ) => callbacks.canUseTool(name, input, options),
            }),
        onElicitation: (request, options) => callbacks.onElicitation(request, options.signal),
        hooks: {
          PreToolUse: [{ hooks: [(input, toolUseId) => callbacks.beforeToolUse(input, toolUseId)] }],
          PostToolUse: [{ matcher: "Edit|Write|NotebookEdit", hooks: [(input, toolUseId) => callbacks.captureFileAfter(input, toolUseId)] }],
          PostToolUseFailure: [{ matcher: "Edit|Write|NotebookEdit", hooks: [(input, toolUseId) => callbacks.captureFileAfter(input, toolUseId)] }],
          PostCompact: [{ hooks: [(input) => callbacks.afterCompact(input)] }],
        },
        ...(startup.serviceTier === "fast" ? { settings: { fastMode: true } } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
        ...(startup.reasoningSummary === "none"
          ? { thinking: { type: "adaptive", display: "omitted" } as const }
          : startup.reasoningSummary
            ? { thinking: { type: "adaptive", display: "summarized" } as const }
            : {}),
        ...(outputSchema
          ? { outputFormat: { type: "json_schema", schema: outputSchema } as const }
          : {}),
        env: claudeEnvironment(),
        stderr: (line) => logger.debug("claude.stderr", { threadId: startup.threadId, output: line }),
    },
    queryFactory,
    submitFact,
  );
}
