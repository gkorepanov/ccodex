import { describe, expect, it } from "vitest";
import { wrapUpQuestion } from "../../../src/claude/native/projector.js";

describe("Claude App wrap-up buttons", () => {
  it("become stock's async question with the reply labels", () => {
    expect(wrapUpQuestion("toolu_1", {
      recap: "done", ask: "要一起发吗？", actions: [{ label: "一起发" }, { label: "等那边先发" }],
    })).toEqual([{
      type: "agentMessage", id: "toolu_1-ask", text: "要一起发吗？", phase: "final_answer", memoryCitation: null,
      delivery: "async", questions: [{ title: "要一起发吗？", options: ["一起发", "等那边先发"] }],
    }]);
  });

  it("names an App action that has no label", () => {
    expect(wrapUpQuestion("t", { ask: "Commit?", actions: [{ action: "commit" }, { label: "Not now" }] })[0])
      .toMatchObject({ questions: [{ title: "Commit?", options: ["Commit", "Not now"] }] });
  });

  it("adds nothing for a recap without a question or buttons", () => {
    expect(wrapUpQuestion("t", { recap: "done" })).toEqual([]);
    expect(wrapUpQuestion("t", { ask: "Which?", actions: [] })).toEqual([]);
    expect(wrapUpQuestion("t", undefined)).toEqual([]);
  });
});
