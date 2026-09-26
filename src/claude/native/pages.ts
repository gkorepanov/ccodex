/**
 * Owns paged reads of a Claude transcript. History is projected from windows read back from the end of the file, as
 * far as a page needs, never the whole file: Desktop pages a thread (`thread/turns/list`, `thread/items/list`) and
 * a transcript grows to hundreds of megabytes.
 */
import { open, stat } from "node:fs/promises";
import type { Turn } from "../../protocol/codex.js";
import type { PeerDirectory } from "../peers.js";
import { projectTranscript, type TranscriptProjection } from "./projector.js";
import { parseTranscriptLine, type TranscriptRecord } from "./records.js";
import type { TranscriptHeader } from "./summary.js";

const CHUNK_BYTES = 1 << 20;
/** Turns the live window keeps beyond what was asked: the next page of a scroll back needs no read. */
const KEPT_TURNS = 12;

export interface PageSource {
  readonly sessionId: string;
  readonly path: string;
  readonly header: TranscriptHeader;
  readonly peers: PeerDirectory;
  /** Changes when the peers can link more messages (their projection differs). */
  readonly peersVersion: string;
  /** The rolled-back-to record; else the latest one. */
  readonly leafUuid?: string;
}

export interface TurnWindow {
  /** Complete turns, oldest first. */
  readonly turns: readonly Turn[];
  /** History goes on before them. */
  readonly older: boolean;
  readonly projection: TranscriptProjection;
}

/** A byte range of the transcript, parsed. */
interface Window {
  start: number;
  end: number;
  records: TranscriptRecord[];
  positions: number[];
  /** Line offset of each record uuid (its last occurrence, as Claude's own reading keeps it). */
  offsets: Map<string, number>;
}

/** Where a projected turn lies in the transcript. */
interface TurnPlace {
  readonly start: number;
  /** Where the next turn starts; none for the newest turn. */
  readonly end: number | undefined;
  readonly lastUuid: string;
  readonly boundary: string;
  readonly previousBoundary: string | null;
  /** Reached past a later compaction, where history reads as written: a window ending with it reads the same way. */
  readonly physical: boolean;
}

function emptyWindow(end: number): Window {
  return { start: end, end, records: [], positions: [], offsets: new Map() };
}

async function readRange(path: string, from: number, to: number): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(to - from);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, from);
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Complete lines of `bytes` (read at `at`) from `first` up to the last newline: records with their line offsets. */
function parseLines(bytes: Buffer, at: number, first: number): { records: TranscriptRecord[]; positions: number[]; end: number } {
  const records: TranscriptRecord[] = [];
  const positions: number[] = [];
  let line = first;
  for (let newline = bytes.indexOf(0x0a, line); newline !== -1; newline = bytes.indexOf(0x0a, line)) {
    const record = parseTranscriptLine(bytes.subarray(line, newline));
    if (record) {
      records.push(record);
      positions.push(at + line);
    }
    line = newline + 1;
  }
  return { records, positions, end: at + line };
}

function uuidOf(record: TranscriptRecord): string | undefined {
  return "uuid" in record && typeof record.uuid === "string" ? record.uuid : undefined;
}

/** Extends the window back by up to `chunk` bytes; false when no whole line fits in them (a longer chunk will). */
async function readBack(path: string, window: Window, chunk: number): Promise<boolean> {
  const from = Math.max(0, window.start - chunk);
  const bytes = await readRange(path, from, window.start);
  const first = from === 0 ? 0 : bytes.indexOf(0x0a) + 1;
  if (first === 0 && from > 0) return false;
  const parsed = parseLines(bytes, from, first);
  // A window opened at the end of the file ends at its last whole line (Claude may be writing the next one).
  if (window.start === window.end) window.end = parsed.end;
  else if (parsed.end !== window.start) throw new Error(`${path}: a line runs past a window's start`);
  window.start = from + first;
  window.records.unshift(...parsed.records);
  window.positions.unshift(...parsed.positions);
  parsed.records.forEach((record, index) => {
    const uuid = uuidOf(record);
    if (uuid && !window.offsets.has(uuid)) window.offsets.set(uuid, parsed.positions[index]!);
  });
  return true;
}

