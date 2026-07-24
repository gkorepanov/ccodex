import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Query, SDKUserMessage, SlashCommand } from "@anthropic-ai/claude-agent-sdk";
import type { SkillsListEntry } from "../codex/generated/v2/SkillsListEntry.js";
import type { SkillsListResponse } from "../codex/generated/v2/SkillsListResponse.js";
import type { HybridConfig } from "../config/config.js";
import type { Logger } from "../observability/logger.js";
import { claudeEnvironment } from "./environment.js";
import { createClaudeQuery, type ClaudeQueryFactory } from "./queryFactory.js";

export const CLAUDE_SKILL_CACHE_MS = 5 * 60_000;

async function* idlePrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  if (signal.aborted) return;
  await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
}

function canonicalCwd(cwd: string): string {
  const absolute = resolve(cwd);
  return existsSync(absolute) ? realpathSync(absolute) : absolute;
}

function skillDescription(skill: SlashCommand): string {
  return skill.argumentHint ? `${skill.description} Arguments: ${skill.argumentHint}` : skill.description;
}

function mapSkill(config: HybridConfig, skill: SlashCommand) {
  return {
    name: `claude:${skill.name}`,
    description: skillDescription(skill),
    path: join(config.dataDir, "virtual", "claude-skills", encodeURIComponent(skill.name), "SKILL.md"),
    scope: "user" as const,
    enabled: true,
  };
}

function assertSkillControls(query: Query): void {
  for (const method of ["initializationResult", "reloadSkills", "close"] as const) {
    if (typeof query[method] !== "function") {
      throw new Error(`Claude SDK query is missing required skill control '${method}'.`);
    }
  }
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Claude skill discovery timed out.")), 10_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class ClaudeSkillCatalog {
  private readonly cache = new Map<string, { readonly expiresAt: number; readonly entry: SkillsListEntry }>();
  private readonly loading = new Map<string, Promise<SkillsListEntry>>();

  public constructor(
    private readonly config: HybridConfig,
    private readonly logger: Logger,
    private readonly queryFactory: ClaudeQueryFactory = createClaudeQuery,
    private readonly now: () => number = Date.now,
  ) {}

  public async list(cwds: readonly string[], forceReload = false): Promise<SkillsListResponse> {
    const data = await Promise.all(cwds.map(async (cwd) => ({
      ...await this.entry(canonicalCwd(cwd), forceReload),
      cwd,
    })));
    return { data };
  }

  public invalidate(cwd?: string): void {
    if (cwd === undefined) this.cache.clear();
    else this.cache.delete(canonicalCwd(cwd));
  }

  private async entry(cwd: string, forceReload: boolean): Promise<SkillsListEntry> {
    if (forceReload) this.cache.delete(cwd);
    const cached = this.cache.get(cwd);
    if (cached && cached.expiresAt > this.now()) return cached.entry;
    const current = this.loading.get(cwd);
    if (current) return current;
    const loading = this.load(cwd).then((entry) => {
      this.cache.set(cwd, { expiresAt: this.now() + CLAUDE_SKILL_CACHE_MS, entry });
      return entry;
    }).finally(() => this.loading.delete(cwd));
    this.loading.set(cwd, loading);
    return loading;
  }

  private async load(cwd: string): Promise<SkillsListEntry> {
    const abort = new AbortController();
    let sdkQuery: Query | undefined;
    try {
      sdkQuery = this.queryFactory({
        prompt: idlePrompt(abort.signal),
        options: {
          cwd,
          pathToClaudeCodeExecutable: this.config.claudeBinary,
          persistSession: false,
          abortController: abort,
          allowedTools: [],
          settingSources: ["user", "project", "local"],
          env: claudeEnvironment(),
          stderr: (line) => this.logger.debug("claude.skills.stderr", { cwd, output: line }),
        },
      });
      assertSkillControls(sdkQuery);
      const response = await withTimeout(
        sdkQuery.initializationResult().then(() => sdkQuery!.reloadSkills()),
      );
      const entry = { cwd, skills: response.skills.map((skill) => mapSkill(this.config, skill)), errors: [] };
      this.logger.info("claude.skills.loaded", { cwd, count: entry.skills.length });
      return entry;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn("claude.skills.unavailable", { cwd, error: message });
      return { cwd, skills: [], errors: [{ path: cwd, message }] };
    } finally {
      abort.abort();
      sdkQuery?.close();
    }
  }
}
