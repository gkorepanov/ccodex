import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NativeMcpAccess } from "./claude/nativeAccess.js";

export type Provider = "codex" | "claude";

export interface Segment {
  readonly provider: Provider;
  readonly threadId: string;
  /** Last turn of this segment; null for the current (last) segment. */
  readonly lastTurnId: string | null;
}

export interface Plan {
  readonly permissionMode: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly plan: boolean;
}

export interface MetaData {
  /**
   * Threads that switched provider: public id → segments, oldest first. The public id is one of the segments
   * (the first one; for a fork taken in a later segment, the forked backend).
   */
  lineages: Record<string, Segment[]>;
  /** Archived Claude sessions (stock keeps its own archive flag). */
  archived: string[];
  /** Section membership of Claude threads (stock keeps its own). */
  sections: Record<string, { sectionId: string; enteredAt: number }>;
  /** Manual order inside a section, merged over stock and Claude threads (only once it was changed). */
  sectionOrder: Record<string, string[]>;
  /** Default model, effort and speed the App picked while its default model is a Claude one, by config key (never
   *  written to Codex's config.toml). */
  claudeDefaults?: Record<string, unknown> | null;
  /** Claude chats since plan mode, until a turn out of it: their permission mode, model and plan mode (Claude records
   *  only its plan mode, and plans a Haiku chat on Sonnet). */
  plans?: Record<string, Plan>;
  /** Paused goals of Claude chats: Claude's `/goal` has no pause, so pausing clears it there and keeps it here. */
  pausedGoals?: Record<string, { objective: string; createdAt: number; updatedAt: number }>;
  /** Original native access for Claude chats and provider switches; absent entries use stock defaults. */
  nativeMcpAccess?: Record<string, NativeMcpAccess>;
}

/**
 * `~/.ccodex/state/meta.json`: tiny, optional. Missing file or key = defaults. The gateway is the only
 * writer; each write goes to a temp file renamed over the original.
 */
export class Meta {
  private data: MetaData;
  private idRewrites = new Map<string, string>();
  private hiddenIds = new Set<string>();

  public constructor(private readonly path: string) {
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Partial<MetaData> : {};
    this.data = {
      lineages: raw.lineages ?? {}, archived: raw.archived ?? [], sections: raw.sections ?? {},
      sectionOrder: raw.sectionOrder ?? {}, claudeDefaults: raw.claudeDefaults ?? null, plans: raw.plans ?? {}, pausedGoals: raw.pausedGoals ?? {}, nativeMcpAccess: raw.nativeMcpAccess ?? {},
    };
    this.reindex();
  }

  public get lineages(): Readonly<Record<string, readonly Segment[]>> { return this.data.lineages; }

  public lineage(publicId: string): readonly Segment[] | undefined { return this.data.lineages[publicId]; }

  /** Backend id → public id: the current backend of each lineage. */
  public get rewrites(): ReadonlyMap<string, string> { return this.idRewrites; }

  /** Backend threads that only exist as a part of some lineage (never listed on their own). */
  public hidden(threadId: string): boolean { return this.hiddenIds.has(threadId); }

  public current(publicId: string): Segment | undefined { return this.data.lineages[publicId]?.at(-1); }

  /** The segment whose backend carries the lineage's row (name, preview, archive, section): the public id's own. */
  public row(publicId: string): Segment {
    return this.data.lineages[publicId]!.find((segment) => segment.threadId === publicId)!;
  }

  public setLineage(publicId: string, segments: Segment[]): void {
    this.data.lineages[publicId] = segments;
    this.reindex();
    this.save();
  }

  public deleteLineage(publicId: string): void {
    delete this.data.lineages[publicId];
    this.reindex();
    this.save();
  }

  /**
   * Drops finished segments whose backend is gone: Claude deletes transcripts after `cleanupPeriodDays`. A lineage
   * whose own segment went is listed under its oldest segment kept from then on.
   */
  public prune(exists: (segment: Segment) => boolean): void {
    let changed = false;
    for (const [publicId, segments] of Object.entries(this.data.lineages)) {
      const kept = segments.filter((segment, index) => index === segments.length - 1 || exists(segment));
      if (kept.length === segments.length) continue;
      changed = true;
      delete this.data.lineages[publicId];
      const id = kept.some((segment) => segment.threadId === publicId) ? publicId : kept[0]!.threadId;
      if (id !== publicId) this.rename(publicId, id);
      if (kept.length > 1 || kept[0]!.threadId !== id) this.data.lineages[id] = kept;
    }
    if (!changed) return;
    this.reindex();
    this.save();
  }

