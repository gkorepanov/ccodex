/** Owns discovery, incremental summaries, projection caching, and filesystem watches for native sessions. */
import { createHash } from "node:crypto";
import { watch as watchFileSystem, type FSWatcher } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { projectTranscript, type TranscriptProjection } from "./projector.js";
import { readTranscriptRecords } from "./records.js";
import {
  TranscriptSummarizer,
  type TranscriptHeader,
  type TranscriptSummaryState,
} from "./summary.js";

export interface SessionSummary extends TranscriptHeader {
  readonly sessionId: string;
  readonly path: string;
  readonly projectKey: string;
  readonly sizeBytes: number;
  readonly hasSubagents: boolean;
}

interface CatalogEntry {
  readonly sessionId: string;
  readonly path: string;
  readonly projectKey: string;
  readonly offset: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly headLength: number;
  readonly headHash: string;
  readonly state: TranscriptSummaryState;
  readonly summary: SessionSummary;
}

interface DiscoveredFile {
  readonly sessionId: string;
  readonly path: string;
  readonly projectKey: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly hasSubagents: boolean;
}

const HEAD_BYTES = 4_096;
const PROJECTION_CACHE_SIZE = 8;
const WATCH_DEBOUNCE_MS = 250;

function ignored(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EPERM";
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (ignored(error)) return false;
    throw error;
  }
}

async function hashHead(path: string, length: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, 0);
    return createHash("md5").update(bytes.subarray(0, bytesRead)).digest("hex");
  } finally {
    await handle.close();
  }
}

export class NativeSessionCatalog {
  private readonly projectsDir: string;
  private entries = new Map<string, CatalogEntry>();
  private entriesBySessionId = new Map<string, CatalogEntry>();
  private projectDirectories = new Set<string>();
  private ordered: readonly SessionSummary[] = [];
  private bySessionId = new Map<string, SessionSummary>();
  private refreshInFlight: Promise<void> | undefined;
  private readonly projections = new Map<string, Promise<TranscriptProjection>>();
  public bytesParsed = 0;

  public constructor(projectsDir: string) {
    this.projectsDir = resolve(projectsDir);
  }

  public refresh(_sessionId?: string): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const refresh = this.scan().finally(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = refresh;
    return refresh;
  }

  public sessions(): readonly SessionSummary[] {
    return this.ordered;
  }

  public get(sessionId: string): SessionSummary | undefined {
    return this.bySessionId.get(sessionId);
  }

  public async projection(sessionId: string, leafUuid?: string): Promise<TranscriptProjection> {
    const entry = this.entriesBySessionId.get(sessionId);
    if (!entry) throw new Error(`Unknown native Claude session: ${sessionId}`);
    const summary = entry.summary;
    // The file itself, not the catalog's (debounced) view of it: a read right after a turn sees that turn.
    const { mtimeMs, size } = await stat(summary.path);
    const key = `${summary.path}\0${mtimeMs}\0${size}\0${leafUuid ?? ""}`;
    const cached = this.projections.get(key);
    if (cached) {
      this.projections.delete(key);
      this.projections.set(key, cached);
      return cached;
    }
    const projection = projectTranscript({
      sessionId,
      path: summary.path,
      header: summary,
      ...(leafUuid ? { leafUuid } : {}),
    });
    this.projections.set(key, projection);
    while (this.projections.size > PROJECTION_CACHE_SIZE) {
      this.projections.delete(this.projections.keys().next().value!);
    }
    void projection.catch(() => this.projections.delete(key));
    return projection;
  }

  public watch(onChange: () => void): () => void {
    const watchers = new Map<string, FSWatcher>();
    let timer: NodeJS.Timeout | undefined;
    let closed = false;

    const desiredDirectories = () => new Set([
      this.projectsDir,
      ...this.projectDirectories,
    ]);
    const syncWatchers = () => {
      const desired = desiredDirectories();
      for (const [path, watcher] of watchers) {
        if (!desired.has(path)) {
          watcher.close();
          watchers.delete(path);
        }
      }
      for (const path of desired) {
        if (watchers.has(path)) continue;
        try {
          const watcher = watchFileSystem(path, { recursive: false, persistent: false }, schedule);
          watcher.on("error", () => {
            watcher.close();
            watchers.delete(path);
          });
          watcher.unref();
          watchers.set(path, watcher);
        } catch (error) {
          if (!ignored(error)) throw error;
        }
      }
    };
    const refresh = async () => {
      try {
        await this.refresh();
        if (closed) return;
        syncWatchers();
        onChange();
      } catch {}
    };
    function schedule() {
      if (closed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), WATCH_DEBOUNCE_MS);
      timer.unref();
    }

