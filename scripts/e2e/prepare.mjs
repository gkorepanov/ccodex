import { createReadStream, existsSync, mkdirSync, readdirSync, chownSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";

const projects = join(process.env.CLAUDE_CONFIG_DIR, "projects");
const state = join(process.env.CCODEX_HOME, "state", "state.sqlite");
const uid = Number(process.env.E2E_UID ?? 1000);
const gid = Number(process.env.E2E_GID ?? 1000);
const directories = new Set();

async function transcriptCwd(path) {
  let cwd;
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (typeof record.cwd === "string" && isAbsolute(record.cwd)) cwd = record.cwd;
    } catch {}
  }
  return cwd;
}

for (const project of readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
  const directory = join(projects, project.name);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const cwd = await transcriptCwd(join(directory, entry.name));
    if (cwd) directories.add(cwd);
  }
}

if (existsSync(state)) {
  const database = new DatabaseSync(state, { readOnly: true });
  try {
    const hasThreads = database.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'threads'").get().count;
    if (Number(hasThreads) === 1) {
      for (const { cwd } of database.prepare("SELECT DISTINCT cwd FROM threads WHERE cwd IS NOT NULL").all()) {
        if (typeof cwd === "string" && isAbsolute(cwd)) directories.add(cwd);
      }
    }
  } finally {
    database.close();
  }
}

for (const directory of directories) {
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  if (!existed) chownSync(directory, uid, gid);
}
