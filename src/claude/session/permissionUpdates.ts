import type { CanUseTool, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

type PermissionOptions = Parameters<CanUseTool>[2];

export function safeSessionPermissionUpdates(
  options: Pick<PermissionOptions, "matchedAskRule" | "suggestions">,
): PermissionUpdate[] | undefined {
  const suggestions = options.suggestions;
  if (!suggestions?.length || options.matchedAskRule) return undefined;
  if (!suggestions.every((update) => {
    if (update.destination !== "session") return false;
    if (update.type === "addDirectories") return update.directories.length > 0;
    return update.type === "addRules"
      && update.behavior === "allow"
      && update.rules.length > 0;
  })) return undefined;
  return suggestions;
}
