import { readFileSync, writeFileSync } from "node:fs";

const RESPONSE_ITEM_SERDE_OVERLAY = {
  aliases: { compaction_summary: "compaction" },
  skippedVariants: {
    additional_tools: {
      type: "object",
      required: ["role", "tools", "type"],
      properties: {
        id: { type: ["string", "null"] },
        role: { type: "string" },
        tools: { type: "array", items: {} },
        type: { type: "string", enum: ["additional_tools"] },
      },
      title: "AdditionalToolsResponseItem",
    },
  },
  otherActionDefinition: "ResponsesApiWebSearchAction",
};

const SERDE_OVERLAYS = {
  "0.144.4": RESPONSE_ITEM_SERDE_OVERLAY,
  "0.144.6": RESPONSE_ITEM_SERDE_OVERLAY,
};

function visit(value, visitor) {
  if (!value || typeof value !== "object") return;
  visitor(value);
  for (const child of Object.values(value)) visit(child, visitor);
}

function referencedDefinitions(schema, root) {
  const names = new Set();
  const collect = (value) => {
    if (typeof value.$ref === "string" && value.$ref.startsWith("#/definitions/")) {
      names.add(value.$ref.slice("#/definitions/".length));
    }
  };
  visit(root, collect);
  for (let previous = -1; previous !== names.size;) {
    previous = names.size;
    for (const name of names) visit(schema.definitions[name], collect);
  }
  return Object.fromEntries([...names].sort().map((name) => [name, schema.definitions[name]]));
}

function taggedVariants(schema) {
  return schema.oneOf.map((variant) => {
    const type = variant.properties?.type?.enum;
    if (!Array.isArray(type) || type.length !== 1 || typeof type[0] !== "string") {
      throw new Error("ResponseItem contains an untagged generated variant");
    }
    return [type[0], variant];
  });
}

function cloneWithTag(schema, type) {
  const clone = structuredClone(schema);
  clone.properties.type.enum = [type];
  clone.properties.type.title = `${type}ResponseItemType`;
  clone.title = `${type}ResponseItem`;
  return clone;
}

function imageFields(variants, definitions) {
  const fields = {};
  const ref = (value) => {
    if (typeof value?.$ref !== "string") return value;
    return definitions[value.$ref.slice("#/definitions/".length)];
  };
  const containsInputImage = (value, seen = new Set()) => {
    value = ref(value);
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (value.properties?.type?.enum?.includes("input_image") && value.properties.image_url) return true;
    return Object.values(value).some((child) => containsInputImage(child, seen));
  };
  for (const [type, variant] of variants) {
    const matching = Object.entries(variant.properties ?? {})
      .filter(([, property]) => containsInputImage(property))
      .map(([field]) => field);
    if (matching.length > 0) fields[type] = matching;
  }
  return fields;
}

export function generateResponseItemSchema(schemaPath, outputPath, protocolVersion) {
  const overlay = SERDE_OVERLAYS[protocolVersion];
  if (!overlay) throw new Error(`No pinned ResponseItem serde overlay for Codex ${protocolVersion}`);

  const source = JSON.parse(readFileSync(schemaPath, "utf8"));
  const generatedRoot = source.definitions?.ResponseItem;
  if (!generatedRoot?.oneOf) throw new Error("Generated ClientRequest schema has no ResponseItem definition");

  const generatedVariants = taggedVariants(generatedRoot);
  const variants = new Map(generatedVariants);
  for (const [alias, target] of Object.entries(overlay.aliases)) {
    if (!variants.has(target)) throw new Error(`ResponseItem alias target '${target}' is missing`);
    variants.set(alias, cloneWithTag(variants.get(target), alias));
  }
  for (const [type, schema] of Object.entries(overlay.skippedVariants)) {
    if (variants.has(type)) throw new Error(`ResponseItem '${type}' is no longer skipped; remove its serde overlay`);
    variants.set(type, schema);
  }

  const definitions = referencedDefinitions(source, { oneOf: [...variants.values()] });
  const action = definitions[overlay.otherActionDefinition];
  if (!action?.oneOf) throw new Error(`Missing ${overlay.otherActionDefinition} definition`);
  const actionTypes = taggedVariants(action).map(([type]) => type);
  const knownTypes = [...variants.keys()];
  const schema = {
    $schema: source.$schema,
    oneOf: [...variants.values()],
    definitions,
  };
  const generated = [
    "// GENERATED CODE! DO NOT MODIFY BY HAND!",
    `// Codex ${protocolVersion} ClientRequest JSON schema plus version-pinned serde overlays.`,
    `export const RESPONSE_ITEM_SCHEMA_JSON: string = ${JSON.stringify(JSON.stringify(schema))};`,
    `export const RESPONSE_ITEM_KNOWN_TYPES = ${JSON.stringify(knownTypes)} as const;`,
    `export const WEB_SEARCH_ACTION_KNOWN_TYPES = ${JSON.stringify(actionTypes)} as const;`,
    `export const RESPONSE_ITEM_IMAGE_FIELDS = ${JSON.stringify(imageFields(variants, definitions))} as const;`,
    "",
  ].join("\n");
  writeFileSync(outputPath, generated);
}
