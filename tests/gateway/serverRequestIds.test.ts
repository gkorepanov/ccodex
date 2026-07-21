import { describe, expect, it } from "vitest";
import { ServerRequestIds } from "../../src/gateway/serverRequestIds.js";

describe("ServerRequestIds", () => {
  it("projects durable approval ids to stable connection-local numeric ids", () => {
    const ids = new ServerRequestIds();
    const internal = "hyb-claude-request:durable-id";
    const wire = ids.wireId(internal);
    expect(wire).toBe(1);
    expect(ids.wireId(internal)).toBe(wire);
    expect(ids.internalId(wire)).toBe(internal);
    ids.release(internal);
    expect(ids.internalId(wire)).toBeUndefined();
    expect(ids.wireId(internal)).toBe(2);
  });

  it("keeps legacy string responses compatible during rolling upgrades", () => {
    const ids = new ServerRequestIds();
    expect(ids.internalId("hyb-claude-request:legacy")).toBe("hyb-claude-request:legacy");
    expect(ids.internalId("client-request")).toBeUndefined();
  });
});
