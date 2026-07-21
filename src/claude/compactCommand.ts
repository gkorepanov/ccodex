import type { UserInput } from "../codex/generated/v2/UserInput.js";

export function claudeCompactCommand(input: readonly UserInput[]): string | null {
  if (input.length !== 1 || input[0]?.type !== "text") return null;
  const command = input[0].text.trim();
  return /^\/compact(?:\s+[\s\S]+)?$/u.test(command) ? command : null;
}
