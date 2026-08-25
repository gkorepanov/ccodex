import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv } from "ajv";

// The pinned 0.149.1 experimental protocol bundle. CCodex synthesizes Claude
// responses by hand, so contract tests validate them against the same schemas
// the stock app-server is generated from.
const bundle = JSON.parse(readFileSync(
  join(process.cwd(), "schemas", "generated", "codex_app_server_protocol.v2.schemas.json"),
  "utf8",
)) as object;

const ajv = new Ajv({ strict: false, validateFormats: false });
ajv.addSchema(bundle, "v2");

/** Validates the wire form (JSON round-trip) of a synthesized response against a pinned protocol definition. */
export function assertValidResponse(definition: string, value: unknown): void {
  const validate = ajv.compile({ $ref: `v2#/definitions/${definition}` });
  const wire = JSON.parse(JSON.stringify(value)) as unknown;
  if (!validate(wire)) {
    throw new Error(
      `Synthesized response does not match pinned ${definition}: ${ajv.errorsText(validate.errors)}\n`
      + JSON.stringify(wire, null, 2).slice(0, 4_000),
    );
  }
}
