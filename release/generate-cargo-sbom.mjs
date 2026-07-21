import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(process.argv[2] ?? "release-artifacts/cargo-sbom.cdx.json");
const productVersion = JSON.parse(readFileSync(resolve(root, "compatibility.json"), "utf8")).productVersion;
const metadata = JSON.parse(execFileSync("cargo", [
  "metadata", "--locked", "--format-version", "1", "--manifest-path", "relay/Cargo.toml",
], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
const components = metadata.packages.map((entry) => ({
  type: "library",
  name: entry.name,
  version: entry.version,
  ...(entry.license ? { licenses: [{ expression: entry.license }] } : {}),
  ...(entry.source?.startsWith("registry+") ? { purl: `pkg:cargo/${entry.name}@${entry.version}` } : {}),
  ...(entry.source ? { properties: [{ name: "cargo:source", value: entry.source }] } : {}),
})).sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: { component: { type: "application", name: "@gkorepanov/ccodex-relay", version: productVersion } },
  components,
};
writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`Generated Cargo SBOM with ${components.length} components.`);
