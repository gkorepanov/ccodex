import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

describe("release tarball publishing", () => {
  it("passes an absolute archive path to npm publish", () => {
    const sandbox = mkdtempSync(resolve(tmpdir(), "ccodex-publish-"));
    sandboxes.push(sandbox);
    const packageDir = resolve(sandbox, "package");
    const binDir = resolve(sandbox, "bin");
    const archive = resolve(sandbox, "artifacts/ccodex-test-1.0.0.tgz");
    const log = resolve(sandbox, "publish.json");
    mkdirSync(packageDir);
    mkdirSync(binDir);
    mkdirSync(resolve(archive, ".."));
    writeFileSync(resolve(packageDir, "package.json"), JSON.stringify({ name: "@gkorepanov/ccodex-test", version: "1.0.0" }));
    execFileSync("tar", ["-czf", archive, "package"], { cwd: sandbox });

    const fakeNpm = resolve(binDir, "npm");
    writeFileSync(fakeNpm, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "view") {
  console.error("E404");
  process.exit(1);
}
writeFileSync(process.env.PUBLISH_LOG, JSON.stringify(args));
`);
    chmodSync(fakeNpm, 0o755);

    execFileSync(process.execPath, [resolve(root, "release/publish-tarballs.mjs"), "latest", "artifacts/ccodex-test-1.0.0.tgz"], {
      cwd: sandbox,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        PUBLISH_LOG: log,
      },
    });

    expect(JSON.parse(readFileSync(log, "utf8"))).toEqual([
      "publish",
      realpathSync(archive),
      "--access",
      "public",
      "--tag",
      "latest",
    ]);
  });
});
