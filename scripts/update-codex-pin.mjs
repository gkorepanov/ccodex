import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinnedCodexRef, root, upstreamAsset } from "./codex-assets.mjs";

const next = process.argv[2];
if (!next || !/^[0-9a-f]{40}$/u.test(next)) {
  throw new Error("Usage: npm run update:codex-pin -- <40-character git ref>");
}

const path = join(root, "relay", "Cargo.toml");
const original = readFileSync(path, "utf8");
const current = pinnedCodexRef(original);
upstreamAsset(next);
const updated = original.replaceAll(`rev = "${current}"`, `rev = "${next}"`);
if (updated === original) throw new Error(`Codex ref ${current} was not replaced.`);

writeFileSync(path, updated);
try {
  execFileSync(process.execPath, [join(root, "scripts", "codex-assets.mjs")], { cwd: root, stdio: "inherit" });
} catch (error) {
  writeFileSync(path, original);
  throw error;
}
console.log(`Updated pinned Codex git ref ${current} -> ${next}; run cargo update before committing.`);
