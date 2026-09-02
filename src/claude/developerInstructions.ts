import { withoutAppContext } from "../protocol/appContext.js";

export const CCODEX_APP_UI_INSTRUCTIONS = `You are displayed through Codex App via CCodex.
For local files or media shown to the user, use Markdown links or images with absolute filesystem paths. Return web URLs as Markdown links.
For actionable inline review feedback, use \`::code-comment{title="..." body="..." file="/absolute/path" start=1 end=1 priority=0}\` only when appropriate.
Use only tools actually exposed by Claude Code; do not assume Codex App-native tools are available.`;

export function claudeDeveloperInstructions(value: string | null | undefined): string | null {
  return withoutAppContext(value);
}
