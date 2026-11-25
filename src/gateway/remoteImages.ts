/**
 * A user message keeps its pasted image inline (a data URL of hundreds of KB), and every read of that part of history
 * sends it again. For a client on the relay the image in a history page is a smaller JPEG: made once by macOS's
 * `sips`, kept by content hash. Without `sips`, or when it fails, the page goes as stored.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { JsonObject } from "../protocol/codex.js";

const run = promisify(execFile);
const SIPS = "/usr/bin/sips";
/** Smaller than this is not worth a conversion. */
const MIN_URL_CHARS = 64_000;
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,/u;
const inFlight = new Map<string, Promise<string | undefined>>();

interface ImageConfig { readonly remoteImageMaxPx: number; readonly dataDir: string }

async function smaller(url: string, config: ImageConfig): Promise<string | undefined> {
  const header = DATA_IMAGE.exec(url);
  if (!header) return undefined;
  const edge = config.remoteImageMaxPx;
  const directory = join(config.dataDir, "remote-images");
  const key = `${createHash("sha256").update(url).digest("hex")}-${edge}`;
  const kept = join(directory, `${key}.jpg`);
  let job = inFlight.get(key);
  if (!job) {
    job = (async () => {
      try {
        return (await readFile(kept)).toString("base64");
      } catch {
        // Not made yet.
      }
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stem = join(directory, `.${randomUUID()}`);
      const source = `${stem}.${header[1]}`, made = `${stem}.jpg`;
      try {
        await writeFile(source, Buffer.from(url.slice(header[0].length), "base64"), { mode: 0o600 });
        await run(SIPS, ["-s", "format", "jpeg", "-s", "formatOptions", "55", "-Z", String(edge), source, "--out", made], { timeout: 15_000 });
        const bytes = await readFile(made);
        await rename(made, kept);
        return bytes.toString("base64");
      } finally {
        await Promise.all([rm(source, { force: true }), rm(made, { force: true })]);
      }
    })().catch(() => undefined).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  const data = await job;
  // An image already small or plain may come out no smaller: it stays as stored.
  return data && data.length + 23 < url.length * 0.8 ? `data:image/jpeg;base64,${data}` : undefined;
}

async function slimItem(item: any, config: ImageConfig): Promise<any> {
  if (item?.type !== "userMessage" || !Array.isArray(item.content)) return item;
  let changed = false;
  const content = await Promise.all(item.content.map(async (part: any) => {
    if (part?.type !== "image" || typeof part.url !== "string" || part.url.length < MIN_URL_CHARS) return part;
    const url = await smaller(part.url, config);
    if (!url) return part;
    changed = true;
    return { ...part, url };
  }));
  return changed ? { ...item, content } : item;
}

/** The page with its user messages' large inline images made smaller; what it was read from is left as it is. */
export async function slimHistoryImages(result: JsonObject, config: ImageConfig): Promise<JsonObject> {
  if (!config.remoteImageMaxPx || process.platform !== "darwin" || !existsSync(SIPS) || !Array.isArray(result?.data)) return result;
  let changed = false;
  const data = await Promise.all(result.data.map(async (entry: any) => {
    if (entry?.item) {
      const item = await slimItem(entry.item, config);
      if (item === entry.item) return entry;
      changed = true;
      return { ...entry, item };
    }
    if (Array.isArray(entry?.items)) {
      const items = await Promise.all(entry.items.map((item: any) => slimItem(item, config)));
      if (items.every((item: any, at: number) => item === entry.items[at])) return entry;
      changed = true;
      return { ...entry, items };
    }
    return entry;
  }));
  return changed ? { ...result, data } : result;
}
