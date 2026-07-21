import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sdkMessageAliases } from "../fixtures/protocolSamples.js";

describe("pinned Claude SDK message inventory", () => {
  it("enumerates every SDKMessage union member and keeps an exhaustive runtime fallback", () => {
    const declaration = readFileSync(
      join(process.cwd(), "node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts"),
      "utf8",
    );
    const union = /export declare type SDKMessage = ([^;]+);/.exec(declaration)?.[1]
      ?.split("|")
      .map((name) => name.trim());
    expect(union).toEqual(sdkMessageAliases);

    const session = readFileSync(join(process.cwd(), "src/claude/session/session.ts"), "utf8");
    expect(session.match(/const exhaustive: never = message;/g)).toHaveLength(2);
    expect(session).toContain('return "unsupportedVisible";');
  });
});
