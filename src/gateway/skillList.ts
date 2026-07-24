import type { SkillsListParams } from "../codex/generated/v2/SkillsListParams.js";
import type { SkillsListResponse } from "../codex/generated/v2/SkillsListResponse.js";
import type { ClaudeSkillCatalog } from "../claude/skillCatalog.js";
import type { StockRpc } from "./stockRpc.js";

type SkillsProvider = "codex" | "claude" | undefined;
type SkillCatalog = Pick<ClaudeSkillCatalog, "list">;
type StockSkillsRpc = Pick<StockRpc, "request">;

function mergeSkills(stock: SkillsListResponse, claude: SkillsListResponse): SkillsListResponse {
  const byCwd = new Map(claude.data.map((entry) => [entry.cwd, entry]));
  const data = stock.data.map((entry) => {
    const addition = byCwd.get(entry.cwd);
    byCwd.delete(entry.cwd);
    return addition
      ? { ...entry, skills: [...entry.skills, ...addition.skills], errors: [...entry.errors, ...addition.errors] }
      : entry;
  });
  data.push(...byCwd.values());
  return { data };
}

export async function providerSkillsList(
  params: SkillsListParams,
  stock: StockSkillsRpc,
  claude: SkillCatalog,
  provider: SkillsProvider,
  defaultClaudeCwd?: string,
): Promise<SkillsListResponse> {
  if (provider === "codex") return stock.request("skills/list", params) as Promise<SkillsListResponse>;

  const requestedCwds = params.cwds?.length ? params.cwds : defaultClaudeCwd ? [defaultClaudeCwd] : undefined;
  if (provider === "claude" && requestedCwds) return claude.list(requestedCwds, params.forceReload);

  const stockResult = await stock.request("skills/list", params) as SkillsListResponse;
  const cwds = requestedCwds ?? stockResult.data.map((entry) => entry.cwd);
  const claudeResult = await claude.list(cwds, params.forceReload);
  return provider === "claude" ? claudeResult : mergeSkills(stockResult, claudeResult);
}