/** Appends what Claude wrote since the window's end. */
async function readForward(path: string, window: Window, size: number): Promise<void> {
  if (size <= window.end || !window.records.length) return;
  const parsed = parseLines(await readRange(path, window.end, size), window.end, 0);
  window.end = parsed.end;
  window.records.push(...parsed.records);
  window.positions.push(...parsed.positions);
  parsed.records.forEach((record, index) => {
    const uuid = uuidOf(record);
    if (uuid) window.offsets.set(uuid, parsed.positions[index]!);
  });
}

/** Where the line after `uuid`'s starts. */
function after(window: Window, uuid: string): number {
  const offset = window.offsets.get(uuid)!;
  let low = 0;
  let high = window.positions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (window.positions[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return window.positions[low] ?? window.end;
}

/** Drops the window's records before `offset`. */
function trim(window: Window, offset: number): void {
  const index = window.positions.findIndex((position) => position >= offset);
  if (index <= 0) return;
  window.records.splice(0, index);
  window.positions.splice(0, index);
  window.start = window.positions[0]!;
  for (const [uuid, position] of window.offsets) if (position < window.start) window.offsets.delete(uuid);
}

export class TranscriptPages {
  /** The newest part of the file; follows Claude's writes. */
  private live?: Window & { readonly ino: number; cache?: { readonly key: string; readonly window: TurnWindow } };
  private readonly places = new Map<string, TurnPlace>();
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(private readonly chunkBytes = CHUNK_BYTES) {}

  /** The newest turns: at least `count` of them unless history is shorter. */
  public newest(source: PageSource, count: number): Promise<TurnWindow> {
    return this.serial(() => this.liveWindow(source, (turns) => turns.length >= count, count));
  }

  /** The window of `turnId` (the last of its turns unless it is the newest) with at least `before` turns before it. */
  public around(source: PageSource, turnId: string, before: number): Promise<TurnWindow> {
    return this.serial(async () => {
      const reaches = (turns: readonly Turn[]) => turns.findIndex((turn) => turn.id === turnId) >= before;
      let place = this.places.get(turnId);
      if (!place) {
        // Not paged to yet (a cursor from before a restart): back from the end until it shows.
        const found = await this.liveWindow(source, (turns) => turns.some((turn) => turn.id === turnId), 1);
        if (!found.turns.some((turn) => turn.id === turnId)) throw new Error(`turn not found: ${turnId}`);
        place = this.places.get(turnId)!;
      }
      if (place.end === undefined) return this.liveWindow(source, reaches, 1);
      return this.fill(source, emptyWindow(place.end), place.lastUuid, true, reaches, place.physical);
    });
  }

  /** The newest turns back to `turnId`. */
  public since(source: PageSource, turnId: string): Promise<TurnWindow> {
    return this.serial(() => this.liveWindow(source, (turns) => turns.some((turn) => turn.id === turnId), 1));
  }

  /** The last record of the turn before `turnId` (of `turnId` itself when `inclusive`); null before the first turn. */
  public async boundary(source: PageSource, turnId: string, inclusive: boolean): Promise<string | null> {
    if (!this.places.has(turnId)) await this.around(source, turnId, 0);
    const place = this.places.get(turnId)!;
    return inclusive ? place.boundary : place.previousBoundary;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async liveWindow(source: PageSource, enough: (turns: readonly Turn[]) => boolean, keep: number): Promise<TurnWindow> {
    const { ino, size } = await stat(source.path);
    if (!this.live || this.live.ino !== ino || size < this.live.end) {
      this.live = { ...emptyWindow(size), ino };
      this.places.clear();
    }
    const live = this.live;
    await readForward(source.path, live, size);
    const key = `${live.start}:${live.end}:${source.leafUuid ?? ""}:${source.peersVersion}`;
    if (live.cache?.key === key && (!live.cache.window.older || enough(live.cache.window.turns))) return live.cache.window;
    const window = await this.fill(source, live, source.leafUuid, false, enough);
    // The window stays a few pages long: it starts again at the turn before the kept ones (their context).
    const kept = Math.max(keep, KEPT_TURNS);
    const cut = window.projection.turnBoundaries.at(-kept - 1)?.firstUuid;
    if (window.turns.length > 2 * kept && cut && enough(window.turns.slice(-kept))) trim(live, live.offsets.get(cut)!);
    else live.cache = { key, window };
    return window;
  }

  /** Reads the window back until its turns are `enough` or history starts in it. */
  private async fill(
    source: PageSource,
    window: Window,
    leafUuid: string | undefined,
    continues: boolean,
    enough: (turns: readonly Turn[]) => boolean,
    physical = false,
  ): Promise<TurnWindow> {
    for (let chunk = this.chunkBytes; ; chunk *= 2) {
      if (window.records.length && (!leafUuid || window.offsets.has(leafUuid))) {
        const projection = await projectTranscript({
          sessionId: source.sessionId, path: source.path, records: window.records, header: source.header,
          peers: source.peers, continues, physical, ...(leafUuid ? { leafUuid } : {}),
        });
        // Cut off from its start, the first turn lacks what came before it (a steer's queue, the prompt of the answer it
        // goes on after): only the turns after it are whole.
        const older = window.start > 0 && (projection.truncated || projection.selectedLeafUuid === null);
        // A turn Claude goes on from mid-message: the window of the one before it holds the message's later blocks, the
        // start of this turn only (past the leaf).
        const leafAt = projection.selectedLeafUuid ? window.offsets.get(projection.selectedLeafUuid)! : window.end;
        const partial = projection.turnBoundaries.findIndex((bound) => window.offsets.get(bound.firstUuid)! > leafAt);
        const whole = partial < 0 ? projection.turns.length : partial;
        const turns = projection.turns.slice(older ? 1 : 0, whole);
        if (!older || enough(turns) && !projection.partialCompaction) {
          this.index(window, projection, older, continues, physical, whole);
          return { turns, older, projection };
        }
      } else if (window.start === 0) {
        if (!leafUuid) return { turns: [], older: false, projection: await projectTranscript({ sessionId: source.sessionId, path: source.path, records: [], header: source.header }) };
        throw new Error(`${source.path}: record ${leafUuid} not found`);
      }
      await readBack(source.path, window, chunk);
    }
  }

  private index(window: Window, projection: TranscriptProjection, older: boolean, continues: boolean, physical: boolean, whole: number): void {
    const bounds = projection.turnBoundaries.slice(0, whole);
    const order = new Map([...projection.selectedRecordUuids].map((uuid, index) => [uuid, index]));
    const physicalFrom = projection.physicalFrom ? order.get(projection.physicalFrom)! : -1;
    // Where each record's API message ends: a turn Claude goes on from mid-message needs the message's later blocks.
    const messageOf = new Map<string, string>();
    const messageEnds = new Map<string, number>();
    window.records.forEach((record, index) => {
      if (record.type !== "assistant" || !record.message.id) return;
      messageOf.set(record.uuid, record.message.id);
      messageEnds.set(record.message.id, window.positions[index + 1] ?? window.end);
    });
    bounds.forEach((bound, index) => {
      if (older && index === 0) return;
      const next = bounds[index + 1];
      this.places.set(bound.turnId, {
        start: window.offsets.get(bound.firstUuid)!,
        // Its records end where the next turn starts, unless Claude grouped a later one into it (one API message).
        end: next
          ? Math.max(window.offsets.get(next.firstUuid)!, after(window, bound.lastUuid), messageEnds.get(messageOf.get(bound.lastUuid)!) ?? 0)
          : continues ? window.end : undefined,
        lastUuid: bound.lastUuid,
        boundary: bound.messageUuid,
        previousBoundary: bounds[index - 1]?.messageUuid ?? null,
        physical: physical || order.get(bound.lastUuid)! < physicalFrom,
      });
    });
  }
}
