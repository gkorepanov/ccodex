import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

const [tag, ...tarballs] = process.argv.slice(2);
if (!tag || tarballs.length === 0) throw new Error("Usage: publish-tarballs.mjs <dist-tag> <tarball...>");

for (const tarball of tarballs) {
  const archive = resolve(tarball);
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }));
  const spec = `${manifest.name}@${manifest.version}`;
  const view = spawnSync("npm", ["view", spec, "version", "--json"], { encoding: "utf8" });
  if (view.status === 0) {
    console.log(`${spec} already published; skipping`);
    continue;
  }
  if (!`${view.stdout}\n${view.stderr}`.includes("E404")) throw new Error(`Could not check ${spec}: ${view.stderr}`);
  execFileSync("npm", ["publish", archive, "--access", "public", "--tag", tag], { stdio: "inherit" });
}
