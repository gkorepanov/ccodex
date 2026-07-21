import { existsSync, readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const notices = readFileSync(new URL("../legal/LICENSES.md", import.meta.url), "utf8");
if (manifest.license === "UNLICENSED") throw new Error("Select and record a project source license before publishing.");
const root = new URL("..", import.meta.url);
if (!existsSync(new URL("LICENSE", root)) && !existsSync(new URL("LICENSE.md", root))) {
  throw new Error("Add the selected project source license as LICENSE or LICENSE.md before publishing.");
}
for (const directory of [
  "relay-darwin-arm64", "relay-linux-arm64-gnu", "relay-linux-x64-gnu",
]) {
  const packageRoot = new URL(`packages/${directory}/`, root);
  const relay = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));
  if (relay.license !== manifest.license) throw new Error(`${relay.name} must declare the same project license as the main package.`);
  if (!existsSync(new URL("LICENSE", packageRoot)) && !existsSync(new URL("LICENSE.md", packageRoot))) {
    throw new Error(`${relay.name} must include its own LICENSE file in the npm tarball.`);
  }
}
if (/do not publish/i.test(notices)) throw new Error("LICENSES.md still blocks public distribution.");
if (/REVIEW REQUIRED/.test(readFileSync(new URL("../legal/THIRD_PARTY_NOTICES.md", import.meta.url), "utf8"))) {
  throw new Error("THIRD_PARTY_NOTICES.md still contains unreviewed license declarations.");
}
console.log(`Legal release gate accepts declared license: ${manifest.license}`);
