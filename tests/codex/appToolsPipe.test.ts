import { mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appToolsLinkTarget, retargetAppToolsLink } from "../../src/codex/appToolsPipe.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "ccodex-app-tools-"));
  roots.push(directory);
  return directory;
}

describe("app-tools pipe symlink", () => {
  it("creates the link, replaces it atomically, and skips identical targets", () => {
    const directory = root();
    const link = join(directory, "app-tools.sock");
    const first = join(directory, "first.sock");
    const second = join(directory, "second.sock");

    expect(retargetAppToolsLink(link, first)).toBe(true);
    expect(readlinkSync(link)).toBe(first);
    expect(retargetAppToolsLink(link, first)).toBe(false);
    expect(retargetAppToolsLink(link, second)).toBe(true);
    expect(readlinkSync(link)).toBe(second);
    expect(retargetAppToolsLink(link, "")).toBe(false);
    expect(readlinkSync(link)).toBe(second);
  });

  it("reports the live target only while the socket exists", () => {
    const directory = root();
    const link = join(directory, "app-tools.sock");
    const target = join(directory, "app.sock");
    retargetAppToolsLink(link, target);
    expect(appToolsLinkTarget(link)).toBeUndefined();
    writeFileSync(target, "");
    expect(appToolsLinkTarget(link)).toBe(target);
    expect(appToolsLinkTarget(join(directory, "missing"))).toBeUndefined();
  });
});
