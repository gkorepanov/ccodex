import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { v5 as uuidv5 } from "uuid";
import type { Config } from "../config.js";
import type { UserInput } from "../protocol/codex.js";

export interface NativePeerConfig { enabled: true; python: string; script: string; stateDir?: string; softSteerDefault?: boolean }
export interface PeerBinding { jobId: string; threadId: string; turnId: string; clientId: string; input: UserInput[]; nativeUuid?: string; verified?: boolean; steerOf?: string; parentTurnId?: string }
export interface PeerJob { job_id: string; status: string; error?: string; delivery_message_uuid?: string; partial_result?: string; result?: string; transport?: string; expected_native_pid?: number }
const execute = promisify(execFile);
const mobileAttachmentRoot = "/tmp/codex-remote-attachments";
const uploadId = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu;
const imageExtensions = new Set([".gif", ".jpeg", ".jpg", ".png", ".webp"]);
const inlineImageHeader = /^data:image\/(png|jpeg|gif|webp);base64,/iu;
const maxInlineImageBytes = 20 * 1024 * 1024;
const inlineImageSignatures: Record<string, Buffer[]> = {
  png: [Buffer.from("89504e470d0a1a0a", "hex")],
  jpeg: [Buffer.from("ffd8ff", "hex")],
  gif: [Buffer.from("GIF87a"), Buffer.from("GIF89a")],
  webp: [Buffer.from("RIFF")],
};

/** Explicit opt-in sidecar also permits enabling this path without restarting a live gateway. */
export function nativePeerConfig(config: Config): NativePeerConfig | undefined {
  try {
    const value = JSON.parse(readFileSync(join(config.productHome, "native-peer-bridge.json"), "utf8"));
    if (value.enabled === true && typeof value.python === "string" && typeof value.script === "string") return value;
  } catch {}
  return undefined;
}

export class PeerBindings {
  public readonly jobs: Map<string, PeerBinding>;
  public readonly nativeIds = new Set<string>();
  public readonly logicalIds = new Set<string>();
  public constructor(private readonly file: string) {
    let data: PeerBinding[] = [];
    try { const parsed = JSON.parse(readFileSync(file, "utf8")); if (Array.isArray(parsed)) data = parsed; } catch {}
    this.jobs = new Map(data.map((binding) => [binding.jobId, binding]));
    for (const binding of data) { this.logicalIds.add(binding.turnId); if (binding.nativeUuid) this.nativeIds.add(binding.nativeUuid); }
  }
  public save(binding: PeerBinding): void {
    this.jobs.set(binding.jobId, binding);
    this.logicalIds.add(binding.turnId);
    if (binding.nativeUuid) this.nativeIds.add(binding.nativeUuid);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.jobs.values()]), { mode: 0o600 });
    renameSync(temp, this.file);
  }
}
const stores = new Map<string, PeerBindings>();
export function peerBindings(config: Config): PeerBindings {
  const file = join(config.dataDir, "native-peer-turns.json");
  let value = stores.get(file);
  if (!value) { value = new PeerBindings(file); stores.set(file, value); }
  return value;
}

export function preparePeerBinding(threadId: string, clientId: unknown, input: UserInput[]): PeerBinding {
  if (typeof clientId !== "string" || !clientId || clientId.length > 120) throw new Error("Shared App input requires a stable client message identifier; no message was sent.");
  const requestId = `ccodex-native-peer:${threadId}:${clientId}`;
  const jobId = createHash("sha256").update(requestId).digest("hex").slice(0, 32);
  const prepared = preparePeerInput(threadId, jobId, input);
  const binding = { jobId, threadId, turnId: uuidv5(requestId, uuidv5.URL), clientId, input: prepared.input };
  const prompt = peerPrompt(binding);
  if (!prompt.trim() || prompt.length > 100_000) throw new Error("Shared App input must be nonempty and under 100,000 characters; nothing was sent.");
  for (const [path, bytes] of prepared.images) stageInlineImage(threadId, path, bytes);
  return binding;
}

export function peerInputMatches(binding: PeerBinding, input: UserInput[]): boolean {
  return JSON.stringify(binding.input) === JSON.stringify(preparePeerInput(binding.threadId, binding.jobId, input).input);
}

