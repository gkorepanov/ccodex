import { describe, expect, it } from "vitest";
import {
  ClaudeMailbox,
  ClaudeMailboxClosedError,
  DEFAULT_CLAUDE_MAILBOX_CAPACITY,
  createDeferred,
} from "../../../src/claude/session/mailbox.js";

type Command = { readonly kind: string; readonly value: string };

const command = (value: string, kind = "command"): Command => ({ kind, value });
const provider = {
  lane: "provider" as const,
  coalesce: {
    key: "text:item-1",
    merge: (previous: Command, next: Command): Command =>
      command(previous.value + next.value, "provider"),
  },
};

async function nextValue(iterator: AsyncIterator<{ command: Command }>): Promise<string> {
  const result = await iterator.next();
  if (result.done) throw new Error("Mailbox ended unexpectedly.");
  return result.value.command.value;
}

describe("ClaudeMailbox", () => {
  it("uses the stock-sized default bounded capacity", () => {
    expect(new ClaudeMailbox<Command>().capacity).toBe(DEFAULT_CLAUDE_MAILBOX_CAPACITY);
    expect(DEFAULT_CLAUDE_MAILBOX_CAPACITY).toBe(512);
    expect(() => new ClaudeMailbox<Command>(0)).toThrow(RangeError);
  });

  it("preserves global FIFO across normal and provider lanes", async () => {
    const mailbox = new ClaudeMailbox<Command>();
    await mailbox.enqueue({ command: command("normal-1") });
    await mailbox.enqueue({ command: command("provider-1") }, { lane: "provider" });
    await mailbox.enqueue({ command: command("normal-2") });
    await mailbox.enqueue({ command: command("provider-2") }, { lane: "provider" });
    const iterator = mailbox[Symbol.asyncIterator]();

    expect(await nextValue(iterator)).toBe("normal-1");
    expect(await nextValue(iterator)).toBe("provider-1");
    expect(await nextValue(iterator)).toBe("normal-2");
    expect(await nextValue(iterator)).toBe("provider-2");
  });

  it("admits and dispatches control ahead of queued regular traffic", async () => {
    const mailbox = new ClaudeMailbox<Command>();
    await mailbox.enqueue({ command: command("normal") });
    await mailbox.enqueue({ command: command("provider") }, { lane: "provider" });
    await mailbox.enqueue({ command: command("interrupt") }, { lane: "control" });
    const iterator = mailbox[Symbol.asyncIterator]();

    expect(await nextValue(iterator)).toBe("interrupt");
    expect(await nextValue(iterator)).toBe("normal");
    expect(await nextValue(iterator)).toBe("provider");
  });

  it("enforces a single consumer", () => {
    const mailbox = new ClaudeMailbox<Command>();
    mailbox[Symbol.asyncIterator]();
    expect(() => mailbox[Symbol.asyncIterator]()).toThrow("exactly one consumer");
  });

  it("backpressures producers until bounded capacity is released", async () => {
    const mailbox = new ClaudeMailbox<Command>(2);
    await mailbox.enqueue({ command: command("one") });
    await mailbox.enqueue({ command: command("two") });
    let admitted = false;
    const third = mailbox.enqueue({ command: command("three") }).then(() => {
      admitted = true;
    });
    await Promise.resolve();

    expect(mailbox.size).toBe(2);
    expect(mailbox.pendingAdmissions).toBe(1);
    expect(admitted).toBe(false);

    const iterator = mailbox[Symbol.asyncIterator]();
    expect(await nextValue(iterator)).toBe("one");
    await third;
    expect(admitted).toBe(true);
    expect(mailbox.size).toBe(2);
    expect(await nextValue(iterator)).toBe("two");
    expect(await nextValue(iterator)).toBe("three");
  });

  it("limits control latency to one already-dispatched provider fact under flood", async () => {
    const mailbox = new ClaudeMailbox<Command>(3);
    await mailbox.enqueue({ command: command("p1") }, { lane: "provider" });
    await mailbox.enqueue({ command: command("p2") }, { lane: "provider" });
    await mailbox.enqueue({ command: command("p3") }, { lane: "provider" });
    const p4 = mailbox.enqueue({ command: command("p4") }, { lane: "provider" });
    const interrupt = mailbox.enqueue({ command: command("stop") }, { lane: "control" });
    const iterator = mailbox[Symbol.asyncIterator]();

    expect(await nextValue(iterator)).toBe("p1");
    await interrupt;
    expect(await nextValue(iterator)).toBe("stop");
    await p4;
    expect(await nextValue(iterator)).toBe("p2");
    expect(await nextValue(iterator)).toBe("p3");
    expect(await nextValue(iterator)).toBe("p4");
  });

  it("coalesces only adjacent completion-free provider deltas", async () => {
    const mailbox = new ClaudeMailbox<Command>();
    await mailbox.enqueue({ command: command("a", "provider") }, provider);
    await mailbox.enqueue({ command: command("b", "provider") }, provider);
    await mailbox.enqueue({ command: command("boundary") });
    await mailbox.enqueue({ command: command("c", "provider") }, provider);
    const iterator = mailbox[Symbol.asyncIterator]();

    expect(mailbox.size).toBe(3);
    expect(await nextValue(iterator)).toBe("ab");
    expect(await nextValue(iterator)).toBe("boundary");
    expect(await nextValue(iterator)).toBe("c");
  });

  it("coalesces backpressured provider deltas before admission", async () => {
    const mailbox = new ClaudeMailbox<Command>(1);
    await mailbox.enqueue({ command: command("blocker") });
    let firstAdmitted = false;
    let secondAdmitted = false;
    const first = mailbox.enqueue({ command: command("a", "provider") }, provider).then(() => {
      firstAdmitted = true;
    });
    const second = mailbox.enqueue({ command: command("b", "provider") }, provider).then(() => {
      secondAdmitted = true;
    });
    const iterator = mailbox[Symbol.asyncIterator]();

    expect(mailbox.pendingAdmissions).toBe(1);
    expect(await nextValue(iterator)).toBe("blocker");
    await Promise.all([first, second]);
    expect(firstAdmitted).toBe(true);
    expect(secondAdmitted).toBe(true);
    expect(await nextValue(iterator)).toBe("ab");
  });

  it("does not coalesce RPC envelopes carrying completion handles", async () => {
    const mailbox = new ClaudeMailbox<Command>();
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    await mailbox.enqueue({ command: command("a"), completion: first }, provider);
    await mailbox.enqueue({ command: command("b"), completion: second }, provider);
    const iterator = mailbox[Symbol.asyncIterator]();

    expect(mailbox.size).toBe(2);
    expect(await nextValue(iterator)).toBe("a");
    expect(await nextValue(iterator)).toBe("b");
  });

  it("exposes typed RPC completion without coupling it to dispatch", async () => {
    const mailbox = new ClaudeMailbox<Command>();
    const response = mailbox.submit<number>(command("rpc"));
    const iterator = mailbox[Symbol.asyncIterator]();
    const received = await iterator.next();
    if (received.done) throw new Error("Mailbox ended unexpectedly.");
    received.value.completion?.resolve(42);

    await expect(response).resolves.toBe(42);
  });

  it("drains admitted work but rejects backpressured and future work on close", async () => {
    const mailbox = new ClaudeMailbox<Command>(1);
    await mailbox.enqueue({ command: command("accepted") });
    const rejected = mailbox.enqueue({ command: command("backpressured") });
    const error = new ClaudeMailboxClosedError("shutdown");
    mailbox.close(error);

    await expect(rejected).rejects.toBe(error);
    await expect(mailbox.enqueue({ command: command("future") })).rejects.toBe(error);
    const iterator = mailbox[Symbol.asyncIterator]();
    expect(await nextValue(iterator)).toBe("accepted");
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("wakes an idle consumer and makes close idempotent", async () => {
    const mailbox = new ClaudeMailbox<Command>();
    const iterator = mailbox[Symbol.asyncIterator]();
    const waiting = iterator.next();
    const first = new ClaudeMailboxClosedError("first");
    mailbox.close(first);
    mailbox.close(new ClaudeMailboxClosedError("second"));

    await expect(waiting).resolves.toEqual({ value: undefined, done: true });
    await expect(mailbox.enqueue({ command: command("late") })).rejects.toBe(first);
  });

  it("rejects pending RPC completion and queued completion when the consumer stops", async () => {
    const mailbox = new ClaudeMailbox<Command>(1);
    const queued = mailbox.submit<string>(command("queued"));
    const pending = mailbox.submit<string>(command("pending"));
    const iterator = mailbox[Symbol.asyncIterator]();
    await iterator.return?.();

    await expect(queued).rejects.toThrow("consumer stopped");
    await expect(pending).rejects.toThrow("consumer stopped");
    expect(mailbox.size).toBe(0);
  });

  it("rejects invalid coalescing lanes without admitting the envelope", async () => {
    const mailbox = new ClaudeMailbox<Command>();
    await expect(mailbox.enqueue(
      { command: command("bad") },
      { lane: "normal", coalesce: provider.coalesce },
    )).rejects.toThrow("Only provider-lane");
    expect(mailbox.size).toBe(0);
  });
});
