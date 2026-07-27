import { readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { UserInput } from "../codex/generated/v2/UserInput.js";
import { invalidParams } from "../protocol/errors.js";
import { decodeClaudeSkillChips } from "./skillCodec.js";

const mediaTypes: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

interface InputContext {
  readonly cwd: string;
  readonly sandboxPolicy: unknown;
  readonly origin?: "human";
}

async function allowedImagePath(path: string, context: InputContext): Promise<string> {
  const candidate = await realpath(isAbsolute(path) ? path : resolve(context.cwd, path));
  const sandbox = context.sandboxPolicy && typeof context.sandboxPolicy === "object" && "type" in context.sandboxPolicy
    ? context.sandboxPolicy as { type: unknown; writableRoots?: unknown }
    : undefined;
  if (sandbox?.type === "dangerFullAccess") return candidate;
  const roots = [context.cwd, ...(Array.isArray(sandbox?.writableRoots) ? sandbox.writableRoots.filter((root): root is string => typeof root === "string") : [])];
  for (const root of roots) {
    const canonicalRoot = await realpath(root).catch(() => undefined);
    if (!canonicalRoot) continue;
    const child = relative(canonicalRoot, candidate);
    if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return candidate;
  }
  throw invalidParams(`Claude local image '${path}' is outside the thread's readable workspace.`);
}

export async function mapUserInput(input: readonly UserInput[], uuid?: string, context?: InputContext): Promise<SDKUserMessage> {
  const content: Array<Record<string, unknown>> = [];
  let decodedSkill = false;
  for (const item of input) {
    if (item.type === "text") {
      const decoded = decodeClaudeSkillChips(item.text);
      decodedSkill ||= decoded.decoded;
      content.push({ type: "text", text: decoded.text });
    }
    else if (item.type === "mention") {
      content.push({ type: "text", text: `@${item.name} (${item.path})` });
    } else if (item.type === "skill") {
      throw invalidParams("Codex skills are not available in Claude threads.");
    } else if (item.type === "image") {
      const url = new URL(item.url);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw invalidParams(`Unsupported Claude image URL scheme '${url.protocol}'.`);
      content.push({ type: "image", source: { type: "url", url: item.url } });
    } else if (item.type === "localImage") {
      if (!context) throw invalidParams("Local Claude images require a thread path policy.");
      const path = await allowedImagePath(item.path, context);
      const mediaType = mediaTypes[extname(path).toLocaleLowerCase()];
      if (!mediaType) throw invalidParams(`Unsupported Claude image type for '${item.path}'.`);
      const bytes = await readFile(path);
      content.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") },
      });
    } else {
      throw invalidParams("Audio input is not supported by the pinned Claude runtime.");
    }
  }
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    ...(uuid ? { uuid } : {}),
    ...(context?.origin === "human" ? { origin: { kind: "human" } } : {}),
    message: {
      role: "user",
      content: decodedSkill && content.every((block) => block.type === "text")
        ? content.map((block) => block.text).join("")
        : content,
    },
  } as unknown as SDKUserMessage;
}
