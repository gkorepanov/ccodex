import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { FileUpdateChange } from "../codex/generated/v2/FileUpdateChange.js";

export interface FileSnapshot {
  readonly path: string;
  readonly content: string | null;
}

function inputPath(toolName: string, input: Record<string, unknown>): string | undefined {
  const key = toolName === "NotebookEdit" ? "notebook_path" : "file_path";
  const value = input[key] ?? input.path;
  return typeof value === "string" && value ? value : undefined;
}

async function readText(path: string): Promise<string | null | undefined> {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    return undefined;
  }
}

export async function snapshotFile(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): Promise<FileSnapshot | undefined> {
  const candidate = inputPath(toolName, input);
  if (!candidate) return undefined;
  const path = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
  const content = await readText(path);
  return content === undefined ? undefined : { path, content };
}

export async function diffFile(snapshot: FileSnapshot): Promise<FileUpdateChange | undefined> {
  const content = await readText(snapshot.path);
  if (content === undefined || content === snapshot.content) return undefined;
  const kind = snapshot.content === null
    ? { type: "add" as const }
    : content === null
      ? { type: "delete" as const }
      : { type: "update" as const, move_path: null };
  const beforePath = snapshot.content === null ? "/dev/null" : snapshot.path;
  const afterPath = content === null ? "/dev/null" : snapshot.path;
  return {
    path: snapshot.path,
    kind,
    diff: createTwoFilesPatch(beforePath, afterPath, snapshot.content ?? "", content ?? "", "", ""),
  };
}
