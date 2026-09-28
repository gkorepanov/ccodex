import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelCoverageCheck, visibleModelSlugs } from "../../src/management/doctor.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fakeCodex(models: Array<{ slug: string; visibility: string }>): string {
  const root = mkdtempSync(join(tmpdir(), "ccodex-coverage-"));
  roots.push(root);
  const path = join(root, "codex");
  writeFileSync(path, `#!/bin/sh\n[ "$1 $2" = "debug models" ] || exit 2\ncat <<'JSON'\n${JSON.stringify({ models })}\nJSON\n`, { mode: 0o755 });
  return path;
}

describe("model coverage", () => {
  it("reads only listed slugs from codex debug models", async () => {
    const codex = fakeCodex([{ slug: "gpt-6-sol", visibility: "list" }, { slug: "gpt-hidden", visibility: "hidden" }]);
    expect(await visibleModelSlugs(codex)).toEqual(["gpt-6-sol"]);
  });

  it("passes when the app-server Codex knows every host model", () => {
    expect(modelCoverageCheck(["gpt-6-sol", "gpt-5.5"], [{ path: "/host/codex", slugs: ["gpt-6-sol"] }]))
      .toMatchObject({ id: "model-coverage", status: "ok" });
  });

  it("warns with the newest host and a config repair when models are missing", () => {
    const check = modelCoverageCheck(
      ["gpt-5.6-sol", "gpt-5.5"],
      [{ path: "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", slugs: ["gpt-6-sol", "gpt-6-luna", "gpt-5.5"] }],
    );
    expect(check.status).toBe("warning");
    expect(check.detected).toContain("gpt-6-sol, gpt-6-luna");
    expect(check.repair).toContain('app_server_codex = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"');
  });

  it("is ok when there is no other Codex to compare against", () => {
    expect(modelCoverageCheck(["gpt-5.5"], [])).toMatchObject({ status: "ok" });
  });
});
