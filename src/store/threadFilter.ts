import type { Thread } from "../codex/generated/v2/Thread.js";
import type { ThreadListParams } from "../codex/generated/v2/ThreadListParams.js";
import type { ThreadSourceKind } from "../codex/generated/v2/ThreadSourceKind.js";
import { invalidParams } from "../protocol/errors.js";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export function cwdIdentity(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function sourceKind(thread: Thread): ThreadSourceKind {
  if (typeof thread.source === "string") return thread.source;
  if (thread.source == null) return "unknown";
  if ("custom" in thread.source) return "unknown";
  const source = thread.source.subAgent;
  if (source === "review") return "subAgentReview";
  if (source === "compact") return "subAgentCompact";
  if (typeof source === "object" && "thread_spawn" in source) return "subAgentThreadSpawn";
  return "subAgentOther";
}

export function filterSortThreads(threads: Thread[], params: ThreadListParams): Thread[] {
  if (params.parentThreadId && params.ancestorThreadId) throw invalidParams("parentThreadId and ancestorThreadId are mutually exclusive.");
  const cwd = params.cwd == null ? undefined : new Set(
    (Array.isArray(params.cwd) ? params.cwd : [params.cwd]).map(cwdIdentity),
  );
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
  // Stock's manual within-section order is server-internal and invisible to the
  // merged catalog, so section_position approximates it by section entry time.
  const key = params.sortKey === "updated_at" ? "updatedAt"
    : params.sortKey === "recency_at" ? "recencyAt"
    : params.sortKey === "section_position" ? "sectionEnteredAt"
    : "createdAt";
  const direction = params.sortDirection === "asc" ? 1 : -1;
  return threads
    .filter((thread) => !providers || providers.has(thread.modelProvider))
    .filter((thread) => !sources || sources.has(sourceKind(thread)))
    // Tri-state: omitted = all, null = unsectioned only, id = one section.
    .filter((thread) => params.sectionId === undefined
      || (thread.section?.id ?? null) === params.sectionId)
    .filter((thread) => params.projectId === undefined
      || (thread.projectId ?? null) === params.projectId)
    .filter((thread) => !cwd || cwd.has(cwdIdentity(thread.cwd)))
    .filter((thread) => !search || `${thread.name ?? ""}\n${thread.preview}`.toLocaleLowerCase().includes(search))
    .filter((thread) => !params.parentThreadId || thread.parentThreadId === params.parentThreadId)
    .filter((thread) => !params.ancestorThreadId || isDescendant(thread))
    .sort((left, right) => ((((left[key] ?? 0) - (right[key] ?? 0)) || left.id.localeCompare(right.id)) * direction));
}
