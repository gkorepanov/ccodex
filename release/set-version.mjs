import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error("Usage: npm run release:version -- <semver>");
}
const root = resolve(import.meta.dirname, "..");
const platformDirectories = [
  "relay-darwin-arm64", "relay-linux-arm64-gnu", "relay-linux-x64-gnu",
];
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const mainPath = join(root, "package.json");
const main = JSON.parse(readFileSync(mainPath, "utf8"));
main.version = version;
for (const name of Object.keys(main.optionalDependencies)) main.optionalDependencies[name] = version;
writeJson(mainPath, main);
for (const directory of platformDirectories) {
  const path = join(root, "packages", directory, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.version = version;
  writeJson(path, manifest);
}
const compatibilityPath = join(root, "compatibility.json");
const compatibility = JSON.parse(readFileSync(compatibilityPath, "utf8"));
compatibility.productVersion = version;
writeJson(compatibilityPath, compatibility);
execFileSync("npm", ["install", "--package-lock-only", "--ignore-scripts"], { cwd: root, stdio: "inherit" });
console.log(`CCodex release files now target ${version}.`);
