import { describe, expect, it } from "vitest";
import {
  CCODEX_APP_UI_INSTRUCTIONS,
  claudeDeveloperInstructions,
} from "../../src/claude/developerInstructions.js";

describe("Claude developer instructions", () => {
  it("removes App context while preserving side-conversation instructions", () => {
    expect(claudeDeveloperInstructions(`<app-context>
Unavailable Codex App tools.
</app-context>

You are in a side conversation, not the main thread.`)).toBe(
      "You are in a side conversation, not the main thread.",
    );
  });

  it("removes every App-context block and preserves other instructions", () => {
    expect(claudeDeveloperInstructions(`before
<app-context>first</app-context>
middle
<app-context>second</app-context>
after`)).toBe("before\n\nmiddle\n\nafter");
  });

  it("preserves CCodex and user instructions unchanged", () => {
    const handoff = "Create a portable conversation handoff. Do not call tools.";
    expect(claudeDeveloperInstructions(handoff)).toBe(handoff);
    expect(claudeDeveloperInstructions(null)).toBeNull();
  });

  it("keeps the owned UI contract compact and provider-accurate", () => {
    expect(CCODEX_APP_UI_INSTRUCTIONS).toContain("absolute filesystem paths");
    expect(CCODEX_APP_UI_INSTRUCTIONS).toContain("::code-comment");
    expect(CCODEX_APP_UI_INSTRUCTIONS).toContain("do not assume Codex App-native tools");
    expect(CCODEX_APP_UI_INSTRUCTIONS.length).toBeLessThan(500);
  });
});
