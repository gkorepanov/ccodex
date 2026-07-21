import type { CodexErrorInfo } from "../codex/generated/v2/CodexErrorInfo.js";

export class RpcError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export function invalidParams(message: string): RpcError {
  return new RpcError(-32602, message);
}

export function invalidRequest(message: string): RpcError {
  return new RpcError(-32600, message);
}

export function rpcCodexErrorInfo(code: number): CodexErrorInfo {
  if (code === -32600 || code === -32601 || code === -32602) return "badRequest";
  if (code === -32603) return "internalServerError";
  return "other";
}

export function rpcError(error: unknown): { code: number; message: string } {
  if (error instanceof RpcError) return { code: error.code, message: error.message };
  return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}
