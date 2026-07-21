import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { StockRpc } from "../../src/gateway/stockRpc.js";

describe("StockRpc connection lifecycle", () => {
  it("defers an early socket error until a request awaits the connection", async () => {
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send(): void };
    socket.readyState = WebSocket.CONNECTING;
    const rpc = new StockRpc(socket as never);
    socket.emit("error", new Error("stock socket disappeared"));
    await expect(rpc.request("model/list", {})).rejects.toThrow("stock socket disappeared");
  });

  it("rejects immediately after the socket closes instead of waiting for the RPC timeout", async () => {
    const socket = new EventEmitter() as EventEmitter & { readyState: number; send(): void };
    socket.readyState = WebSocket.OPEN;
    const rpc = new StockRpc(socket as never);
    socket.readyState = WebSocket.CLOSED;
    socket.emit("close");
    await expect(rpc.request("thread/start", {})).rejects.toThrow("connection closed");
  });

  it("rejects an in-flight request as soon as the socket closes", async () => {
    const socket = new EventEmitter() as EventEmitter & {
      readyState: number;
      send(data: string, callback: (error?: Error) => void): void;
    };
    socket.readyState = WebSocket.OPEN;
    socket.send = (_data, callback) => callback();
    const rpc = new StockRpc(socket as never);
    const request = rpc.request("thread/start", {});
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.readyState = WebSocket.CLOSED;
    socket.emit("close");
    await expect(request).rejects.toThrow("connection closed");
  });

  it("initializes the detached handoff connection before it serves background jobs", async () => {
    let sent!: { id: string; method: string; params: Record<string, unknown> };
    let rpc!: StockRpc;
    const socket = new EventEmitter() as EventEmitter & {
      readyState: number;
      send(data: string, callback: (error?: Error) => void): void;
    };
    socket.readyState = WebSocket.OPEN;
    socket.send = (data, callback) => {
      sent = JSON.parse(data) as typeof sent;
      callback();
      queueMicrotask(() => rpc.handle({ id: sent.id, result: {} }));
    };
    rpc = new StockRpc(socket as never);

    await rpc.initialize();

    expect(sent).toMatchObject({
      method: "initialize",
      params: {
        clientInfo: { name: "ccodex-handoff-worker" },
        capabilities: { experimentalApi: true },
      },
    });
  });
});
