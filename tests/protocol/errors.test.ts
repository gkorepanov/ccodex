import { describe, expect, it } from "vitest";
import { rpcCodexErrorInfo } from "../../src/protocol/errors.js";

describe("rpcCodexErrorInfo", () => {
  it("maps protocol failures to Codex chat error categories", () => {
    expect(rpcCodexErrorInfo(-32601)).toBe("badRequest");
    expect(rpcCodexErrorInfo(-32602)).toBe("badRequest");
    expect(rpcCodexErrorInfo(-32600)).toBe("badRequest");
    expect(rpcCodexErrorInfo(-32603)).toBe("internalServerError");
    expect(rpcCodexErrorInfo(-32000)).toBe("other");
  });
});
