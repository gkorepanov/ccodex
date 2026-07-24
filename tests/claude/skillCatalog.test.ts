import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_SKILL_CACHE_MS, ClaudeSkillCatalog } from "../../src/claude/skillCatalog.js";
import type { HybridConfig } from "../../src/config/config.js";
import { Logger } from "../../src/observability/logger.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(dataDir: string): HybridConfig {
  return {
    realCodex: "/bin/false",
    claudeBinary: "/bin/claude",
    dataDir,
    publicSocket: join(dataDir, "gateway.sock"),
    modelPrefix: "claude:",
    idleTimeoutSeconds: 900,
    modelCacheSeconds: 300,
    logLevel: "error",
    logPrompts: false,
    debugCapture: false,
    debugLogMaxBytes: 1_048_576,
  };
}

describe("ClaudeSkillCatalog", () => {
  it("loads SDK skills once per canonical cwd for five minutes", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccodex-skills-"));
    roots.push(root);
    let now = 1_000;
    let loads = 0;
    let closed = 0;
    const catalog = new ClaudeSkillCatalog(
      config(root),
      new Logger("error"),
      (input) => {
        expect(input.options.cwd).toBe(realpathSync(root));
        loads += 1;
        return {
          initializationResult: async () => ({}),
          reloadSkills: async () => ({
            skills: [{
              name: "dataviz",
              description: "Build a chart.",
              argumentHint: "<dataset>",
              aliases: ["plot"],
            }],
          }),
          close: () => { closed += 1; },
        } as unknown as Query;
      },
      () => now,
    );

    const first = await catalog.list([join(root, ".")]);
    expect(first.data[0]).toMatchObject({
      cwd: root,
      skills: [{
        name: "claude:dataviz",
        description: "Build a chart. Arguments: <dataset>",
        path: join(root, "virtual", "claude-skills", "dataviz", "SKILL.md"),
        scope: "user",
        enabled: true,
      }],
      errors: [],
    });
    await catalog.list([root]);
    expect(loads).toBe(1);
    expect(closed).toBe(1);

    now += CLAUDE_SKILL_CACHE_MS;
    await catalog.list([root]);
    expect(loads).toBe(2);
  });

  it("supports explicit and commands-changed invalidation", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccodex-skills-invalidate-"));
    roots.push(root);
    let loads = 0;
    const catalog = new ClaudeSkillCatalog(config(root), new Logger("error"), () => ({
      initializationResult: async () => ({}),
      reloadSkills: async () => ({ skills: [{ name: `skill-${++loads}`, description: "", argumentHint: "" }] }),
      close: () => undefined,
    }) as unknown as Query);

    expect((await catalog.list([root])).data[0]?.skills[0]?.name).toBe("claude:skill-1");
    expect((await catalog.list([root], true)).data[0]?.skills[0]?.name).toBe("claude:skill-2");
    catalog.invalidate(root);
    expect((await catalog.list([root])).data[0]?.skills[0]?.name).toBe("claude:skill-3");
  });

  it("also caches discovery failures until force reload", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccodex-skills-error-"));
    roots.push(root);
    let loads = 0;
    const catalog = new ClaudeSkillCatalog(config(root), new Logger("error"), () => ({
      initializationResult: async () => {
        loads += 1;
        throw new Error("Claude is not authenticated");
      },
      reloadSkills: async () => ({ skills: [] }),
      close: () => undefined,
    }) as unknown as Query);

    expect((await catalog.list([root])).data[0]?.errors[0]?.message).toContain("not authenticated");
    await catalog.list([root]);
    expect(loads).toBe(1);
    await catalog.list([root], true);
    expect(loads).toBe(2);
  });
});
