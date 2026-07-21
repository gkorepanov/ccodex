import { v7 as uuidv7 } from "uuid";
import type WebSocket from "ws";
import { WebSocket as WebSocketState } from "ws";
import { isResponse, type RequestId, type RpcFailure, type RpcMessage, type RpcSuccess } from "../protocol/envelopes.js";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

export class StockRpc {
  private readonly pending = new Map<RequestId, PendingRequest>();
  private readonly opened: Promise<void>;
  private connectionError?: Error;

  public constructor(private readonly socket: WebSocket) {
    this.opened = socket.readyState === WebSocketState.OPEN
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          socket.once("open", resolve);
          socket.once("error", (error) => {
            this.fail(error);
            resolve();
          });
          socket.once("close", () => {
            this.fail(new Error("Stock app-server connection closed."));
            resolve();
          });
        });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("Stock app-server connection closed.")));
  }

  public handle(message: RpcMessage): boolean {
    if (!isResponse(message)) return false;
    const pending = this.pending.get(message.id);
    if (!pending) return false;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if ("error" in message) {
      pending.reject(new Error((message as RpcFailure).error.message));
    } else {
      pending.resolve((message as RpcSuccess).result);
    }
    return true;
  }

  public async request(method: string, params: unknown): Promise<unknown> {
    await this.opened;
    if (this.connectionError) throw this.connectionError;
    if (this.socket.readyState !== WebSocketState.OPEN) {
      throw new Error("Stock app-server connection is not open.");
    }
    const id = `hyb-stock:${uuidv7()}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Stock request '${method}' timed out.`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ method, id, params }), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error);
      });
    });
  }

  public async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "ccodex-handoff-worker",
        title: "CCodex Handoff Worker",
        version: "unknown",
      },
      capabilities: { experimentalApi: true },
    });
  }

  public async respond(id: RequestId, result: unknown): Promise<void> {
    await this.opened;
    if (this.connectionError) throw this.connectionError;
    if (this.socket.readyState !== WebSocketState.OPEN) {
      throw new Error("Stock app-server connection is not open.");
    }
    await new Promise<void>((resolve, reject) => {
      const rpcError = result && typeof result === "object" && "rpcError" in result
        ? (result as { rpcError: unknown }).rpcError
        : undefined;
      this.socket.send(JSON.stringify(rpcError === undefined ? { id, result } : { id, error: rpcError }),
        (error) => error ? reject(error) : resolve());
    });
  }

  public close(error: Error): void {
    this.fail(error);
  }

  private fail(error: Error): void {
    this.connectionError ??= error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(this.connectionError);
    }
    this.pending.clear();
  }
}
