import { describe, expect, it, vi } from "vitest";
import {
  ClaudeSessionRegistry,
  type ClaudeSessionHandle,
} from "../../src/claude/sessionRegistry.js";

type Command = { readonly value: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function session(name: string, close = vi.fn(async () => undefined)): ClaudeSessionHandle<Command> & {
  readonly name: string;
  readonly close: typeof close;
} {
  return {
    name,
    close,
    async submit<Result>(command: Command): Promise<Result> {
      return `${name}:${command.value}` as Result;
    },
  };
}

describe("ClaudeSessionRegistry", () => {
  it("single-flights concurrent lazy materialization", async () => {
    const materialized = deferred<ReturnType<typeof session>>();
    const factory = vi.fn(() => materialized.promise);
    const registry = new ClaudeSessionRegistry(factory);

    const first = registry.getOrCreate("root");
    const second = registry.getOrCreate("root");
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());

    const root = session("root");
    materialized.resolve(root);
    expect(await first).toBe(root);
    expect(await second).toBe(root);
    expect(factory).toHaveBeenCalledWith("root");
  });

  it("routes child lookup and submission to its owner session", async () => {
    const factory = vi.fn((threadId: string) => session(threadId));
    const registry = new ClaudeSessionRegistry<Command>(factory);
    registry.registerChild("child", "root");

    expect(registry.ownerOf("child")).toBe("root");
    expect(await registry.getOrCreate("child")).toBe(await registry.getOrCreate("root"));
    expect(await registry.submit<string>("child", { value: "stop" })).toBe("root:stop");
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith("root");
    registry.unregisterChild("child");
    expect(registry.ownerOf("child")).toBe("child");
  });

  it("keeps root, side, and fork conversations independent", async () => {
    const factory = vi.fn((threadId: string) => session(threadId));
    const registry = new ClaudeSessionRegistry(factory);

    const [root, side, fork] = await Promise.all([
      registry.getOrCreate("root"),
      registry.getOrCreate("side"),
      registry.getOrCreate("fork"),
    ]);

    expect(new Set([root, side, fork])).toHaveLength(3);
    expect(factory.mock.calls.map(([threadId]) => threadId).sort()).toEqual(["fork", "root", "side"]);
    expect(registry.activeOwnerIds().sort()).toEqual(["fork", "root", "side"]);
  });

  it("waits for retirement before rematerializing the owner", async () => {
    const closeStarted = deferred<void>();
    const allowClose = deferred<void>();
    const first = session("first", vi.fn(async () => {
      closeStarted.resolve();
      await allowClose.promise;
    }));
    const second = session("second");
    const factory = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const registry = new ClaudeSessionRegistry(factory);
    expect(await registry.getOrCreate("root")).toBe(first);

    const retiring = registry.retire("root");
    await closeStarted.promise;
    expect(registry.activeOwnerIds()).toEqual([]);
    const replacement = registry.getOrCreate("root");
    expect(factory).toHaveBeenCalledOnce();

    allowClose.resolve();
    await retiring;
    expect(await replacement).toBe(second);
    expect(first.close).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("retires an owner that is still materializing without leaking a session", async () => {
    const materialized = deferred<ReturnType<typeof session>>();
    const first = session("first");
    const second = session("second");
    const factory = vi.fn()
      .mockImplementationOnce(() => materialized.promise)
      .mockResolvedValueOnce(second);
    const registry = new ClaudeSessionRegistry(factory);

    const pending = registry.getOrCreate("root");
    const retiring = registry.retire("root");
    materialized.resolve(first);

    expect(await pending).toBe(first);
    await retiring;
    expect(first.close).toHaveBeenCalledOnce();
    expect(await registry.getOrCreate("root")).toBe(second);
  });

  it("closes sessions that finish materializing during shutdown", async () => {
    const materialized = deferred<ReturnType<typeof session>>();
    const root = session("root");
    const registry = new ClaudeSessionRegistry(() => materialized.promise);

    const pending = registry.getOrCreate("root");
    const closing = registry.close();
    await expect(registry.getOrCreate("other")).rejects.toThrow("registry is closed");
    materialized.resolve(root);

    expect(await pending).toBe(root);
    await closing;
    await registry.close();
    expect(root.close).toHaveBeenCalledOnce();
    await expect(registry.submit("root", { value: "late" })).rejects.toThrow("registry is closed");
  });

  it("does not poison an owner after materialization failure", async () => {
    const failed = new Error("materialization failed");
    const recovered = session("recovered");
    const factory = vi.fn()
      .mockRejectedValueOnce(failed)
      .mockResolvedValueOnce(recovered);
    const registry = new ClaudeSessionRegistry(factory);

    const first = registry.getOrCreate("root");
    const second = registry.getOrCreate("root");
    await expect(first).rejects.toBe(failed);
    await expect(second).rejects.toBe(failed);
    expect(factory).toHaveBeenCalledOnce();

    expect(await registry.getOrCreate("root")).toBe(recovered);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("rejects ownership changes and independent-session aliasing", async () => {
    const registry = new ClaudeSessionRegistry((threadId) => session(threadId));
    registry.registerChild("child", "root");
    registry.registerChild("child", "root");
    expect(() => registry.registerChild("child", "other")).toThrow("already owned");

    await registry.getOrCreate("side");
    expect(() => registry.registerChild("side", "root")).toThrow("independent Claude session");
  });
});
