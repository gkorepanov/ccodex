import { createHash } from "node:crypto";

export interface LogicalThreadProjection {
  readonly publicThreadId: string;
  readonly backendThreadId: string;
  readonly itemNamespace?: string;
}

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as ObjectValue
    : undefined;
}

function rewriteThread(threadValue: unknown, sourceThreadId: string, targetThreadId: string): unknown {
  const thread = object(threadValue);
  if (!thread) return threadValue;
  let projected = thread;
  if (thread.id === sourceThreadId) projected = { ...projected, id: targetThreadId };
  if (thread.forkedFromId === sourceThreadId) projected = { ...projected, forkedFromId: targetThreadId };
  return projected === thread ? threadValue : projected;
}

function rewriteParams(paramsValue: unknown, sourceThreadId: string, targetThreadId: string): unknown {
  const params = object(paramsValue);
  if (!params) return paramsValue;
  let projected = params;
  if (params.threadId === sourceThreadId) projected = { ...projected, threadId: targetThreadId };
  const thread = rewriteThread(params.thread, sourceThreadId, targetThreadId);
  if (thread !== params.thread) projected = { ...projected, thread };
  return projected === params ? paramsValue : projected;
}

function rewriteResult(resultValue: unknown, sourceThreadId: string, targetThreadId: string): unknown {
  const result = object(resultValue);
  if (!result) return resultValue;
  const thread = rewriteThread(result.thread, sourceThreadId, targetThreadId);
  return thread === result.thread ? resultValue : { ...result, thread };
}

function rewriteRpcThreadIds<T extends object>(
  message: T,
  sourceThreadId: string,
  targetThreadId: string,
): T {
  if (sourceThreadId === targetThreadId) return message;
  const rpc = message as T & ObjectValue;
  const params = rewriteParams(rpc.params, sourceThreadId, targetThreadId);
  const result = rewriteResult(rpc.result, sourceThreadId, targetThreadId);
  if (params === rpc.params && result === rpc.result) return message;
  let projected = rpc;
  if (params !== rpc.params) projected = { ...projected, params };
  if (result !== rpc.result) projected = { ...projected, result };
  return projected;
}

const publicItemPrefix = "ccodex-item-";

/** Stable App-facing identity for a provider item within one immutable provider epoch. */
export function publicItemId(itemNamespace: string, providerItemId: string): string {
  if (providerItemId.startsWith(publicItemPrefix)) return providerItemId;
  return `${publicItemPrefix}${createHash("sha256")
    .update(itemNamespace)
    .update("\0")
    .update(providerItemId)
    .digest("hex")
    .slice(0, 32)}`;
}

function rewriteItemIds(value: unknown, itemNamespace: string, itemRoot = false): unknown {
  if (Array.isArray(value)) {
    let projected = value;
    for (let index = 0; index < value.length; index += 1) {
      const next = rewriteItemIds(value[index], itemNamespace, itemRoot);
      if (next === value[index]) continue;
      if (projected === value) projected = [...value];
      projected[index] = next;
    }
    return projected;
  }
  const record = object(value);
  if (!record) return value;
  let projected = record;
  for (const [key, child] of Object.entries(record)) {
    let next = child;
    if ((key === "itemId" || (itemRoot && key === "id")) && typeof child === "string") {
      next = publicItemId(itemNamespace, child);
    } else if (key === "item") {
      next = rewriteItemIds(child, itemNamespace, true);
    } else if (key === "items" && Array.isArray(child)) {
      next = child.map((item) => rewriteItemIds(item, itemNamespace, true));
    } else {
      next = rewriteItemIds(child, itemNamespace);
    }
    if (next === child) continue;
    if (projected === record) projected = { ...record };
    projected[key] = next;
  }
  return projected === record ? value : projected;
}

/** Project provider-native item IDs without touching arbitrary IDs or provider state. */
export function projectItemIds<T>(value: T, itemNamespace: string): T {
  return rewriteItemIds(value, itemNamespace) as T;
}

/** Project backend-owned RPC envelopes onto their stable public thread identity. */
export function projectRpcToPublicThread<T extends object>(message: T, owner: LogicalThreadProjection): T {
  const projected = rewriteRpcThreadIds(message, owner.backendThreadId, owner.publicThreadId);
  return owner.itemNamespace ? projectItemIds(projected, owner.itemNamespace) : projected;
}

/** Project public App RPC envelopes onto the provider backend that owns the thread epoch. */
export function projectRpcToBackendThread<T extends object>(message: T, owner: LogicalThreadProjection): T {
  return rewriteRpcThreadIds(message, owner.publicThreadId, owner.backendThreadId);
}
