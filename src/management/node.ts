import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Prefer Desktop's signed Node for native App Tools' process-ancestry checks. */
export async function setupNode(
  platform = process.platform,
  apps = ["/Applications/ChatGPT.app", join(homedir(), "Applications", "ChatGPT.app")],
): Promise<string> {
  if (platform === "darwin") {
    for (const app of apps) {
      const node = join(app, "Contents", "Resources", "cua_node", "bin", "node");
      const version = await execute(node, ["-p", "process.versions.node"], { timeout: 5_000 })
        .then(({ stdout }) => stdout.trim(), () => "");
      const [major, minor] = version.split(".").map(Number);
      // Same supported range as package.json and install.sh: >=22.13 <27.
      if (major !== undefined && minor !== undefined && major >= 22 && major < 27 && (major !== 22 || minor >= 13)) return node;
    }
  }
  return process.execPath;
}
