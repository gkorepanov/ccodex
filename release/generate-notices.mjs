import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
const npmRows = Object.entries(lock.packages).filter(([path]) =>
  path.startsWith("node_modules/") && !path.startsWith("node_modules/@gkorepanov/ccodex")).map(([path, entry]) => {
  const name = path.slice("node_modules/".length);
  let license = entry.license;
  if (!license && existsSync(join(root, path, "package.json"))) {
    license = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8")).license;
  }
  return `| npm:${name} | ${entry.version ?? "unknown"} | ${license ?? "REVIEW REQUIRED"} |`;
});
const cargo = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--format-version", "1", "--manifest-path", "relay/Cargo.toml"], {
  cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
}));
const cargoRows = cargo.packages.filter((entry) => entry.name !== "codex-hybrid-remote-relay").map((entry) =>
  `| cargo:${entry.name} | ${entry.version} | ${entry.license ?? "REVIEW REQUIRED"} |`);
const rows = [...new Set([...npmRows, ...cargoRows])].sort();
const output = `# Third-party notices\n\nGenerated from package-lock.json and locked Cargo metadata. Review entries and upstream license texts before release.\n\n| Package | Version | License |\n|---|---:|---|\n${rows.join("\n")}\n`;
writeFileSync(join(root, "legal/THIRD_PARTY_NOTICES.md"), output);
console.log(`Recorded ${rows.length} npm and Cargo dependency license declarations.`);
