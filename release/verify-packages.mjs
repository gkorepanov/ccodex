import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const main = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const packages = [
  ["relay-darwin-arm64", "darwin", "arm64", undefined],
  ["relay-linux-arm64-gnu", "linux", "arm64", "glibc"],
  ["relay-linux-x64-gnu", "linux", "x64", "glibc"],
];

if (main.name !== "@gkorepanov/ccodex") throw new Error(`Unexpected main package name: ${main.name}`);
if (!existsSync(join(root, "package-lock.json"))) throw new Error("Development package-lock.json is missing");
if (existsSync(join(root, "npm-shrinkwrap.json"))) throw new Error("npm-shrinkwrap.json must not be published");
if (main.files.includes("npm-shrinkwrap.json") || main.files.includes("package-lock.json")) {
  throw new Error("Lockfiles must not be listed in the published package");
}
if (main.dependencies["@openai/codex"]) throw new Error("Codex must not be a dependency: CCodex runs the installed one");

for (const [directory, os, cpu, libc] of packages) {
  const manifest = JSON.parse(readFileSync(join(root, "packages", directory, "package.json"), "utf8"));
  if (manifest.version !== main.version) throw new Error(`${directory} version ${manifest.version} != ${main.version}`);
  if (manifest.os?.[0] !== os || manifest.cpu?.[0] !== cpu || manifest.libc?.[0] !== libc) {
    throw new Error(`${directory} platform selectors are incorrect`);
  }
  if (main.optionalDependencies[manifest.name] !== main.version) {
    throw new Error(`${manifest.name} is not an exact-version optional dependency`);
  }
}

const targetIndex = process.argv.indexOf("--target");
if (targetIndex >= 0) {
  const directory = process.argv[targetIndex + 1];
  if (!packages.some(([candidate]) => candidate === directory)) throw new Error(`Unknown relay package: ${directory}`);
  const binary = join(root, "packages", directory, "bin", "ccodex-relay");
  if (!existsSync(binary)) throw new Error(`Relay binary is missing: ${binary}`);
  accessSync(binary, constants.X_OK);
}

console.log(`Verified @gkorepanov/ccodex ${main.version}${targetIndex >= 0 ? ` and ${process.argv[targetIndex + 1]}` : " package matrix"}.`);
