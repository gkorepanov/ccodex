import { describe, expect, it } from "vitest";
import { claudeCompactCommand } from "../../src/claude/compactCommand.js";

const text = (value: string) => [{ type: "text" as const, text: value, text_elements: [] }];

describe("Claude prompted compact command", () => {
  it("recognizes only a complete slash command and preserves its prompt", () => {
    expect(claudeCompactCommand(text("/compact"))).toBe("/compact");
    expect(claudeCompactCommand(text("/compact запомни только первое сообщение\n")))
      .toBe("/compact запомни только первое сообщение");
    expect(claudeCompactCommand(text("/compact\nkeep the first message"))).toBe(
      "/compact\nkeep the first message",
    );
    expect(claudeCompactCommand(text("please /compact now"))).toBeNull();
    expect(claudeCompactCommand(text("/compaction"))).toBeNull();
    expect(claudeCompactCommand([
      ...text("/compact prompt"),
      { type: "localImage", path: "/tmp/image.png" },
    ])).toBeNull();
  });
});
