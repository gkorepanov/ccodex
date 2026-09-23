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
   * (the first one; for a fork taken in a later segment, the forked backend), or none of them for a 0.4 thread id
   * kept for its Claude session by the migration.
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
  private idRewrites = new Map<string, string>();
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

  /** Backend id → public id: the current backend and the row's backend of lineages where they differ from it. */
  public get rewrites(): ReadonlyMap<string, string> { return this.idRewrites; }

  /** Backend threads that only exist as a part of some lineage (never listed on their own). */
  public hidden(threadId: string): boolean { return this.hiddenIds.has(threadId); }

  public current(publicId: string): Segment | undefined { return this.data.lineages[publicId]?.at(-1); }

  /** The segment whose backend carries the lineage's row (name, preview, archive, section). */
  public row(publicId: string): Segment {
    const segments = this.data.lineages[publicId]!;
    return segments.find((segment) => segment.threadId === publicId) ?? segments[0]!;
  }

  /** The backend id a public thread id is keyed by: its row's backend for lineages, itself otherwise. */
  public rowId(threadId: string): string {
    return this.data.lineages[threadId] ? this.row(threadId).threadId : threadId;
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

  /** Drops finished segments whose backend is gone: Claude deletes transcripts after `cleanupPeriodDays`. */
  public prune(exists: (segment: Segment) => boolean): void {
    let changed = false;
    for (const [publicId, segments] of Object.entries(this.data.lineages)) {
      const kept = segments.filter((segment, index) => index === segments.length - 1 || exists(segment));
      if (kept.length === segments.length) continue;
      changed = true;
      if (kept.length === 1 && kept[0]!.threadId === publicId) delete this.data.lineages[publicId];
      else this.data.lineages[publicId] = kept;
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
    this.idRewrites = new Map();
    this.hiddenIds = new Set();
    // Forks share segments: a segment is hidden unless it is some lineage's row.
    const rows = new Set(Object.keys(this.data.lineages).map((publicId) => this.row(publicId).threadId));
    for (const [publicId, segments] of Object.entries(this.data.lineages)) {
      for (const segment of [this.row(publicId), segments.at(-1)!]) {
        if (segment.threadId !== publicId) this.idRewrites.set(segment.threadId, publicId);
      }
      for (const segment of segments) if (!rows.has(segment.threadId)) this.hiddenIds.add(segment.threadId);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
