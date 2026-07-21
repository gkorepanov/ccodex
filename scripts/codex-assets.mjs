import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

export const root = resolve(import.meta.dirname, "..");
export const upstreamAssetPath = "codex-rs/prompts/templates/goals/continuation.md";
export const vendoredAssetPath = join(root, "vendor", "codex", "continuation.md");

export function pinnedCodexRef(cargo = readFileSync(join(root, "relay", "Cargo.toml"), "utf8")) {
  const refs = [...cargo.matchAll(/^codex-[\w-]+\s*=\s*\{[^}]*\brev\s*=\s*"([0-9a-f]{40})"[^}]*\}$/gmu)]
    .map((match) => match[1]);
  const unique = [...new Set(refs)];
  if (!refs.length || unique.length !== 1) {
    throw new Error("relay/Cargo.toml must contain one shared exact Codex git ref.");
  }
  return unique[0];
}

const git = (repository, args) =>
  execFileSync("git", ["-C", repository, ...args], { encoding: null, stdio: ["ignore", "pipe", "pipe"] });

function localCodexRepository() {
  const candidates = [
    process.env.CCODEX_CODEX_REPO,
    resolve(root, "..", "..", "codex"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(join(candidate, ".git")));
}

export function upstreamAsset(ref = pinnedCodexRef()) {
  const local = localCodexRepository();
  if (local) {
    try {
      return git(local, ["show", `${ref}:${upstreamAssetPath}`]);
    } catch {
      if (process.env.CCODEX_CODEX_REPO) {
        throw new Error(`Codex ref ${ref} or ${upstreamAssetPath} is missing in CCODEX_CODEX_REPO=${local}.`);
      }
    }
  }

  const temporary = mkdtempSync(join(tmpdir(), "ccodex-codex-assets-"));
  try {
    execFileSync("git", ["init", "--bare", temporary], { stdio: "ignore" });
    execFileSync("git", ["-C", temporary, "fetch", "--quiet", "--depth=1", "https://github.com/openai/codex.git", ref]);
    return git(temporary, ["show", `${ref}:${upstreamAssetPath}`]);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const digest = (value) => createHash("sha256").update(value).digest("hex");

export function syncCodexAsset(check = false) {
  const ref = pinnedCodexRef();
  const upstream = upstreamAsset(ref);
  if (check) {
    const vendored = readFileSync(vendoredAssetPath);
    if (!vendored.equals(upstream)) {
      throw new Error(
        `vendor/codex/continuation.md is out of sync with ${ref}:${upstreamAssetPath}`
        + ` (vendor ${digest(vendored)}, upstream ${digest(upstream)}). Run npm run sync:codex-assets.`,
      );
    }
    console.log(`Codex assets match ${ref}.`);
    return;
  }
  mkdirSync(dirname(vendoredAssetPath), { recursive: true });
  writeFileSync(vendoredAssetPath, upstream);
  console.log(`Synced vendor/codex/continuation.md from ${ref}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  syncCodexAsset(process.argv.includes("--check"));
}
