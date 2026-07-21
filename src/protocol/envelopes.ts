export type RequestId = string | number;

export interface RpcRequest {
  readonly method: string;
  readonly id: RequestId;
  readonly params?: unknown;
}

export interface RpcNotification {
  readonly method: string;
  readonly params?: unknown;
}

export interface RpcSuccess {
  readonly id: RequestId;
  readonly result: unknown;
}

export interface RpcFailure {
  readonly id: RequestId;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type RpcMessage = RpcRequest | RpcNotification | RpcSuccess | RpcFailure;

export function parseRpcMessage(data: RawData): RpcMessage | undefined {
  try {
    const value = JSON.parse(data.toString()) as unknown;
    return value !== null && typeof value === "object" ? (value as RpcMessage) : undefined;
  } catch {
    return undefined;
  }
}

export function isRequest(message: RpcMessage): message is RpcRequest {
  return "method" in message && "id" in message;
}

export function isResponse(message: RpcMessage): message is RpcSuccess | RpcFailure {
  return "id" in message && !("method" in message);
}
import type { RawData } from "ws";
