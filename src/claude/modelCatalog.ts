import { query, type ModelInfo, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Model } from "../codex/generated/v2/Model.js";
import type { HybridConfig } from "../config/config.js";
import type { Logger } from "../observability/logger.js";
import { MetricsRegistry } from "../observability/metrics.js";
import { modelCatalogValue } from "./modelSelection.js";
import { claudeEnvironment } from "./environment.js";

const effortDescriptions: Record<string, string> = {
  low: "Faster responses with less reasoning.",
  medium: "Balanced reasoning effort.",
  high: "Deep reasoning for complex work.",
  xhigh: "Extra-high reasoning effort.",
  max: "Maximum available reasoning effort.",
};

const requiredControls = ["initializationResult", "supportedModels", "reinitialize", "interrupt", "setModel", "close"] as const;

export function assertClaudeControlSurface(value: unknown): asserts value is Query {
  if (!value || typeof value !== "object") throw new Error("Claude SDK query did not return a control object.");
  const missing = requiredControls.filter((method) => typeof (value as Record<string, unknown>)[method] !== "function");
  if (missing.length > 0) throw new Error(`Claude SDK query is missing required controls: ${missing.join(", ")}.`);
}

function defaultEffort(levels: readonly string[]): string {
  if (levels.includes("high")) return "high";
  if (levels.includes("medium")) return "medium";
  return levels[0] ?? "medium";
}

export function mapClaudeModel(model: ModelInfo, prefix: string): Model {
  const efforts = model.supportsEffort ? (model.supportedEffortLevels ?? []) : [];
  const serviceTiers = model.supportsFastMode
    ? [
        { id: "default", name: "Default", description: "Standard Claude execution." },
        { id: "fast", name: "Fast", description: "Claude fast mode." },
      ]
    : [];
  const id = `${prefix}${modelCatalogValue(model)}`;
  return {
    id,
    model: id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: model.displayName,
    description: model.description,
    hidden: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: effortDescriptions[reasoningEffort] ?? `${reasoningEffort} reasoning effort.`,
    })),
    defaultReasoningEffort: defaultEffort(efforts),
    inputModalities: ["text", "image"],
    supportsPersonality: true,
    additionalSpeedTiers: [],
    serviceTiers,
    defaultServiceTier: serviceTiers.length > 0 ? "default" : null,
    isDefault: false,
  };
}

async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

export class ClaudeModelCatalog {
  private cache: { readonly key: string; readonly expiresAt: number; readonly models: Model[] } | undefined;
  private loading: Promise<Model[]> | undefined;

  public constructor(
    private readonly config: HybridConfig,
    private readonly logger: Logger,
    private readonly metrics: MetricsRegistry = new MetricsRegistry(),
  ) {}

  public async list(): Promise<Model[]> {
    const key = this.cacheKey();
    if (this.cache && this.cache.key === key && this.cache.expiresAt > Date.now()) return this.cache.models;
    if (this.cache?.key !== key) this.cache = undefined;
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  public invalidate(): void {
    this.cache = undefined;
  }

  private async load(): Promise<Model[]> {
    const abort = new AbortController();
    const sdkQuery = query({
      prompt: idlePrompt(abort.signal),
      options: {
        pathToClaudeCodeExecutable: this.config.claudeBinary,
        persistSession: false,
        abortController: abort,
        allowedTools: [],
        settingSources: ["user", "project", "local"],
        env: claudeEnvironment(),
        stderr: (line) => this.logger.debug("claude.model-probe.stderr", { output: line }),
      },
    });

    try {
      assertClaudeControlSurface(sdkQuery);
      const [, models] = await Promise.race([
        Promise.all([sdkQuery.initializationResult(), sdkQuery.supportedModels()]),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Claude model probe timed out.")), 10_000),
        ),
      ]);
      await sdkQuery.reinitialize();
      await sdkQuery.interrupt();
      const mapped = models.map((model) => mapClaudeModel(model, this.config.modelPrefix));
      this.cache = {
        key: this.cacheKey(),
        expiresAt: Date.now() + this.config.modelCacheSeconds * 1_000,
        models: mapped,
      };
      this.logger.info("claude.models.loaded", { count: mapped.length, controls: requiredControls });
      return mapped;
    } catch (error) {
      this.metrics.modelProbeFailed();
      throw error;
    } finally {
      abort.abort();
    }
  }

  private cacheKey(): string {
    const binary = existsSync(this.config.claudeBinary) ? realpathSync(this.config.claudeBinary) : this.config.claudeBinary;
    const identity = existsSync(binary) ? statSync(binary) : undefined;
    const environment = [
      "HOME", "CLAUDE_CONFIG_DIR", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
    ].map((name) => [name, process.env[name] ?? null]);
    return createHash("sha256").update(JSON.stringify({
      binary, size: identity?.size ?? null, mtimeMs: identity?.mtimeMs ?? null, environment,
    })).digest("hex");
  }
}
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
