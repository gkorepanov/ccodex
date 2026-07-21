import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadListParams } from "../codex/generated/v2/ThreadListParams.js";
import type { ThreadSourceKind } from "../codex/generated/v2/ThreadSourceKind.js";
import { invalidParams } from "../protocol/errors.js";

function sourceKind(thread: Thread): ThreadSourceKind {
  if (typeof thread.source === "string") return thread.source;
  if ("custom" in thread.source) return "unknown";
  const source = thread.source.subAgent;
  if (source === "review") return "subAgentReview";
  if (source === "compact") return "subAgentCompact";
  if (typeof source === "object" && "thread_spawn" in source) return "subAgentThreadSpawn";
  return "subAgentOther";
}

export function filterSortThreads(threads: Thread[], params: ThreadListParams): Thread[] {
  if (params.parentThreadId && params.ancestorThreadId) throw invalidParams("parentThreadId and ancestorThreadId are mutually exclusive.");
  const cwd = params.cwd == null ? undefined : new Set(Array.isArray(params.cwd) ? params.cwd : [params.cwd]);
  const providers = params.modelProviders?.length ? new Set(params.modelProviders) : undefined;
  const sources = params.sourceKinds?.length ? new Set(params.sourceKinds) : undefined;
  const search = params.searchTerm?.toLocaleLowerCase();
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const isDescendant = (thread: Thread): boolean => {
    let parent = thread.parentThreadId;
    while (parent) {
      if (parent === params.ancestorThreadId) return true;
      parent = byId.get(parent)?.parentThreadId ?? null;
    }
    return false;
  };
  const key = params.sortKey === "updated_at" ? "updatedAt" : params.sortKey === "recency_at" ? "recencyAt" : "createdAt";
  const direction = params.sortDirection === "asc" ? 1 : -1;
  return threads
    .filter((thread) => !providers || providers.has(thread.modelProvider))
    .filter((thread) => !sources || sources.has(sourceKind(thread)))
    .filter((thread) => !cwd || cwd.has(thread.cwd))
    .filter((thread) => !search || `${thread.name ?? ""}\n${thread.preview}`.toLocaleLowerCase().includes(search))
    .filter((thread) => !params.parentThreadId || thread.parentThreadId === params.parentThreadId)
    .filter((thread) => !params.ancestorThreadId || isDescendant(thread))
    .sort((left, right) => ((((left[key] ?? 0) - (right[key] ?? 0)) || left.id.localeCompare(right.id)) * direction));
}
