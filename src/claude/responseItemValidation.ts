import { z } from "zod";
import type { JsonValue } from "../codex/generated/serde_json/JsonValue.js";
import {
  RESPONSE_ITEM_IMAGE_FIELDS,
  RESPONSE_ITEM_KNOWN_TYPES,
  RESPONSE_ITEM_SCHEMA_JSON,
  WEB_SEARCH_ACTION_KNOWN_TYPES,
} from "../codex/generated/ResponseItemRuntimeSchema.js";
import { invalidRequest } from "../protocol/errors.js";

const responseItem = z.fromJSONSchema(JSON.parse(RESPONSE_ITEM_SCHEMA_JSON));
const knownTypes = new Set<string>(RESPONSE_ITEM_KNOWN_TYPES);
const knownWebSearchActions = new Set<string>(WEB_SEARCH_ACTION_KNOWN_TYPES);
const imageFields: Record<string, readonly string[]> = RESPONSE_ITEM_IMAGE_FIELDS;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalized(item: unknown): unknown {
  if (!record(item) || typeof item.type !== "string" || item.type !== "web_search_call"
    || !record(item.action) || typeof item.action.type !== "string"
    || knownWebSearchActions.has(item.action.type)) return item;
  return { ...item, action: { ...item.action, type: "other" } };
}

function hasRemoteImage(item: Record<string, unknown>): boolean {
  return (imageFields[item.type as string] ?? []).some((field) => {
    const content = item[field];
    return Array.isArray(content) && content.some((entry) =>
      record(entry) && entry.type === "input_image"
      && typeof entry.image_url === "string" && /^https?:/iu.test(entry.image_url));
  });
}

export function validateResponseItems(items: JsonValue[]): void {
  if (items.length === 0) throw invalidRequest("items must not be empty");
  for (const [index, item] of items.entries()) {
    if (record(item) && typeof item.type === "string" && !knownTypes.has(item.type)) continue;
    const parsed = responseItem.safeParse(normalized(item));
    if (!parsed.success) {
      throw invalidRequest(`items[${index}] is not a valid response item: ${z.prettifyError(parsed.error)}`);
    }
    if (record(item) && hasRemoteImage(item)) {
      throw invalidRequest("remote image URLs are not supported; use an inline data URL instead");
    }
  }
}
