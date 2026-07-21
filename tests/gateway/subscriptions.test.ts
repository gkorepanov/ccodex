import { describe, expect, it } from "vitest";
import { SubscriptionHub } from "../../src/gateway/subscriptions.js";

describe("SubscriptionHub", () => {
  it("broadcasts global thread lifecycle once while keeping turn details scoped", () => {
    const hub = new SubscriptionHub();
    const desktop: string[] = [];
    const mobile: string[] = [];
    hub.attach("desktop", (method) => desktop.push(method));
    hub.attach("mobile", (method) => mobile.push(method));
    hub.subscribe("thread-1", "mobile", (method) => mobile.push(method));

    hub.emit("thread-1", "thread/started", {});
    hub.emit("thread-1", "thread/status/changed", {});
    hub.emit("thread-1", "item/started", {});

    expect(desktop).toEqual(["thread/started", "thread/status/changed"]);
    expect(mobile).toEqual(["thread/started", "thread/status/changed", "item/started"]);
    hub.detach("desktop");
    hub.emit("thread-1", "thread/name/updated", {});
    expect(desktop).toHaveLength(2);
    expect(mobile.at(-1)).toBe("thread/name/updated");
  });

  it("delivers unsubscribed child requests to attached clients and broadcasts their resolution", () => {
    const hub = new SubscriptionHub();
    const desktop: string[] = [];
    const mobile: string[] = [];
    const resolved: string[] = [];
    hub.attach("desktop", (method) => resolved.push(`desktop:${method}`), (_id, method) => desktop.push(method));
    hub.attach("mobile", (method) => resolved.push(`mobile:${method}`), (_id, method) => mobile.push(method));
    hub.subscribe("parent", "desktop", () => undefined, (_id, method) => desktop.push(`parent:${method}`));

    hub.request("child", "request-1", "item/commandExecution/requestApproval", {});
    hub.emit("child", "serverRequest/resolved", { threadId: "child", requestId: "request-1" });

    expect(desktop).toEqual(["item/commandExecution/requestApproval"]);
    expect(mobile).toEqual(["item/commandExecution/requestApproval"]);
    expect(resolved).toEqual(["desktop:serverRequest/resolved", "mobile:serverRequest/resolved"]);
  });

  it("mutes both global and scoped notifications for one snapshot connection", () => {
    const hub = new SubscriptionHub();
    const desktop: string[] = [];
    const mobile: string[] = [];
    hub.attach("desktop", (method) => desktop.push(method));
    hub.attach("mobile", (method) => mobile.push(method));
    hub.subscribe("thread-1", "desktop", (method) => desktop.push(method));
    hub.subscribe("thread-1", "mobile", (method) => mobile.push(method));
    hub.mute("thread-1", "desktop");

    hub.emit("thread-1", "thread/status/changed", {});
    hub.emit("thread-1", "item/completed", {});
    hub.unmute("thread-1", "desktop");
    hub.emit("thread-1", "item/started", {});

    expect(desktop).toEqual(["item/started"]);
    expect(mobile).toEqual(["thread/status/changed", "item/completed", "item/started"]);
  });

  it("resolves an approval only on connections that received its request", () => {
    const hub = new SubscriptionHub();
    const desktop: string[] = [];
    const mobile: string[] = [];
    hub.attach("desktop", (method) => desktop.push(method), () => undefined);
    hub.attach("mobile", (method) => mobile.push(method), () => undefined);
    hub.subscribe("thread-1", "mobile", (method) => mobile.push(method), () => undefined);

    hub.request("thread-1", "request-1", "item/commandExecution/requestApproval", {});
    hub.emit("thread-1", "serverRequest/resolved", { threadId: "thread-1", requestId: "request-1" });

    expect(desktop).toEqual([]);
    expect(mobile).toEqual(["serverRequest/resolved"]);
  });

  it("projects an active provider epoch onto one stable public thread id", () => {
    const hub = new SubscriptionHub();
    const notifications: unknown[] = [];
    const requests: unknown[] = [];
    hub.attach("desktop", () => undefined);
    hub.subscribe(
      "public-thread",
      "desktop",
      (_method, params) => notifications.push(params),
      (_id, _method, params) => requests.push(params),
    );
    hub.aliasThread("backend-thread", "public-thread");

    expect(hub.hasSubscribers("backend-thread")).toBe(true);
    hub.emit("backend-thread", "turn/started", {
      threadId: "backend-thread",
      turn: { id: "provider-turn", items: [] },
    });
    hub.request("backend-thread", "approval-1", "item/commandExecution/requestApproval", {
      threadId: "backend-thread",
      turnId: "provider-turn",
      command: "echo backend-thread",
    });

    expect(notifications).toEqual([expect.objectContaining({ threadId: "public-thread" })]);
    expect(requests).toEqual([expect.objectContaining({
      threadId: "public-thread",
      command: "echo backend-thread",
    })]);
  });

  it("hides the migrated target user item until the target turn completes", () => {
    const hub = new SubscriptionHub();
    const received: Array<{ method: string; params: any }> = [];
    hub.subscribe("public-thread", "desktop", (method, params) => received.push({ method, params }));
    hub.aliasThread("backend-thread", "public-thread");
    hub.hideUserMessages("backend-thread", "target-turn");
    const user = { type: "userMessage", id: "user", content: [] };
    const agent = { type: "agentMessage", id: "agent", text: "ok", phase: "final_answer" };

    hub.emit("backend-thread", "turn/started", {
      threadId: "backend-thread",
      turn: { id: "target-turn", items: [user, agent], status: "inProgress" },
    });
    hub.emit("backend-thread", "item/started", {
      threadId: "backend-thread",
      turnId: "target-turn",
      item: user,
    });
    hub.emit("backend-thread", "item/completed", {
      threadId: "backend-thread",
      turnId: "target-turn",
      item: agent,
    });
    hub.emit("backend-thread", "turn/completed", {
      threadId: "backend-thread",
      turn: { id: "target-turn", items: [user, agent], status: "completed" },
    });

    expect(received.filter((event) => event.method.startsWith("item/"))).toEqual([
      expect.objectContaining({ method: "item/completed" }),
    ]);
    expect(received.filter((event) => event.method.startsWith("turn/")).every((event) =>
      event.params.turn.items.every((item: any) => item.type !== "userMessage"))).toBe(true);
  });

  it("delivers logical lifecycle after the colliding original backend id is suppressed", () => {
    const hub = new SubscriptionHub();
    const methods: string[] = [];
    hub.subscribe("public-thread", "desktop", (method) => methods.push(method));
    hub.suppress("public-thread");

    hub.emit("public-thread", "turn/completed", {});
    hub.emitPublic("public-thread", "turn/completed", { threadId: "public-thread" });

    expect(methods).toEqual(["turn/completed"]);
  });
});
