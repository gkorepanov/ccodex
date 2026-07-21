import { describe, expect, it } from "vitest";
import { CursorCodec, queryFingerprint } from "../../src/protocol/cursor.js";
import { rpcError } from "../../src/protocol/errors.js";

describe("signed hybrid cursors", () => {
  it("round-trips scoped payloads and rejects tampering", () => {
    const codec = new CursorCodec(Buffer.alloc(32, 7));
    const cursor = codec.encode("thread", { offset: 2, query: queryFingerprint({ archived: false }) });
    expect(codec.decode("thread", cursor)).toEqual({ offset: 2, query: queryFingerprint({ archived: false }) });
    expect(() => codec.decode("thread", `${cursor.slice(0, -1)}x`)).toThrow("signature");
    expect(() => codec.decode("model", cursor)).toThrow("Invalid hybrid model cursor");
    try {
      codec.decode("model", cursor);
    } catch (error) {
      expect(rpcError(error)).toEqual({ code: -32602, message: "Invalid hybrid model cursor." });
    }
  });
});
