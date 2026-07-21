import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compareSemver, packageIsNewer } from "../../src/management/shimSelect.js";
import { CCODEX_SHIM, repairManagedCcodexShim } from "../../src/management/shims.js";

const roots: string[] = [];
const sha256 = (content: string) => createHash("sha256").update(content).digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; home: string; shim: string; manifest: string } {
  const root = mkdtempSync(join(tmpdir(), "ccodex-shim-"));
  roots.push(root);
  const home = join(root, ".ccodex");
  const shim = join(home, "bin", "ccodex");
  const manifest = join(home, "install.json");
  mkdirSync(join(home, "bin"), { recursive: true });
  return { root, home, shim, manifest };
}

describe("managed CCodex launcher", () => {
  it("compares release and prerelease versions", () => {
    expect(compareSemver("0.4.1", "0.3.6")).toBe(1);
    expect(compareSemver("0.4.1", "0.4.1")).toBe(0);
    expect(compareSemver("0.4.1-beta.2", "0.4.1-beta.1")).toBe(1);
    expect(compareSemver("0.4.1-beta.1", "0.4.1")).toBe(-1);
  });

  it("selects a global package only when it is newer than current", () => {
    const { root } = fixture();
    const candidate = join(root, "candidate.json");
    const current = join(root, "current.json");
    writeFileSync(candidate, JSON.stringify({ version: "0.4.1" }));
    writeFileSync(current, JSON.stringify({ version: "0.3.6" }));
    expect(packageIsNewer(candidate, current)).toBe(true);
    writeFileSync(current, JSON.stringify({ version: "0.4.2" }));
    expect(packageIsNewer(candidate, current)).toBe(false);
  });

  it("repairs an owned legacy launcher but preserves user modifications", () => {
    const owned = fixture();
    const legacy = "#!/bin/sh\necho legacy\n";
    writeFileSync(owned.shim, legacy);
    writeFileSync(owned.manifest, JSON.stringify({ shimHashes: { ccodex: sha256(legacy) } }));
    expect(repairManagedCcodexShim(owned.home)).toBe("updated");
    expect(readFileSync(owned.shim, "utf8")).toBe(CCODEX_SHIM);
    expect(JSON.parse(readFileSync(owned.manifest, "utf8"))).toMatchObject({
      shimHashes: { ccodex: sha256(CCODEX_SHIM) },
    });

    writeFileSync(owned.shim, "#!/bin/sh\necho user-owned\n");
    expect(repairManagedCcodexShim(owned.home)).toBe("modified");
    expect(readFileSync(owned.shim, "utf8")).toContain("user-owned");
  });

  it("routes plain ccodex setup from an old managed PATH entry to the newer global package", () => {
    const { root, home, shim, manifest } = fixture();
    const legacy = "#!/bin/sh\nexec \"$CCODEX_HOME/current/node_modules/.bin/ccodex\" \"$@\"\n";
    writeFileSync(shim, legacy, { mode: 0o755 });
    writeFileSync(manifest, JSON.stringify({ shimHashes: { ccodex: sha256(legacy) } }));

    const currentBin = join(home, "current", "node_modules", ".bin");
    mkdirSync(currentBin, { recursive: true });
    writeFileSync(join(currentBin, "ccodex"), "#!/bin/sh\nprintf 'old-current:%s\\n' \"$*\"\n", { mode: 0o755 });

    const globalRoot = join(root, "global", "node_modules");
    const globalPackage = join(globalRoot, "@gkorepanov", "ccodex");
    mkdirSync(join(globalPackage, "dist", "cli"), { recursive: true });
    mkdirSync(join(globalPackage, "dist", "management"), { recursive: true });
    writeFileSync(join(globalPackage, "dist", "cli", "main.js"), "console.log(`new-global:${process.argv.slice(2).join(' ')}`);\n");
    writeFileSync(join(globalPackage, "dist", "management", "shimSelect.js"), "process.exit(0);\n");

    const tools = join(root, "tools");
    mkdirSync(tools);
    writeFileSync(join(tools, "npm"), `#!/bin/sh\nprintf '%s\\n' '${globalRoot}'\n`, { mode: 0o755 });

    expect(repairManagedCcodexShim(home)).toBe("updated");
    chmodSync(shim, 0o755);
    const output = execFileSync("sh", ["-c", "ccodex setup"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: root,
        CCODEX_HOME: home,
        PATH: [join(home, "bin"), tools, process.env.PATH].join(delimiter),
      },
    });
    expect(output.trim()).toBe("new-global:setup");
  });
});
