import { describe, expect, it } from "vitest";
import type { SkillsListResponse } from "../../src/codex/generated/v2/SkillsListResponse.js";
import { providerSkillsList } from "../../src/gateway/skillList.js";

const cwd = "/workspace";
const stockResult: SkillsListResponse = {
  data: [{
    cwd,
    skills: [{ name: "pdf", description: "PDF", path: "/stock/pdf/SKILL.md", scope: "system", enabled: true }],
    errors: [],
  }],
};
const claudeResult: SkillsListResponse = {
  data: [{
    cwd,
    skills: [{
      name: "claude:dataviz",
      description: "Charts",
      path: "/claude/dataviz/SKILL.md",
      scope: "user",
      enabled: true,
    }],
    errors: [],
  }],
};

describe("providerSkillsList", () => {
  it("keeps stock threads stock-only and Claude threads Claude-only", async () => {
    const stockCalls: unknown[] = [];
    const claudeCalls: unknown[] = [];
    const stock = { request: async (_method: string, params: unknown) => {
      stockCalls.push(params);
      return stockResult;
    } };
    const claude = { list: async (...args: unknown[]) => {
      claudeCalls.push(args);
      return claudeResult;
    } };

    expect(await providerSkillsList({ cwds: [cwd] }, stock, claude, "codex")).toEqual(stockResult);
    expect(claudeCalls).toEqual([]);
    expect(await providerSkillsList({ cwds: [cwd], forceReload: true }, stock, claude, "claude")).toEqual(claudeResult);
    expect(stockCalls).toHaveLength(1);
    expect(claudeCalls).toEqual([[[cwd], true]]);
  });

  it("merges namespaced Claude skills into the new-chat catalog", async () => {
    const result = await providerSkillsList(
      { cwds: [cwd] },
      { request: async () => stockResult },
      { list: async () => claudeResult },
      undefined,
    );
    expect(result.data[0]?.skills.map((skill) => skill.name)).toEqual(["pdf", "claude:dataviz"]);
  });

  it("uses the foreground Claude cwd when App omits cwds", async () => {
    let stockCalled = false;
    const result = await providerSkillsList(
      {},
      { request: async () => {
        stockCalled = true;
        return stockResult;
      } },
      { list: async (cwds) => {
        expect(cwds).toEqual([cwd]);
        return claudeResult;
      } },
      "claude",
      cwd,
    );
    expect(result).toEqual(claudeResult);
    expect(stockCalled).toBe(false);
  });
});
