import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWrite } from "./layout.js";

const prelude = `#!/bin/sh
set -eu
if [ "\${CCODEX_SHIM_ACTIVE:-}" = 1 ]; then
  printf '%s\\n' 'CCodex recursion guard: managed shim attempted to invoke itself.' >&2
  exit 70
fi
CCODEX_SHIM_ACTIVE=1
CCODEX_HOME=\${CCODEX_HOME:-"$HOME/.ccodex"}
export CCODEX_SHIM_ACTIVE CCODEX_HOME
`;

const current = `exec "$CCODEX_HOME/current/node_modules/.bin/ccodex" "$@"
`;

export const CODEX_SHIM = `${prelude}${current}`;

export const CCODEX_SHIM = `${prelude}case "\${1:-}" in
  setup|update|rollback|uninstall|doctor|auth)
    global_root=$(npm root -g 2>/dev/null || true)
    global_package="$global_root/@gkorepanov/ccodex"
    global_cli="$global_package/dist/cli/main.js"
    current_manifest="$CCODEX_HOME/current/node_modules/@gkorepanov/ccodex/package.json"
    if [ -f "$global_cli" ] && node "$global_package/dist/management/shimSelect.js" "$current_manifest"; then
      exec node "$global_cli" "$@"
    fi
    ;;
esac
${current}`;

export function managedShim(name: "ccodex" | "codex"): string {
  return name === "ccodex" ? CCODEX_SHIM : CODEX_SHIM;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export type ShimRepair = "absent" | "current" | "modified" | "updated";

export function repairManagedCcodexShim(home = process.env.CCODEX_HOME ?? join(homedir(), ".ccodex")): ShimRepair {
  const shim = join(home, "bin", "ccodex");
  const manifestPath = join(home, "install.json");
  if (!existsSync(shim) || !existsSync(manifestPath)) return "absent";
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    shimHashes?: Record<string, string>;
  };
  const content = readFileSync(shim, "utf8");
  const desiredHash = sha256(CCODEX_SHIM);
  if (content === CCODEX_SHIM) {
    if (manifest.shimHashes?.ccodex !== desiredHash) {
      manifest.shimHashes = { ...manifest.shimHashes, ccodex: desiredHash };
      atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    }
    return "current";
  }
  if (!manifest.shimHashes?.ccodex || sha256(content) !== manifest.shimHashes.ccodex) return "modified";
  atomicWrite(shim, CCODEX_SHIM, 0o755);
  manifest.shimHashes = { ...manifest.shimHashes, ccodex: desiredHash };
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  return "updated";
}
