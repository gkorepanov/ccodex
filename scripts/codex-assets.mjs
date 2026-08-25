import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

export const root = resolve(import.meta.dirname, "..");
export const upstreamAssetPath = "codex-rs/prompts/templates/goals/continuation.md";
export const vendoredAssetPath = join(root, "vendor", "codex", "continuation.md");

const upstreamTransportRoot = "codex-rs/app-server-transport";
export const vendoredTransportDir = join(root, "relay", "vendor", "app-server-transport");

// The remote-control transport crate is vendored (instead of consumed straight
// from the pinned git rev) solely to keep the relay's response path raw:
// upstream types OutgoingResponse.result as Box<ClientResponsePayload>, an
// enum with no arbitrary-JSON variant, so it cannot carry the gateway's
// already-serialized JSON-RPC results. The overlay relaxes that one field back
// to serde_json::Value — the wire bytes are identical either way, the upstream
// typing is compile-time only. Overlays are pinned per Codex ref so an upgrade
// forces a review of upstream transport changes before re-vendoring.
const TRANSPORT_OVERLAYS = {
  // rust-v0.149.1
  "980a6d12110b110d29ec13bdcbe14011100b3566": [
    // Test modules are #[cfg(test)]-gated upstream and are not vendored, so
    // the dev-dependencies (and their workspace entries) are not needed.
    { file: "Cargo.toml", find: /\n\[dev-dependencies\]\n[\s\S]*$/u, replace: "\n" },
    { file: "src/outgoing_message.rs", find: "use codex_app_server_protocol::ClientResponsePayload;\n", replace: "" },
    { file: "src/outgoing_message.rs", find: "    pub result: Box<ClientResponsePayload>,", replace: "    pub result: serde_json::Value," },
  ],
};

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

/** Opens a repository that can resolve `ref`: the local checkout when it has it, otherwise a shallow network fetch. */
function openUpstream(ref) {
  const local = localCodexRepository();
  if (local) {
    try {
      git(local, ["cat-file", "-e", `${ref}^{commit}`]);
      return { dir: local, cleanup: () => {} };
    } catch {
      if (process.env.CCODEX_CODEX_REPO) {
        throw new Error(`Codex ref ${ref} is missing in CCODEX_CODEX_REPO=${local}.`);
      }
    }
  }
  const temporary = mkdtempSync(join(tmpdir(), "ccodex-codex-assets-"));
  try {
    execFileSync("git", ["init", "--bare", temporary], { stdio: "ignore" });
    execFileSync("git", ["-C", temporary, "fetch", "--quiet", "--depth=1", "https://github.com/openai/codex.git", ref]);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return { dir: temporary, cleanup: () => rmSync(temporary, { recursive: true, force: true }) };
}

export function upstreamAsset(ref = pinnedCodexRef()) {
  const repo = openUpstream(ref);
  try {
    return git(repo.dir, ["show", `${ref}:${upstreamAssetPath}`]);
  } finally {
    repo.cleanup();
  }
}

const digest = (value) => createHash("sha256").update(value).digest("hex");

function expectedTransportTree(repo, ref) {
  const overlay = TRANSPORT_OVERLAYS[ref];
  if (!overlay) {
    throw new Error(
      `No pinned transport overlay for Codex ref ${ref}.`
      + " Review upstream app-server-transport changes and pin one in scripts/codex-assets.mjs.",
    );
  }
  const names = git(repo.dir, ["ls-tree", "-r", "--name-only", ref, upstreamTransportRoot])
    .toString("utf8").trim().split("\n")
    .map((name) => name.slice(upstreamTransportRoot.length + 1))
    .filter((name) => name === "Cargo.toml" || name.startsWith("src/"))
    .filter((name) => !/(^|\/)tests(\.rs|\/)|_tests\.rs$/u.test(name));
  const tree = new Map(names.map((name) =>
    [name, git(repo.dir, ["show", `${ref}:${upstreamTransportRoot}/${name}`]).toString("utf8")]));
  for (const { file, find, replace } of overlay) {
    const content = tree.get(file);
    const patched = content.replace(find, replace);
    if (patched === content) throw new Error(`Transport overlay did not apply to ${file} at ${ref}.`);
    tree.set(file, patched);
  }
  return tree;
}

function syncTransport(repo, ref, check) {
  const expected = expectedTransportTree(repo, ref);
  if (check) {
    const actual = existsSync(vendoredTransportDir)
      ? readdirSync(vendoredTransportDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(vendoredTransportDir, join(entry.parentPath, entry.name)).split(sep).join("/"))
      : [];
    const stale = [
      ...[...expected.keys()].filter((name) => !actual.includes(name)),
      ...actual.filter((name) => !expected.has(name)),
      ...[...expected].filter(([name, content]) =>
        actual.includes(name) && readFileSync(join(vendoredTransportDir, name), "utf8") !== content).map(([name]) => name),
    ];
    if (stale.length) {
      throw new Error(
        `relay/vendor/app-server-transport is out of sync with ${ref}:`
        + ` ${[...new Set(stale)].join(", ")}. Run npm run sync:codex-assets.`,
      );
    }
    return;
  }
  rmSync(vendoredTransportDir, { recursive: true, force: true });
  for (const [name, content] of expected) {
    mkdirSync(dirname(join(vendoredTransportDir, name)), { recursive: true });
    writeFileSync(join(vendoredTransportDir, name), content);
  }
}

export function syncCodexAsset(check = false) {
  const ref = pinnedCodexRef();
  const repo = openUpstream(ref);
  try {
    const upstream = git(repo.dir, ["show", `${ref}:${upstreamAssetPath}`]);
    if (check) {
      const vendored = readFileSync(vendoredAssetPath);
      if (!vendored.equals(upstream)) {
        throw new Error(
          `vendor/codex/continuation.md is out of sync with ${ref}:${upstreamAssetPath}`
          + ` (vendor ${digest(vendored)}, upstream ${digest(upstream)}). Run npm run sync:codex-assets.`,
        );
      }
    } else {
      mkdirSync(dirname(vendoredAssetPath), { recursive: true });
      writeFileSync(vendoredAssetPath, upstream);
    }
    syncTransport(repo, ref, check);
    console.log(check ? `Codex assets match ${ref}.` : `Synced codex assets from ${ref}.`);
  } finally {
    repo.cleanup();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  syncCodexAsset(process.argv.includes("--check"));
}
