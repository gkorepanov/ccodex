import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Logger } from "../../src/observability/logger.js";

const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Logger", () => {
  it("redacts content and secrets and rotates bounded debug capture", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const directory = mkdtempSync(join(tmpdir(), "codex-hybrid-logger-"));
    directories.push(directory);
    const path = join(directory, "debug.jsonl");
    const logger = new Logger("debug", { capturePath: path, maxBytes: 300 });
    for (let index = 0; index < 3; index += 1) {
      logger.debug("fixture", { output: "private tool output", apiKey: "sk-ant-secret", marker: `${index}-${"x".repeat(400)}` });
    }
    const capture = `${readFileSync(`${path}.1`, "utf8")}\n${readFileSync(path, "utf8")}`;
    expect(capture).toContain("<CONTENT_REDACTED>");
    expect(capture).toContain("<REDACTED>");
    expect(capture).not.toContain("private tool output");
    expect(capture).not.toContain("sk-ant-secret");
  });
});
