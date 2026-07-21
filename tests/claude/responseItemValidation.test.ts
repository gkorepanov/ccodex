import { describe, expect, it } from "vitest";
import { validateResponseItems } from "../../src/claude/responseItemValidation.js";
import { rpcError, RpcError } from "../../src/protocol/errors.js";

describe("pinned ResponseItem validation", () => {
  it("accepts every pinned shape including additional_tools", () => {
    expect(() => validateResponseItems([
      { type: "additional_tools", role: "system", tools: [{ type: "function", name: "x" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      {
        type: "reasoning", summary: [{ type: "summary_text", text: "why" }],
        encrypted_content: null,
      },
      { type: "function_call", name: "x", arguments: "{}", call_id: "call-1" },
      { type: "function_call_output", call_id: "call-1", output: "ok" },
      { type: "compaction_summary", encrypted_content: "opaque" },
      { type: "compaction_trigger" },
      { type: "web_search_call", action: { type: "future_action", payload: { additive: true } } },
      { type: "other" },
      { type: "future_response_item", payload: { additive: true } },
    ])).not.toThrow();
  });

  it("implements serde aliases and Other fallbacks without accepting malformed known tags", () => {
    for (const item of [
      { type: "future_response_item", payload: { additive: true } },
      { type: "web_search_call", action: { type: "future_action", payload: { additive: true } } },
      { type: "other", future: true },
      {
        type: "additional_tools",
        role: "system",
        tools: [{ type: "input_image", image_url: "https://example.com/tool-description.png" }],
      },
    ]) expect(() => validateResponseItems([item])).not.toThrow();

    for (const item of [
      { type: "additional_tools", role: "system", tools: "not-an-array" },
      { type: "compaction_summary" },
      { type: "web_search_call", action: { type: "search", query: 42 } },
      { type: "message", role: "user", content: [{ type: "future_content" }] },
      { type: 42 },
    ]) expect(() => validateResponseItems([item])).toThrow("items[0] is not a valid response item");
  });

  it("reports the exact item index and JSON-RPC invalid-request code", () => {
    expect(() => validateResponseItems([
      { type: "message", role: "user", content: [] },
      { type: "function_call" },
    ])).toThrow("items[1] is not a valid response item");
    try {
      validateResponseItems([{ type: "function_call" }]);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RpcError);
      expect(rpcError(error)).toEqual({
        code: -32600,
        message: expect.stringContaining("items[0] is not a valid response item"),
      });
    }
  });

  it("matches pinned remote image rejection for messages and tool outputs", () => {
    for (const item of [
      { type: "message", role: "user", content: [{ type: "input_image", image_url: "HTTPS://example.com/a.png" }] },
      { type: "function_call_output", call_id: "call", output: [
        { type: "input_image", image_url: "HtTp://example.com/a.png" },
      ] },
      { type: "custom_tool_call_output", call_id: "call", output: [
        { type: "input_image", image_url: "http://example.com/a.png" },
      ] },
    ]) {
      expect(() => validateResponseItems([item]))
        .toThrow("remote image URLs are not supported; use an inline data URL instead");
    }
    expect(() => validateResponseItems([{
      type: "message", role: "user", content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
    }])).not.toThrow();
  });
});