  public isArchived(threadId: string): boolean { return this.data.archived.includes(threadId); }

  public setArchived(threadId: string, archived: boolean): void {
    this.data.archived = this.data.archived.filter((id) => id !== threadId);
    if (archived) this.data.archived.push(threadId);
    this.save();
  }

  public section(threadId: string): { sectionId: string; enteredAt: number } | undefined {
    return this.data.sections[threadId];
  }

  public setSection(threadId: string, sectionId: string | null): void {
    if (sectionId) this.data.sections[threadId] = { sectionId, enteredAt: Math.floor(Date.now() / 1000) };
    else delete this.data.sections[threadId];
    this.save();
  }

  /** A deleted section's Claude threads go back to no section, as stock's own do. */
  public deleteSection(sectionId: string): void {
    for (const [threadId, entry] of Object.entries(this.data.sections)) if (entry.sectionId === sectionId) delete this.data.sections[threadId];
    delete this.data.sectionOrder[sectionId];
    this.save();
  }

  public sectionOrder(sectionId: string): readonly string[] { return this.data.sectionOrder[sectionId] ?? []; }

  public setSectionOrder(sectionId: string, ids: string[]): void {
    this.data.sectionOrder[sectionId] = ids;
    this.save();
  }

  public get claudeDefaults(): MetaData["claudeDefaults"] { return this.data.claudeDefaults; }

  public setClaudeDefaults(value: MetaData["claudeDefaults"]): void {
    this.data.claudeDefaults = value;
    this.save();
  }

  public plan(threadId: string): Plan | undefined { return this.data.plans![threadId]; }

  /** A Claude chat's settings from plan mode on; null once a turn out of plan mode records its own in the transcript. */
  public setPlan(threadId: string, plan: Plan | null): void {
    if (JSON.stringify(this.data.plans![threadId] ?? null) === JSON.stringify(plan)) return;
    if (plan) this.data.plans![threadId] = plan;
    else delete this.data.plans![threadId];
    this.save();
  }

  public pausedGoal(threadId: string): { objective: string; createdAt: number; updatedAt: number } | undefined {
    return this.data.pausedGoals![threadId];
  }

  public setPausedGoal(threadId: string, goal: { objective: string; createdAt: number; updatedAt: number } | null): void {
    if (!goal && !this.data.pausedGoals![threadId]) return;
    if (goal) this.data.pausedGoals![threadId] = goal;
    else delete this.data.pausedGoals![threadId];
    this.save();
  }

  public forget(threadId: string): void {
    this.data.archived = this.data.archived.filter((id) => id !== threadId);
    delete this.data.sections[threadId];
    delete this.data.plans![threadId];
    delete this.data.pausedGoals![threadId];
    delete this.data.nativeMcpAccess![threadId];
    this.save();
  }

  public nativeMcpAccess(threadId: string): NativeMcpAccess | undefined {
    return this.data.nativeMcpAccess![threadId];
  }

  public setNativeMcpAccess(threadId: string, access: NativeMcpAccess): void {
    if (JSON.stringify(this.data.nativeMcpAccess![threadId] ?? {}) === JSON.stringify(access)) return;
    this.data.nativeMcpAccess![threadId] = structuredClone(access);
    this.save();
  }

  /** Archive flag, section and order of a thread listed under another id from now on. */
  private rename(from: string, to: string): void {
    this.data.archived = this.data.archived.map((id) => id === from ? to : id);
    if (from in this.data.sections) {
      this.data.sections[to] = this.data.sections[from]!;
      delete this.data.sections[from];
    }
    for (const order of Object.values(this.data.sectionOrder)) order.forEach((id, index) => { if (id === from) order[index] = to; });
  }

  private reindex(): void {
    this.idRewrites = new Map();
    this.hiddenIds = new Set();
    // Forks share segments: a segment is hidden unless it is some lineage's own.
    for (const [publicId, segments] of Object.entries(this.data.lineages)) {
      const current = segments.at(-1)!;
      if (current.threadId !== publicId) this.idRewrites.set(current.threadId, publicId);
      for (const segment of segments) if (!this.data.lineages[segment.threadId]) this.hiddenIds.add(segment.threadId);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
