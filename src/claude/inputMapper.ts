import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { invalidParams, type UserInput } from "../protocol/codex.js";
import { decodeClaudeSkillChips } from "./sdk.js";

const mediaTypes: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const dataImageUrl = /^data:(image\/[a-z+.-]+);base64,([\s\S]*)$/i;

/** Codex user input → Claude message content (string when it is text only, so slash commands work). */
export async function claudeContent(input: readonly UserInput[], cwd: string): Promise<string | Record<string, unknown>[]> {
  const content: Record<string, unknown>[] = [];
  for (const item of input) {
    if (item.type === "text") content.push({ type: "text", text: decodeClaudeSkillChips(item.text) });
    else if (item.type === "mention") content.push({ type: "text", text: `@${item.name} (${item.path})` });
    else if (item.type === "skill") content.push({ type: "text", text: `/${item.name.replace(/^claude:/u, "")}` });
    else if (item.type === "image") {
      const inline = dataImageUrl.exec(item.url);
      content.push(inline
        ? { type: "image", source: { type: "base64", media_type: inline[1]!.toLowerCase(), data: inline[2]!.replace(/\s+/g, "") } }
        : { type: "image", source: { type: "url", url: item.url } });
    } else if (item.type === "localImage") {
      const path = isAbsolute(item.path) ? item.path : resolve(cwd, item.path);
      const mediaType = mediaTypes[extname(path).toLowerCase()];
      if (!mediaType) throw invalidParams(`Unsupported image type for '${item.path}'.`);
      content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: (await readFile(path)).toString("base64") } });
    } else {
      throw invalidParams("Audio input is not supported in Claude threads.");
    }
  }
  return content.every((block) => block.type === "text") ? content.map((block) => block.text).join("\n") : content;
}

export function userMessage(content: string | Record<string, unknown>[], uuid: string, extra: Partial<SDKUserMessage> = {}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    uuid,
    origin: { kind: "human" },
    message: { role: "user", content },
    ...extra,
  } as SDKUserMessage;
}

/**
 * Stock re-serializes user input through its protocol types, so `text_elements` is always present
 * on stored items; the iOS client omits it and the Desktop app crashes on items without it.
 */
export function normalizeUserInput(input: readonly UserInput[]): UserInput[] {
  return input.map((item) => item.type === "text"
    ? { type: "text", text: item.text, text_elements: item.text_elements ?? [] }
    : item);
}

export function inputText(input: readonly UserInput[]): string {
  return input.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
}
