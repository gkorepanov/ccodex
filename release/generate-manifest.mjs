import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const directory = resolve(process.argv[2] ?? "release-artifacts");
const compatibility = JSON.parse(readFileSync(new URL("../compatibility.json", import.meta.url), "utf8"));
const artifacts = readdirSync(directory).filter((name) => name.endsWith(".tgz")).sort().map((name) => {
  const bytes = readFileSync(join(directory, name));
  return { name: basename(name), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
});
if (artifacts.length !== 4) throw new Error(`Expected 4 npm artifacts, found ${artifacts.length}`);
const manifest = { schemaVersion: 1, package: "@gkorepanov/ccodex", version: compatibility.productVersion, compatibility, artifacts };
writeFileSync(join(directory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(directory, "SHA256SUMS"), `${artifacts.map((item) => `${item.sha256}  ${item.name}`).join("\n")}\n`);
console.log(`Generated release manifest for ${artifacts.length} npm artifacts.`);
