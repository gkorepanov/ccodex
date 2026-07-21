import type { ElicitationRequest } from "@anthropic-ai/claude-agent-sdk";

export const sdkMessageAliases = [
  "SDKAssistantMessage",
  "SDKUserMessage",
  "SDKUserMessageReplay",
  "SDKResultMessage",
  "SDKSystemMessage",
  "SDKPartialAssistantMessage",
  "SDKCompactBoundaryMessage",
  "SDKStatusMessage",
  "SDKAPIRetryMessage",
  "SDKControlRequestProgressMessage",
  "SDKModelRefusalFallbackMessage",
  "SDKModelRefusalNoFallbackMessage",
  "SDKLocalCommandOutputMessage",
  "SDKHookStartedMessage",
  "SDKHookProgressMessage",
  "SDKHookResponseMessage",
  "SDKPluginInstallMessage",
  "SDKToolProgressMessage",
  "SDKAuthStatusMessage",
  "SDKTaskNotificationMessage",
  "SDKTaskStartedMessage",
  "SDKTaskUpdatedMessage",
  "SDKTaskProgressMessage",
  "SDKBackgroundTasksChangedMessage",
  "SDKThinkingTokensMessage",
  "SDKSessionStateChangedMessage",
  "SDKWorkerShuttingDownMessage",
  "SDKCommandsChangedMessage",
  "SDKNotificationMessage",
  "SDKFilesPersistedEvent",
  "SDKToolUseSummaryMessage",
  "SDKMemoryRecallMessage",
  "SDKRateLimitEvent",
  "SDKElicitationCompleteMessage",
  "SDKPermissionDeniedMessage",
  "SDKPromptSuggestionMessage",
  "SDKMirrorErrorMessage",
  "SDKInformationalMessage",
  "SDKConversationResetMessage",
] as const;

export const adapterSamples = {
  toolMappings: [
    {
      block: { type: "server_tool_use", id: "web", name: "web_search", input: { query: "protocol" } },
      expected: {
        type: "webSearch", query: "protocol",
        action: { type: "search", query: "protocol", queries: null },
      },
    },
    {
      block: { type: "server_tool_use", id: "fetch", name: "web_fetch", input: { url: "https://example.com" } },
      expected: {
        type: "webSearch", query: "https://example.com",
        action: { type: "openPage", url: "https://example.com" },
      },
    },
    {
      block: { type: "tool_use", id: "image", name: "Read", input: { file_path: "/workspace/chart.png" } },
      expected: {
        type: "commandExecution", command: "Read /workspace/chart.png",
        commandActions: [{ type: "read", name: "chart.png", path: "/workspace/chart.png" }],
      },
    },
    {
      block: { type: "mcp_tool_use", id: "mcp", name: "mcp__github__search_code", input: { q: "needle" } },
      expected: { type: "mcpToolCall", server: "github", tool: "search_code", arguments: { q: "needle" } },
    },
  ],
  askUser: {
    input: {
      questions: [{
        header: "Choice", question: "Pick one",
        options: [{ label: "A", description: "First" }],
      }],
    },
    expectedMethod: "item/tool/requestUserInput",
    response: { answers: { "Pick one": { answers: ["A"] } } },
    expectedAnswers: { "Pick one": "A" },
  },
  mcpElicitation: {
    request: {
      mode: "form", serverName: "test-server", message: "Provide a value",
      requestedSchema: { type: "object", properties: { value: { type: "string" } } },
      elicitationId: "test-elicitation",
    } as ElicitationRequest,
    expectedMethod: "mcpServer/elicitation/request",
    response: { action: "accept", content: { value: "ok" } },
    expectedResult: { action: "accept", content: { value: "ok" } },
  },
} as const;

const window = (utilization: number, resets_at: string) => ({
  utilization, resets_at, limit_dollars: null, used_dollars: null, remaining_dollars: null,
});

export const usageSamples = {
  stable: {
    session: {
      total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0,
      total_lines_added: 0, total_lines_removed: 0, model_usage: {},
    },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: window(16, "2026-07-16T23:30:00Z"),
      seven_day: window(11, "2026-07-19T03:00:00Z"),
      seven_day_opus: null,
      seven_day_sonnet: null,
      model_scoped: [{ display_name: "Fable", utilization: 18, resets_at: "2026-07-19T03:00:00Z" }],
    },
  },
  additive: {
    session: {
      total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0,
      total_lines_added: 0, total_lines_removed: 0, model_usage: {},
    },
    subscription_type: "max",
    rate_limits_available: true,
    rate_limits: {
      five_hour: window(5, "2026-07-17T11:20:00Z"),
      seven_day: window(11, "2026-07-19T03:00:00Z"),
      seven_day_oauth_apps: null,
      seven_day_opus: null,
      seven_day_sonnet: null,
      seven_day_cowork: null,
      extra_usage: {
        is_enabled: false, monthly_limit: null, used_credits: null, utilization: null,
        currency: null, decimal_places: null, disabled_reason: null, daily: null, weekly: null,
      },
      limits: [
        {
          kind: "session", group: "session", percent: 5, severity: "normal",
          resets_at: "2026-07-17T11:20:00Z", scope: null, is_active: false,
        },
        {
          kind: "weekly_all", group: "weekly", percent: 11, severity: "normal",
          resets_at: "2026-07-19T03:00:00Z", scope: null, is_active: false,
        },
        {
          kind: "weekly_scoped", group: "weekly", percent: 20, severity: "normal",
          resets_at: "2026-07-19T03:00:00Z",
          scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true,
        },
      ],
      spend: {
        used: { amount_minor: 0, currency: "USD", exponent: 2 }, limit: null, percent: 0,
        severity: "normal", enabled: false, disabled_reason: null, cap: null, balance: null,
        auto_reload: null, disclaimer: "", can_purchase_credits: false, can_toggle: false,
      },
      member_dashboard_available: false,
      model_scoped: [{ display_name: "Fable", utilization: 20, resets_at: "2026-07-19T03:00:00Z" }],
    },
  },
} as const;

export const fullAccessProjection = {
  start: {
    model: "claude:sonnet", approvalPolicy: "never", approvalsReviewer: "user",
    sandbox: "danger-full-access", ephemeral: false,
  },
  expectedProfile: { id: ":danger-full-access", extends: null },
  settingsUpdate: { effort: "high" },
  resume: { excludeTurns: true },
} as const;

export const deferredSettingsUpdate = {
  model: "claude:claude-fable-5",
  effort: "high",
  multiAgentMode: "explicitRequestOnly",
} as const;

export const stopLifecycleSample = {
  methods: [
    "thread/backgroundTerminals/clean", "turn/interrupt", "turn/completed",
    "thread/status/changed", "turn/started", "item/started", "turn/interrupt",
  ],
  lateChildTaskId: "synthetic-child-task",
} as const;