function preparePeerInput(threadId: string, jobId: string, input: UserInput[]) {
  const images = new Map<string, Buffer>();
  let remaining = maxInlineImageBytes;
  const parts = input.map((item, index): UserInput => {
    if (item.type === "text") return item;
    if (item.type === "localImage") {
      mobileImagePath(threadId, item.path);
      return item;
    }
    if (item.type !== "image") throw new Error("Shared App input supports text and images; no message was sent.");
    const header = typeof item.url === "string" && inlineImageHeader.exec(item.url);
    if (!header || !uploadId.test(threadId)) throw new Error("Shared App inline images must be PNG, JPEG, GIF or WebP image data; no message was sent.");
    const encoded = item.url.slice(header[0].length);
    if (encoded.length > Math.ceil(remaining / 3) * 4) throw new Error("Shared App inline images exceed 20 MiB in this message; no message was sent.");
    const bytes = Buffer.from(encoded, "base64");
    const format = header[1]!.toLowerCase();
    const validSignature = inlineImageSignatures[format]!.some((signature) => bytes.subarray(0, signature.length).equals(signature));
    if (!validSignature || bytes.toString("base64") !== encoded || (format === "webp" && bytes.toString("ascii", 8, 12) !== "WEBP")) {
      throw new Error("Shared App inline image data is invalid; no message was sent.");
    }
    remaining -= bytes.length;
    if (remaining < 0) throw new Error("Shared App inline images exceed 20 MiB in this message; no message was sent.");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const upload = uuidv5(`${jobId}:${index}:${hash}`, uuidv5.URL);
    const path = join(mobileAttachmentRoot, threadId, upload, `image.${format}`);
    images.set(path, bytes);
    return { type: "localImage", path, detail: item.detail };
  });
  return { input: parts, images };
}

function stageInlineImage(threadId: string, path: string, bytes: Buffer): void {
  try {
    const tmp = realpathSync("/tmp");
    for (const dir of [mobileAttachmentRoot, join(mobileAttachmentRoot, threadId), dirname(path)]) {
      try { mkdirSync(dir, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) || realpathSync(dir) !== tmp + dir.slice(4)) {
        throw new Error("Unsafe image directory");
      }
    }
    const staging = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      writeFileSync(staging, bytes, { flag: "wx", mode: 0o600 });
      try { linkSync(staging, path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const file = lstatSync(path);
        if (!file.isFile() || file.uid !== process.getuid?.() || (file.mode & 0o077) || file.size !== bytes.length || !readFileSync(path).equals(bytes)) throw error;
      }
    } finally { rmSync(staging, { force: true }); }
  } catch {
    throw new Error("Shared App could not save the inline image in its private upload directory; no message was sent.");
  }
}

function mobileImagePath(threadId: string, path: string): string {
  if (typeof path !== "string") throw new Error("Shared App image path is missing; no message was sent.");
  const from = path.startsWith("/private/tmp/") ? path.slice("/private".length) : path;
  const prefix = `${mobileAttachmentRoot}/${threadId}/`;
  const segments = from.startsWith(prefix) ? from.slice(prefix.length).split("/") : [];
  if (uploadId.test(threadId) && segments.length === 2 && uploadId.test(segments[0]!)
      && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(from) && resolve(from) === from
      && imageExtensions.has(extname(segments[1]!).toLowerCase())) return from;
  throw new Error("Shared App images must be supported files uploaded to this chat; no message was sent.");
}

function peerPrompt(binding: PeerBinding): string {
  const text = binding.input.map((item) => item.type === "text" ? item.text : "").join("\n");
  const paths = binding.input.flatMap((item) => item.type === "localImage" ? [mobileImagePath(binding.threadId, item.path)] : []);
  if (!paths.length) return text;
  return `${text.trim() ? text + "\n\n" : ""}The user attached the following local image files. Use Read on these exact paths to view the images before answering. If a file cannot be read, say so.\n${paths.map((path) => JSON.stringify(path)).join("\n")}`;
}

