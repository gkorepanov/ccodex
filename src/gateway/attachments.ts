import { randomUUID } from "node:crypto";
import { invalidParams, type JsonObject } from "../protocol/codex.js";
import type { Connection } from "./connection.js";
import type { Gateway } from "./server.js";

function page<T extends { id?: string; threadId?: string }>(rows: readonly T[], params: JsonObject, scope: string): JsonObject {
  let after: string | undefined;
  if (params.cursor) {
    try {
      const cursor = JSON.parse(params.cursor);
      if (cursor.scope !== scope || typeof cursor.after !== "string") throw new Error();
      after = cursor.after;
    } catch { throw invalidParams("invalid attachment cursor"); }
  }
  const key = (row: T) => row.id ?? row.threadId!;
  const sorted = [...rows].sort((a, b) => key(a).localeCompare(key(b)));
  const remaining = sorted.filter(row => after === undefined || key(row).localeCompare(after) > 0);
  const data = remaining.slice(0, Math.max(1, Math.min(params.limit ?? 100, 100)));
  return { data, nextCursor: remaining.length > data.length ? JSON.stringify({ scope, after: key(data.at(-1)!) }) : null };
}

/** Attachments belong to the public row, so a model switch never changes their owner. */
export class Attachments {
  private readonly migrations = new Map<string, Promise<void>>();
  public constructor(private readonly gateway: Gateway) {}

  public async handle(connection: Connection, method: string, params: JsonObject): Promise<unknown> {
    if (method === "thread/attachmentOwner/list") return this.owners(connection, params);
    const meta = this.gateway.meta;
    const threadId = meta.rewrites.get(params.threadId) ?? params.threadId;
    const row = meta.lineage(threadId) ? meta.row(threadId) : { threadId, provider: this.gateway.claude.owns(threadId) ? "claude" : "codex" };
    if (row.provider === "codex") {
      await this.migrate(connection, threadId);
      return connection.upstream.request(method, { ...params, threadId: row.threadId });
    }
    if (method !== "thread/attachment/list") this.identity(params);
    // Empty GPT chats can switch to Claude under the same ID while stock still owns their attachments.
    const native = await this.nativeAttachments(connection, row.threadId);
    let attachments = [...meta.threadAttachments[threadId] ?? []];
    const combined = new Map([...native, ...attachments].map(a => [JSON.stringify([a.attachmentType, a.identityKey]), a]));
    if (method === "thread/attachment/list") return page([...combined.values()], params, threadId);
    let existing = attachments.find(a => a.attachmentType === params.attachmentType && a.identityKey === params.identityKey);
    const nativeExisting = native.find(a => a.attachmentType === params.attachmentType && a.identityKey === params.identityKey);
    if (method === "thread/attachment/add" && (existing || nativeExisting)) return { outcome: "existing", attachment: existing ?? nativeExisting };
    if (method === "thread/attachment/remove" && nativeExisting) {
      await connection.upstream.request(method, { ...params, threadId: row.threadId });
      attachments = [...meta.threadAttachments[threadId] ?? []];
      existing = attachments.find(a => a.attachmentType === params.attachmentType && a.identityKey === params.identityKey);
    }
    if (method === "thread/attachment/remove" && !existing) return {};
    if (method === "thread/attachment/add" && !("payload" in params)) throw invalidParams("attachment payload is required");
    const attachment = existing ?? { id: randomUUID(), attachmentType: params.attachmentType, identityKey: params.identityKey, payload: params.payload, createdAt: Math.floor(Date.now() / 1000) };
    meta.setThreadAttachments(threadId, method === "thread/attachment/add" ? [...attachments, attachment] : attachments.filter(a => a.id !== attachment.id));
    this.gateway.broadcast("thread/attachment/updated", {
      threadId, attachmentType: attachment.attachmentType, identityKey: attachment.identityKey, attachmentId: attachment.id,
      operation: method === "thread/attachment/add" ? "created" : "deleted",
    });
    return method === "thread/attachment/add" ? { outcome: "created", attachment } : {};
  }

  /** Pruning an expired Claude row can leave its attachments on a native GPT row. */
  private migrate(connection: Connection, threadId: string): Promise<void> {
    const running = this.migrations.get(threadId);
    if (running) return running;
    const meta = this.gateway.meta;
    const row = meta.lineage(threadId) ? meta.row(threadId) : { threadId, provider: this.gateway.claude.owns(threadId) ? "claude" : "codex" };
    if (row.provider !== "codex") return Promise.resolve();
    const attachments = meta.threadAttachments[threadId];
    if (!attachments) return Promise.resolve();
    const migration = (async () => {
      for (const attachment of attachments) await connection.upstream.request("thread/attachment/add", {
        threadId: row.threadId, attachmentType: attachment.attachmentType, identityKey: attachment.identityKey, payload: attachment.payload,
      });
      // Retain Meta until every idempotent native registration has succeeded.
      meta.setThreadAttachments(threadId, []);
    })().finally(() => this.migrations.delete(threadId));
    this.migrations.set(threadId, migration);
    return migration;
  }

  public async clear(connection: Connection, threadId: string): Promise<void> {
    await this.migrations.get(threadId)?.catch(() => undefined);
    for (const attachment of await this.nativeAttachments(connection, threadId)) {
      await connection.upstream.request("thread/attachment/remove", { threadId, attachmentType: attachment.attachmentType, identityKey: attachment.identityKey });
    }
    this.gateway.meta.setThreadAttachments(threadId, []);
  }

  private async nativeAttachments(connection: Connection, threadId: string): Promise<JsonObject[]> {
    const attachments: JsonObject[] = [];
    let cursor: string | null = null;
    do {
      const result: JsonObject = await connection.upstream.request("thread/attachment/list", { threadId, cursor, limit: 100 });
      attachments.push(...result.data);
      cursor = result.nextCursor;
    } while (cursor);
    return attachments;
  }

  private identity(params: JsonObject): void {
    for (const key of ["attachmentType", "identityKey"]) {
      if (typeof params[key] !== "string" || !params[key].trim()) throw invalidParams(`${key} must be a non-empty string`);
    }
  }

  private async owners(connection: Connection, params: JsonObject): Promise<unknown> {
    this.identity(params);
    for (const [threadId, attachments] of Object.entries(this.gateway.meta.threadAttachments)) {
      if (attachments.some(a => a.attachmentType === params.attachmentType && a.identityKey === params.identityKey)) await this.migrate(connection, threadId);
    }
    const owners = new Map<string, { threadId: string; archived: boolean }>();
    let cursor: string | null = null;
    do {
      const result: JsonObject = await connection.upstream.request("thread/attachmentOwner/list", { ...params, archived: null, cursor, limit: 100 });
      for (const owner of result.data) {
        const threadId = this.gateway.meta.rewrites.get(owner.threadId) ?? owner.threadId;
        const archived = this.gateway.claude.owns(threadId) ? this.gateway.meta.isArchived(threadId) : owner.archived;
        if (params.archived == null || params.archived === archived) owners.set(threadId, { threadId, archived });
      }
      cursor = result.nextCursor;
    } while (cursor);
    for (const [threadId, attachments] of Object.entries(this.gateway.meta.threadAttachments)) {
      const archived = this.gateway.meta.isArchived(threadId);
      if ((params.archived == null || params.archived === archived) && attachments.some(a => a.attachmentType === params.attachmentType && a.identityKey === params.identityKey)) owners.set(threadId, { threadId, archived });
    }
    return page([...owners.values()], params, JSON.stringify([params.attachmentType, params.identityKey, params.archived ?? null]));
  }
}
