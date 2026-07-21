import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface ToolPolicy {
  readonly decision: "defer" | "ask" | "deny";
  readonly reason?: string;
}

const fileTools = new Set(["Edit", "Write", "NotebookEdit"]);

export function isFileMutationTool(name: string): boolean {
  return fileTools.has(name);
}

function canonical(path: string): string {
  let ancestor = path;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return path;
    ancestor = parent;
  }
  const suffix = relative(ancestor, path);
  return resolve(realpathSync(ancestor), suffix);
}

function inside(path: string, root: string): boolean {
  const child = relative(canonical(root), canonical(path));
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function filePath(name: string, input: Record<string, unknown>, cwd: string): string | undefined {
  if (!isFileMutationTool(name)) return undefined;
  const value = name === "NotebookEdit" ? input.notebook_path ?? input.path : input.file_path ?? input.path;
  if (typeof value !== "string" || !value) return undefined;
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export function toolPolicy(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  approvalPolicy: unknown,
  sandboxPolicy: unknown,
): ToolPolicy {
  const sandbox = sandboxPolicy && typeof sandboxPolicy === "object" && "type" in sandboxPolicy
    ? sandboxPolicy as { type: unknown; writableRoots?: unknown }
    : undefined;
  const path = filePath(name, input, cwd);
  if (sandbox?.type === "readOnly" && (name === "Bash" || path)) {
    return { decision: "deny", reason: `Tool '${name}' is not allowed in a read-only Claude thread.` };
  }
  if (sandbox?.type === "workspaceWrite" && path) {
    const roots = Array.isArray(sandbox.writableRoots) ? sandbox.writableRoots.filter((root): root is string => typeof root === "string") : [];
    if (!roots.some((root) => inside(path, root))) {
      return { decision: "deny", reason: `File '${path}' is outside the writable roots.` };
    }
  }
  if (name === "Bash" && (approvalPolicy === "on-request" || approvalPolicy === "untrusted")) {
    return { decision: "ask", reason: "Shell execution requires Codex UI approval." };
  }
  return { decision: "defer" };
}