export async function submitPeer(bridge: NativePeerConfig, binding: PeerBinding, ownerPid: number, mode: string, cwd: string): Promise<PeerJob> {
  const prompt = peerPrompt(binding);
  const images = binding.input.filter((item) => item.type === "localImage");
  if (images.length) {
    // A retired upload does not invalidate an existing native receipt or cause another send.
    try { return await readPeerJob(bridge, binding); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      if (!(await lstat(mobileAttachmentRoot)).isDirectory()) throw new Error("Invalid image upload directory");
      const root = await realpath(mobileAttachmentRoot);
      for (const image of images) {
        const path = mobileImagePath(binding.threadId, image.path);
        const file = await lstat(path);
        if (!file.isFile() || !file.size || await realpath(path) !== root + path.slice(mobileAttachmentRoot.length)) {
          throw new Error("Invalid image upload");
        }
      }
    } catch {
      throw new Error("An uploaded image is missing or unreadable; no message was sent. Attach the image again.");
    }
  }
  const args = { session_id: binding.threadId, prompt, request_id: `ccodex-native-peer:${binding.threadId}:${binding.clientId}`,
    permission_mode: mode, directory: cwd, timeout_seconds: 900, require_native: true, expected_native_pid: ownerPid,
    ...(binding.steerOf ? { steer_of: binding.steerOf } : {}) };
  const state = bridge.stateDir ?? join(homedir(), ".local", "state", "claude-sessions-bridge");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const payload = join(state, `${binding.jobId}.request.json`), temporary = `${payload}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(args), { mode: 0o600 });
  renameSync(temporary, payload);
  let stdout: string;
  try { ({ stdout } = await execute(bridge.python, [bridge.script, "continue", `@${payload}`], {
      env: { ...process.env, ...(bridge.stateDir ? { CLAUDE_BRIDGE_STATE: bridge.stateDir } : {}) }, timeout: 20_000, maxBuffer: 1_000_000,
    }));
  } catch {
    // The worker may already exist even if its caller lost the acknowledgement.
    // Reconcile the same durable job, never log/replay a command containing the prompt.
    try { return await readPeerJob(bridge, binding); } catch {}
    throw new Error("Native App submission was not acknowledged; inspect the original chat before retrying. No automatic resend.");
  }
  const reply = JSON.parse(stdout) as PeerJob;
  if (reply.job_id !== binding.jobId) throw new Error("Native App job identity mismatch; reconcile before retrying.");
  return reply;
}
export async function readPeerJob(bridge: NativePeerConfig, binding: PeerBinding): Promise<PeerJob> {
  const root = bridge.stateDir ?? join(homedir(), ".local", "state", "claude-sessions-bridge");
  const job = JSON.parse(await readFile(join(root, `${binding.jobId}.json`), "utf8"));
  if (job.job_id !== binding.jobId || (job.transport && job.transport !== "native_peer")) throw new Error("Unexpected shared App transport");
  if (job.session_id !== binding.threadId || job.prompt !== peerPrompt(binding)) throw new Error("Shared App job payload conflict; no message was retried.");
  return job;
}

/** Keep native canonical IDs and the client's pending message IDs consistent across refresh and paging. */
export function peerFrame(text: string, config: Config, incoming = false): string {
  const store = peerBindings(config);
  if (!store.jobs.size) return text;
  // Most frames belong to GPT or a normal SDK turn. Do not parse/rebuild them,
  // or allocate a list of every historical shared message per token delta.
  if (config.rpcLimitBytes && Buffer.byteLength(text) > config.rpcLimitBytes) return text;
  const relevant = incoming ? store.logicalIds : store.nativeIds;
  const uuids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu) ?? [];
  if (!uuids.some((id) => relevant.has(id)) && (incoming || !text.includes("[Codex bridge request "))) return text;
  const jobs = [...store.jobs.values()];
  if (incoming) {
    try { if (!["thread/turns/list", "thread/items/list", "thread/revert", "thread/fork", "thread/searchOccurrences"].includes(JSON.parse(text).method)) return text; } catch { return text; }
  }
  let changed = false;
  const ids = new Map(jobs.filter((x) => x.nativeUuid).map((x) => incoming ? [x.turnId, x.nativeUuid!] : [x.nativeUuid!, x.turnId]));
  const replaceId = (value: string) => {
    for (const [from, to] of ids) if (value === from || value.startsWith(from + ":")) { changed = true; return to + value.slice(from.length); }
    return value;
  };
  const walk = (value: any, key = "", root = false): any => {
    if (typeof value === "string") {
      if (key.toLowerCase().includes("cursor") && value.startsWith("{")) { try { return JSON.stringify(walk(JSON.parse(value))); } catch {} }
      return ["id", "turnId", "itemId", "beforeTurnId", "afterTurnId"].includes(key) && !root ? replaceId(value) : value;
    }
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
      const list = value.map((v) => walk(v));
      if (!incoming && list.every((v) => v && typeof v.id === "string" && Array.isArray(v.items) && typeof v.status === "string")) {
        const unique = new Map<string, any>();
        for (const turn of list) {
          const previous = unique.get(turn.id);
          if (!previous) unique.set(turn.id, turn);
          else { changed = true; const richer = previous.items.length >= turn.items.length ? previous : turn; unique.set(turn.id, { ...richer, ...(turn.status === "inProgress" || previous.status === "inProgress" ? { status: "inProgress", completedAt: null } : {}) }); }
        }
        return [...unique.values()];
      }
      return list;
    }
    if (!incoming && value.type === "userMessage") {
      const body = JSON.stringify(value.content ?? []);
      const binding = jobs.find((b) => b.nativeUuid === value.id || (!b.nativeUuid && body.includes("Message from Claude agent Codex session bridge") && body.includes(`[Codex bridge request ${b.jobId}]`)));
      if (binding) {
        if (!binding.nativeUuid && typeof value.id === "string") { binding.nativeUuid = value.id; peerBindings(config).save(binding); ids.set(value.id, binding.turnId); }
        changed = true;
        return { ...value, id: binding.turnId, clientId: binding.clientId, content: binding.input };
      }
    }
    const out: any = {};
    // Children may discover the native message UUID before the parent's turn ID is rewritten.
    for (const [k, v] of Object.entries(value)) if (k !== "id") out[k] = walk(v, k);
    if ("id" in value) out.id = root ? value.id : walk(value.id, "id");
    return out;
  };
  try { const result = walk(JSON.parse(text), "", true); return changed ? JSON.stringify(result) : text; } catch { return text; }
}