    syncWatchers();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    };
  }

  private async scan(): Promise<void> {
    const files = await this.discover();
    const scanned = await Promise.all(files.map(async (file) => {
      try {
        return await this.summarize(file);
      } catch (error) {
        if (ignored(error)) return undefined;
        throw error;
      }
    }));
    const entries = scanned.filter((entry): entry is CatalogEntry => entry !== undefined);
    this.entries = new Map(entries.map((entry) => [entry.path, entry]));
    const summaries = entries.map((entry) => entry.summary)
      .sort((left, right) => right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId));
    this.ordered = summaries;
    this.bySessionId = new Map(summaries.map((summary) => [summary.sessionId, summary]));
    this.entriesBySessionId = new Map(entries.map((entry) => [entry.sessionId, entry]));
  }

  private async discover(): Promise<DiscoveredFile[]> {
    let projects;
    try {
      projects = (await readdir(this.projectsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) {
      if (ignored(error)) {
        this.projectDirectories = new Set();
        return [];
      }
      throw error;
    }
    this.projectDirectories = new Set(projects.map((project) => join(this.projectsDir, project.name)));
    const discovered = await Promise.all(projects.map(async (project) => {
      const projectDirectory = join(this.projectsDir, project.name);
      let names;
      try {
        names = (await readdir(projectDirectory, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .sort((left, right) => left.name.localeCompare(right.name));
      } catch (error) {
        if (ignored(error)) return [];
        throw error;
      }
      return Promise.all(names.map(async (name): Promise<DiscoveredFile | undefined> => {
        const path = join(projectDirectory, name.name);
        try {
          const identity = await stat(path);
          const sessionId = basename(name.name, ".jsonl");
          const hasSubagents = await directoryExists(join(projectDirectory, sessionId, "subagents"));
          return {
            sessionId,
            path,
            projectKey: project.name,
            mtimeMs: identity.mtimeMs,
            size: identity.size,
            hasSubagents,
          };
        } catch (error) {
          if (ignored(error)) return undefined;
          throw error;
        }
      }));
    }));
    return discovered.flat(2).filter((file): file is DiscoveredFile => file !== undefined);
  }

  private async summarize(file: DiscoveredFile): Promise<CatalogEntry> {
    const previous = this.entries.get(file.path);
    if (previous && previous.mtimeMs === file.mtimeMs && previous.size === file.size) {
      return {
        ...previous,
        summary: { ...previous.summary, hasSubagents: file.hasSubagents },
      };
    }

    let start = 0;
    let summarizer = new TranscriptSummarizer();
    if (previous && file.size >= previous.offset
      && await hashHead(file.path, previous.headLength) === previous.headHash) {
      start = previous.offset;
      summarizer = new TranscriptSummarizer(previous.state);
    }
    if (start < file.size) {
      const reader = readTranscriptRecords(file.path, { start, end: file.size - 1 });
      for await (const record of reader) summarizer.accept(record);
      this.bytesParsed += reader.bytesRead;
      start += reader.completeBytes;
    }
    const headLength = Math.min(HEAD_BYTES, file.size);
    return {
      sessionId: file.sessionId,
      path: file.path,
      projectKey: file.projectKey,
      offset: start,
      mtimeMs: file.mtimeMs,
      size: file.size,
      headLength,
      headHash: await hashHead(file.path, headLength),
      state: summarizer.snapshot(),
      summary: {
        ...summarizer.header(Math.floor(file.mtimeMs / 1_000)),
        sessionId: file.sessionId,
        path: file.path,
        projectKey: file.projectKey,
        sizeBytes: file.size,
        hasSubagents: file.hasSubagents,
      },
    };
  }
}
