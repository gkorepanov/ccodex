import { execFileSync } from "node:child_process";

const version = process.argv[2];
const execute = process.argv.includes("--execute");
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error("Usage: npm run release:promote -- <semver> [--execute]");
}
const packages = [
  "@gkorepanov/ccodex-relay-darwin-arm64",
  "@gkorepanov/ccodex-relay-linux-arm64-gnu",
  "@gkorepanov/ccodex-relay-linux-x64-gnu",
  "@gkorepanov/ccodex",
];
for (const name of packages) {
  const spec = `${name}@${version}`;
  if (execute) execFileSync("npm", ["dist-tag", "add", spec, "latest"], { stdio: "inherit" });
  else console.log(`npm dist-tag add ${spec} latest`);
}
if (!execute) console.log("Dry run only. Repeat with --execute after the next-channel acceptance test.");
