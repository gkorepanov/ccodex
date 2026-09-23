import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Provider = "codex" | "claude";

export interface Segment {
  readonly provider: Provider;
  readonly threadId: string;
  /** Last turn of this segment; null for the current (last) segment. */
  readonly lastTurnId: string | null;
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
  /** Claude threads rolled back but not continued yet: the kept history ends at this record. */
  leaves: Record<string, string>;
}

/**
 * `~/.ccodex/state/meta.json`: tiny, optional. Missing file or key = defaults. The gateway is the only
 * writer; each write goes to a temp file renamed over the original.
 */
export class Meta {
  private data: MetaData;
  private rewrites = new Map<string, string>();
  private hiddenIds = new Set<string>();

  public constructor(private readonly path: string) {
    const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Partial<MetaData> : {};
    this.data = {
      lineages: raw.lineages ?? {}, archived: raw.archived ?? [], sections: raw.sections ?? {},
      sectionOrder: raw.sectionOrder ?? {}, leaves: raw.leaves ?? {},
    };
    this.reindex();
  }

  public get lineages(): Readonly<Record<string, readonly Segment[]>> { return this.data.lineages; }

  public lineage(publicId: string): readonly Segment[] | undefined { return this.data.lineages[publicId]; }

  /** Current backend id → public id, for lineages whose current backend is not the public one. */
  public get currentRewrites(): ReadonlyMap<string, string> { return this.rewrites; }

  /** Backend threads that only exist as a part of some lineage (never listed on their own). */
  public hidden(threadId: string): boolean { return this.hiddenIds.has(threadId); }

  public current(publicId: string): Segment | undefined { return this.data.lineages[publicId]?.at(-1); }

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

  public sectionOrder(sectionId: string): readonly string[] { return this.data.sectionOrder[sectionId] ?? []; }

  public setSectionOrder(sectionId: string, ids: string[]): void {
    this.data.sectionOrder[sectionId] = ids;
    this.save();
  }

  public leaf(threadId: string): string | undefined { return this.data.leaves[threadId]; }

  public setLeaf(threadId: string, uuid: string | null): void {
    if (uuid) this.data.leaves[threadId] = uuid;
    else if (this.data.leaves[threadId]) delete this.data.leaves[threadId];
    else return;
    this.save();
  }

  public forget(threadId: string): void {
    this.data.archived = this.data.archived.filter((id) => id !== threadId);
    delete this.data.sections[threadId];
    delete this.data.leaves[threadId];
    this.save();
  }

  private reindex(): void {
    const lineages = Object.entries(this.data.lineages);
    this.rewrites = new Map(lineages.flatMap(([publicId, segments]) =>
      segments.at(-1)!.threadId === publicId ? [] : [[segments.at(-1)!.threadId, publicId] as const]));
    this.hiddenIds = new Set(lineages.flatMap(([publicId, segments]) =>
      segments.flatMap((segment) => segment.threadId === publicId || this.data.lineages[segment.threadId] ? [] : [segment.threadId])));
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
