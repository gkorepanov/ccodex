import { execFileSync } from "node:child_process";

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
const allowedMarkdown = new Set([
  "README.md",
  "legal/LICENSES.md",
  "legal/THIRD_PARTY_NOTICES.md",
  "vendor/codex/continuation.md",
  "assets/ccodex/goals/continuation.md",
]);
const forbiddenCapture = /(^|\/)(captures?|fixtures\/protocol)(\/|$)|\.(?:capture|gateway|lab)\.json$|\.jsonl(?:\.gz)?$/u;
const violations = files.filter((path) =>
  (path.endsWith(".md") && !allowedMarkdown.has(path)) || forbiddenCapture.test(path));

if (violations.length > 0) {
  throw new Error(`Private docs or captures are tracked:\n${violations.join("\n")}`);
}
