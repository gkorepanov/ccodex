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
// 0.4's setup reads it before handing setup over to this version.
const compatibilityPath = join(root, "config", "compatibility.json");
writeJson(compatibilityPath, { ...JSON.parse(readFileSync(compatibilityPath, "utf8")), productVersion: version });
// npm 11 drops nested optional esbuild entries from the lock, and `npm ci` then fails in CI: npm 10 writes it.
execFileSync("npx", ["-y", "npm@10.9.4", "install", "--package-lock-only", "--ignore-scripts"], { cwd: root, stdio: "inherit" });
// The platform packages of a version not published yet resolve to nothing; `npm ci` (npm 11) needs them in the lock,
// as optional entries without a tarball.
const lockPath = join(root, "package-lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
for (const name of Object.keys(main.optionalDependencies)) lock.packages[`node_modules/${name}`] ??= { optional: true };
lock.packages = Object.fromEntries(Object.entries(lock.packages).sort(([left], [right]) => left.localeCompare(right, "en")));
writeJson(lockPath, lock);
console.log(`CCodex release files now target ${version}.`);
