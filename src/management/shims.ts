import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./layout.js";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function prelude(nodeExecutable: string): string {
  return `#!/bin/sh
set -eu
if [ "\${CCODEX_SHIM_ACTIVE:-}" = 1 ]; then
  printf '%s\\n' 'CCodex recursion guard: managed shim attempted to invoke itself.' >&2
  exit 70
fi
CCODEX_SHIM_ACTIVE=1
CCODEX_HOME=\${CCODEX_HOME:-"$HOME/.ccodex"}
CCODEX_NODE=${shellQuote(nodeExecutable)}
if [ ! -x "$CCODEX_NODE" ]; then
  CCODEX_NODE=$(command -v node 2>/dev/null || true)
fi
if [ -z "$CCODEX_NODE" ] || [ ! -x "$CCODEX_NODE" ]; then
  printf '%s\\n' 'CCodex Node runtime is missing. Reinstall Node.js, then run: npm install -g @gkorepanov/ccodex && ccodex setup' >&2
  exit 69
fi
export CCODEX_SHIM_ACTIVE CCODEX_HOME
`;
}

const current = `exec "$CCODEX_NODE" "$CCODEX_HOME/current/node_modules/@gkorepanov/ccodex/dist/cli/main.js" "$@"
`;

export function codexShim(nodeExecutable: string): string {
  return `${prelude(nodeExecutable)}${current}`;
}

export function ccodexShim(nodeExecutable: string): string {
  return `${prelude(nodeExecutable)}case "\${1:-}" in
  setup|update|rollback|uninstall|doctor|auth)
    global_root=$(npm root -g 2>/dev/null || true)
    global_package="$global_root/@gkorepanov/ccodex"
    global_cli="$global_package/dist/cli/main.js"
    current_manifest="$CCODEX_HOME/current/node_modules/@gkorepanov/ccodex/package.json"
    if [ -f "$global_cli" ] && "$CCODEX_NODE" "$global_package/dist/management/shimSelect.js" "$current_manifest"; then
      exec "$CCODEX_NODE" "$global_cli" "$@"
    fi
    ;;
esac
${current}`;
}

export const CODEX_SHIM = codexShim(process.execPath);
export const CCODEX_SHIM = ccodexShim(process.execPath);

export type ManagedShim = "ccodex" | "codex";

export function managedShim(name: ManagedShim, nodeExecutable = process.execPath): string {
  return name === "ccodex" ? ccodexShim(nodeExecutable) : codexShim(nodeExecutable);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface ManagedShimChange {
  readonly path: string;
  readonly content?: string;
  readonly mode: number;
}

export function installManagedShims(
  binDirectory: string,
  nodeExecutable: string,
  previousHashes: Readonly<Record<string, string>> = {},
): {
  readonly hashes: Readonly<Record<string, string>>;
  readonly changes: readonly ManagedShimChange[];
} {
  const hashes: Record<string, string> = {};
  const planned = (["ccodex", "codex"] as const).map((name) => {
    const path = join(binDirectory, name);
    const desired = managedShim(name, nodeExecutable);
    const desiredHash = sha256(desired);
    hashes[name] = desiredHash;
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (content === desired) return { desired };
      if (!previousHashes[name] || sha256(content) !== previousHashes[name]) {
        throw new Error(`Refusing to overwrite modified or unmanaged CCodex shim ${path}`);
      }
      return { desired, change: { path, content, mode: statSync(path).mode & 0o777 } };
    }
    return { desired, change: { path, mode: 0o755 } };
  });
  const changes = planned
    .map(({ change }) => change)
    .filter((change): change is ManagedShimChange => change !== undefined);
  for (const { desired, change } of planned) {
    if (change) atomicWrite(change.path, desired, 0o755);
  }
  return { hashes, changes };
}

export function restoreManagedShims(changes: readonly ManagedShimChange[]): void {
  for (const change of [...changes].reverse()) {
    if (change.content === undefined) rmSync(change.path, { force: true });
    else atomicWrite(change.path, change.content, change.mode);
  }
}

export type ShimRepair = "absent" | "current" | "modified" | "updated";

export function repairManagedCcodexShim(
  home = process.env.CCODEX_HOME ?? join(homedir(), ".ccodex"),
): ShimRepair {
  const shim = join(home, "bin", "ccodex");
  const manifestPath = join(home, "install.json");
  if (!existsSync(shim) || !existsSync(manifestPath)) return "absent";
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    nodeExecutable?: string;
    shimHashes?: Record<string, string>;
  };
  const content = readFileSync(shim, "utf8");
  const desired = ccodexShim(manifest.nodeExecutable ?? process.execPath);
  const desiredHash = sha256(desired);
  if (content === desired) {
    if (manifest.shimHashes?.ccodex !== desiredHash) {
      manifest.shimHashes = { ...manifest.shimHashes, ccodex: desiredHash };
      atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    }
    return "current";
  }
  if (!manifest.shimHashes?.ccodex || sha256(content) !== manifest.shimHashes.ccodex) return "modified";
  atomicWrite(shim, desired, 0o755);
  manifest.shimHashes = { ...manifest.shimHashes, ccodex: desiredHash };
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return "updated";
}
