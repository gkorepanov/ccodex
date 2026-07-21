export interface LogicalThreadProjection {
  readonly publicThreadId: string;
  readonly backendThreadId: string;
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

/** Project backend-owned RPC envelopes onto their stable public thread identity. */
export function projectRpcToPublicThread<T extends object>(message: T, owner: LogicalThreadProjection): T {
  return rewriteRpcThreadIds(message, owner.backendThreadId, owner.publicThreadId);
}

/** Project public App RPC envelopes onto the provider backend that owns the thread epoch. */
export function projectRpcToBackendThread<T extends object>(message: T, owner: LogicalThreadProjection): T {
  return rewriteRpcThreadIds(message, owner.publicThreadId, owner.backendThreadId);
}
