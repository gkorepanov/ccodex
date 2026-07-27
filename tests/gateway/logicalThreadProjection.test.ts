import { describe, expect, it } from "vitest";
import {
  publicItemId,
  projectRpcToBackendThread,
  projectRpcToPublicThread,
  type LogicalThreadProjection,
} from "../../src/gateway/logicalThreadProjection.js";

const owner: LogicalThreadProjection = {
  publicThreadId: "public-thread",
  backendThreadId: "backend-thread",
};

describe("logical thread protocol projection", () => {
  it("projects a client request to its backend owner without touching user input", () => {
    const request = {
      id: 1,
      method: "turn/start",
      params: {
        threadId: "public-thread",
        input: [{ type: "text", text: "public-thread backend-thread" }],
      },
    };

    const projected = projectRpcToBackendThread(request, owner);

    expect(projected).toEqual({
      ...request,
      params: { ...request.params, threadId: "backend-thread" },
    });
    expect(Object.hasOwn(projected, "result")).toBe(false);
    expect(Object.hasOwn(projected.params, "thread")).toBe(false);
    expect(projected.params.input).toBe(request.params.input);
    expect(request.params.threadId).toBe("public-thread");
  });

  it("projects notification thread roots and only owner-matching lineage", () => {
    const notification = {
      method: "thread/started",
      params: {
        thread: {
          id: "backend-thread",
          forkedFromId: "backend-thread",
          preview: "backend-thread must stay text",
        },
      },
    };

    expect(projectRpcToPublicThread(notification, owner)).toEqual({
      method: "thread/started",
      params: {
        thread: {
          id: "public-thread",
          forkedFromId: "public-thread",
          preview: "backend-thread must stay text",
        },
      },
    });

    const foreignParent = {
      ...notification,
      params: { thread: { ...notification.params.thread, forkedFromId: "another-backend-thread" } },
    };
    expect(projectRpcToPublicThread(foreignParent, owner).params.thread.forkedFromId)
      .toBe("another-backend-thread");
  });

  it("projects response thread roots in both directions", () => {
    const backendResponse = {
      id: "read",
      result: {
        thread: { id: "backend-thread", forkedFromId: null, name: "backend-thread is a valid title" },
      },
    };
    const publicResponse = projectRpcToPublicThread(backendResponse, owner);
    expect(publicResponse.result.thread).toEqual({
      id: "public-thread",
      forkedFromId: null,
      name: "backend-thread is a valid title",
    });
    expect(projectRpcToBackendThread(publicResponse, owner).result.thread).toEqual(backendResponse.result.thread);
  });

  it.each([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
  ])("projects %s server requests", (method) => {
    const request = {
      id: 42,
      method,
      params: {
        threadId: "backend-thread",
        turnId: "turn-1",
        itemId: "item-1",
        reason: "backend-thread needs approval",
        command: "printf backend-thread",
      },
    };

    const projected = projectRpcToPublicThread(request, owner);
    expect(projected.params).toEqual({ ...request.params, threadId: "public-thread" });
    expect(projected.id).toBe(42);
    expect(projected.method).toBe(method);
  });

  it("does not recursively rewrite text, tool output, or nested protocol payloads", () => {
    const notification = {
      method: "item/completed",
      params: {
        threadId: "backend-thread",
        text: "backend-thread",
        item: {
          type: "commandExecution",
          threadId: "backend-thread",
          output: "backend-thread",
          metadata: { thread: { id: "backend-thread", forkedFromId: "backend-thread" } },
        },
      },
    };

    const projected = projectRpcToPublicThread(notification, owner);
    expect(projected.params.threadId).toBe("public-thread");
    expect(projected.params.text).toBe("backend-thread");
    expect(projected.params.item).toBe(notification.params.item);
  });

  it("does not invent an unlisted result.threadId projection", () => {
    const response = { id: 1, result: { threadId: "backend-thread", text: "backend-thread" } };
    expect(projectRpcToPublicThread(response, owner)).toBe(response);
  });

  it("gives repeated provider item ids stable epoch-scoped public identities", () => {
    const epochA = { ...owner, itemNamespace: "stock-epoch-a" };
    const epochB = { ...owner, itemNamespace: "stock-epoch-b" };
    const snapshot = {
      result: {
        thread: {
          id: "backend-thread",
          turns: [{
            id: "turn-a",
            itemsView: "full",
            status: "completed",
            items: [{
              type: "agentMessage",
              id: "item-1",
              text: "item-1 stays user-visible text",
              metadata: { id: "item-1" },
            }],
          }],
        },
      },
    };
    const live = {
      method: "item/completed",
      params: {
        threadId: "backend-thread",
        turnId: "turn-a",
        item: { type: "agentMessage", id: "item-1", text: "done" },
      },
    };

    const first = projectRpcToPublicThread(snapshot, epochA);
    const repeated = projectRpcToPublicThread(snapshot, epochA);
    const otherEpoch = projectRpcToPublicThread(snapshot, epochB);
    const liveId = projectRpcToPublicThread(live, epochA).params.item.id;
    const snapshotId = first.result.thread.turns[0]!.items[0]!.id;

    expect(snapshotId).toBe(publicItemId("stock-epoch-a", "item-1"));
    expect(repeated.result.thread.turns[0]!.items[0]!.id).toBe(snapshotId);
    expect(otherEpoch.result.thread.turns[0]!.items[0]!.id).not.toBe(snapshotId);
    expect(liveId).toBe(snapshotId);
    expect(first.result.thread.turns[0]!.items[0]!.text).toContain("item-1");
    expect(first.result.thread.turns[0]!.items[0]!.metadata.id).toBe("item-1");
  });

  it("projects itemId references with the same epoch namespace", () => {
    const projected = projectRpcToPublicThread({
      method: "item/commandExecution/requestApproval",
      params: { threadId: "backend-thread", turnId: "turn-a", itemId: "item-1" },
    }, { ...owner, itemNamespace: "stock-epoch-a" });

    expect(projected.params.itemId).toBe(publicItemId("stock-epoch-a", "item-1"));
  });

  it("returns the original envelope when no known root matches", () => {
    const message = {
      method: "custom/event",
      params: { item: { threadId: "backend-thread" } },
      result: { text: "backend-thread" },
    };
    expect(projectRpcToPublicThread(message, owner)).toBe(message);
  });
});
