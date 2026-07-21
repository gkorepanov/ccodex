import type { TurnStartParams } from "../codex/generated/v2/TurnStartParams.js";
import type { ProviderKind } from "./store.js";

export interface TitleTurn {
  durableProvider: ProviderKind;
  readonly connectionId: string;
  readonly userPrompt: string;
  readonly outputSchema: TitleOutputSchema;
  output?: string;
}

interface TitleFieldSchema {
  readonly type?: unknown;
  readonly minLength?: unknown;
  readonly maxLength?: unknown;
}

export interface TitleOutputSchema {
  readonly properties: Record<string, TitleFieldSchema>;
  readonly required: readonly string[];
}

export interface TitlePrompt {
  readonly index: number;
  readonly text: string;
  readonly userPrompt: string;
  readonly outputSchema: TitleOutputSchema;
}

const TITLE_PROMPT_PREFIX = "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task";
const TITLE_USER_MARKER = "\n\nUser prompt:\n";
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function titleSchema(value: unknown): TitleOutputSchema | undefined {
  if (!value || typeof value !== "object") return undefined;
  const schema = value as { properties?: unknown; required?: unknown };
  if (!schema.properties || typeof schema.properties !== "object" || !Array.isArray(schema.required)) return undefined;
  const properties = schema.properties as Record<string, TitleFieldSchema>;
  const required = schema.required.filter((field): field is string => typeof field === "string");
  const title = properties.title;
  return title && typeof title === "object" && title.type === "string" && required.includes("title")
    ? { properties, required }
    : undefined;
}

export function titlePrompt(params: TurnStartParams): TitlePrompt | undefined {
  const outputSchema = titleSchema(params.outputSchema);
  if (!outputSchema) return undefined;
  const index = params.input.findIndex((input) => input.type === "text"
    && input.text.startsWith(TITLE_PROMPT_PREFIX) && input.text.includes(TITLE_USER_MARKER));
  const input = params.input[index];
  if (!input || input.type !== "text") return undefined;
  const marker = input.text.indexOf(TITLE_USER_MARKER);
  return {
    index,
    text: input.text,
    userPrompt: input.text.slice(marker + TITLE_USER_MARKER.length),
    outputSchema,
  };
}

export function rewrittenTitlePrompt(prompt: string, renamePrompt: string): string {
  const marker = prompt.indexOf(TITLE_USER_MARKER);
  return `${renamePrompt.trim()}${prompt.slice(marker)}`;
}

function graphemes(value: string): string[] {
  return [...graphemeSegmenter.segment(value)].map((part) => part.segment);
}

function isEmoji(value: string): boolean {
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3/u.test(value);
}

function fallbackEmoji(prompt: string): string {
  const normalized = prompt.toLocaleLowerCase();
  if (/allerg|pollen|аллерг|пыльц/.test(normalized)) return "🤧";
  if (/bug|error|fix|ошиб|баг/.test(normalized)) return "🪲";
  if (/test|тест/.test(normalized)) return "🧪";
  if (/auth|login|security|логин|безопас/.test(normalized)) return "🔐";
  if (/plot|chart|graph|график/.test(normalized)) return "📉";
  if (/image|photo|изображ|фото/.test(normalized)) return "🖼️";
  if (/database|sqlite|sql|база дан/.test(normalized)) return "🗄️";
  return "🪄";
}

function trimTitle(value: string, suffix: string): string {
  const limit = 36 - Array.from(suffix).length;
  const selected: string[] = [];
  let length = 0;
  let truncated = false;
  for (const segment of graphemes(value)) {
    const next = Array.from(segment).length;
    if (length + next > limit) {
      truncated = true;
      break;
    }
    selected.push(segment);
    length += next;
  }
  let title = selected.join("").trim();
  const wordBoundary = title.lastIndexOf(" ");
  if (truncated && wordBoundary > title.indexOf(" ") + 1) title = title.slice(0, wordBoundary);
  return `${title}${suffix}`;
}

function normalizedTitle(value: string, turn: TitleTurn): string {
  const suffix = turn.durableProvider === "claude" ? " ✳️" : "";
  const withoutMarker = value.replace(/\s*✳️\s*/gu, " ").replace(/\s+/gu, " ").trim();
  const parts = graphemes(withoutMarker);
  const supplied = parts[0] && isEmoji(parts[0]) && parts[0] !== "✳️"
    ? parts.shift()!
    : undefined;
  while (parts[0]?.trim() === "") parts.shift();
  while (parts[0] && isEmoji(parts[0])) {
    parts.shift();
    while (parts[0]?.trim() === "") parts.shift();
  }
  const body = parts.join("").trim() || "Untitled task";
  return trimTitle(`${supplied ?? fallbackEmoji(turn.userPrompt)} ${body}`, suffix);
}

function compactText(value: string, maxLength?: number): string {
  const text = value.replace(/\s+/gu, " ").trim();
  return maxLength === undefined ? text : Array.from(text).slice(0, maxLength).join("").trim();
}

function requiredString(field: string, schema: TitleFieldSchema, turn: TitleTurn): string {
  const maxLength = typeof schema.maxLength === "number"
    ? schema.maxLength
    : field === "description" ? 100 : undefined;
  return compactText(field === "description" ? turn.userPrompt : field, maxLength) || field;
}

export function normalizedTitlePayload(text: string, turn: TitleTurn): string {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    // A malformed structured response is repaired below.
  }
  const extracted = typeof payload.title === "string"
    ? payload.title
    : /["']title["']\s*:\s*["']([^"']+)/u.exec(text)?.[1] ?? text;
  const normalized: Record<string, unknown> = {};
  for (const field of Object.keys(turn.outputSchema.properties)) {
    if (payload[field] !== undefined) normalized[field] = payload[field];
  }
  normalized.title = normalizedTitle(extracted, turn);
  for (const field of turn.outputSchema.required) {
    const schema = turn.outputSchema.properties[field];
    if (schema?.type !== "string") continue;
    const value = normalized[field];
    if (typeof value !== "string" || value.trim() === "") normalized[field] = requiredString(field, schema, turn);
  }
  return JSON.stringify(normalized);
}
