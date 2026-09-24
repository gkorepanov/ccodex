import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NativeSessionCatalog } from "../../../src/claude/native/catalog.js";
import { normalizeClaudeModelIdentifier } from "../../../src/claude/modelSelection.js";

const fixtureProjects = fileURLToPath(new URL("../../fixtures/nativeClaudeHome/projects/", import.meta.url));
const fixtureProject = join(fixtureProjects, "-home-user-project");
const fixtureIds = [
  "888c9222-8727-4bad-b970-13fdd721db04",
  "a0cd4fcb-7bd4-43fa-b0d3-7d46e39e912a",
  "d7dbe40e-3c05-40e6-b17f-40e4ff574798",
] as const;

function line(record: object): string {
  return `${JSON.stringify(record)}\n`;
}

function prompt(sessionId: string, text = "Synthetic prompt") {
  return {
    type: "user",
    uuid: `${sessionId}-prompt`,
    parentUuid: null,
    timestamp: "2026-09-18T00:00:01.000Z",
    sessionId,
    cwd: "/synthetic",
    gitBranch: "main",
    version: "test-version",
    origin: { kind: "human" },
    permissionMode: "default",
    message: { role: "user", content: text },
  };
}

async function temporaryCatalog(sessionId = fixtureIds[0]) {
  const root = await mkdtemp(join(tmpdir(), "ccodex-native-catalog-"));
  const projects = join(root, "projects");
  const project = join(projects, "-synthetic-project");
  await mkdir(project, { recursive: true });
  const path = join(project, `${sessionId}.jsonl`);
  await copyFile(join(fixtureProject, `${sessionId}.jsonl`), path);
  return { root, projects, project, path, sessionId };
}

describe("native Claude session catalog", () => {
  it("cold-scans every fixture session at project depth one", async () => {
    const catalog = new NativeSessionCatalog(fixtureProjects);
    await catalog.refresh();

    const expectedOrder = await Promise.all(fixtureIds.map(async (sessionId) => ({
      sessionId,
      updatedAt: Math.floor((await stat(join(fixtureProject, `${sessionId}.jsonl`))).mtimeMs / 1_000),
    })));
    expectedOrder.sort((left, right) =>
      right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId));
    expect(catalog.sessions().map((session) => session.sessionId))
      .toEqual(expectedOrder.map((session) => session.sessionId));
    expect(catalog.sessions().every((session) =>
      session.projectKey === "-home-user-project" && session.preview.length > 0)).toBe(true);
    expect(catalog.get(fixtureIds[0])?.hasSubagents).toBe(false);
    expect(catalog.get(fixtureIds[1])?.hasSubagents).toBe(false);
    expect(catalog.get(fixtureIds[2])?.hasSubagents).toBe(true);
  });

  it("shares thread header rules with projections", async () => {
    const catalog = new NativeSessionCatalog(fixtureProjects);
    await catalog.refresh();

    for (const session of catalog.sessions()) {
      const thread = (await catalog.projection(session.sessionId)).thread;
      expect(thread.preview).toBe(session.preview);
      expect(thread.name).toBe(session.customTitle ?? session.aiTitle);
      expect(thread.cwd).toBe(session.cwd);
      expect(thread.model).toBe(session.model ? `claude:${normalizeClaudeModelIdentifier(session.model)}` : null);
      expect(thread.reasoningEffort).toBe(session.reasoningEffort);
      expect(thread.createdAt).toBe(session.createdAt);
      expect(thread.updatedAt).toBe(session.updatedAt);
      expect(thread.gitInfo?.branch).toBe(session.gitBranch);
      expect(thread.cliVersion).toBe(session.cliVersion ?? "claude-code");
    }
  });

  it("parses only appended bytes on an incremental refresh", async () => {
    const temporary = await temporaryCatalog();
    try {
      const catalog = new NativeSessionCatalog(temporary.projects);
      await catalog.refresh();
      const parsedBefore = catalog.bytesParsed;
      const appended = line({
        type: "custom-title",
        customTitle: "Incremental synthetic title",
        sessionId: temporary.sessionId,
      });
      await appendFile(temporary.path, appended);
      await catalog.refresh();

      expect(catalog.get(temporary.sessionId)?.customTitle).toBe("Incremental synthetic title");
      expect(catalog.bytesParsed - parsedBefore).toBe(Buffer.byteLength(appended));
    } finally {
      await rm(temporary.root, { recursive: true });
    }
  });

  it("fully rescans a truncated transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccodex-native-catalog-truncate-"));
    const projects = join(root, "projects");
    const project = join(projects, "-synthetic-project");
    const sessionId = "truncate-session";
    const path = join(project, `${sessionId}.jsonl`);
    await mkdir(project, { recursive: true });
    const shortTranscript = line(prompt(sessionId, "Prompt after truncation"));
    await writeFile(path, `${shortTranscript}${line({
      type: "custom-title", customTitle: "Removed title", sessionId,
    })}`);
    try {
      const catalog = new NativeSessionCatalog(projects);
      await catalog.refresh();
      const parsedBefore = catalog.bytesParsed;
      await writeFile(path, shortTranscript);
      await catalog.refresh();

      expect(catalog.get(sessionId)).toMatchObject({
        preview: "Prompt after truncation",
        customTitle: null,
        sizeBytes: Buffer.byteLength(shortTranscript),
      });
      expect(catalog.bytesParsed - parsedBefore).toBe(Buffer.byteLength(shortTranscript));
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("forgets vanished transcript files", async () => {
    const temporary = await temporaryCatalog();
    try {
      const catalog = new NativeSessionCatalog(temporary.projects);
      await catalog.refresh();
      await rm(temporary.path);
      await catalog.refresh();
      expect(catalog.sessions()).toEqual([]);
      expect(catalog.get(temporary.sessionId)).toBeUndefined();
    } finally {
      await rm(temporary.root, { recursive: true });
    }
  });

  it("lists no session that only ran a local command", async () => {
    const temporary = await temporaryCatalog();
    try {
      const sessionId = "86d884b5-889d-434a-9c4c-7a28bb049898";
      const command = { ...prompt(sessionId), origin: undefined, message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>" } };
      await writeFile(join(temporary.project, `${sessionId}.jsonl`), line(command));
      const catalog = new NativeSessionCatalog(temporary.projects);
      await catalog.refresh();
      expect(catalog.sessions().map((summary) => summary.sessionId)).toEqual([temporary.sessionId]);
      await appendFile(join(temporary.project, `${sessionId}.jsonl`), line({ ...prompt(sessionId), uuid: "second" }));
      await catalog.refresh();
      expect(catalog.get(sessionId)?.preview).toBe("Synthetic prompt");
    } finally {
      await rm(temporary.root, { recursive: true });
    }
  });

  it("memoises projections by exact file identity", async () => {
    const temporary = await temporaryCatalog();
    try {
      const catalog = new NativeSessionCatalog(temporary.projects);
      await catalog.refresh();
      const first = await catalog.projection(temporary.sessionId);
      const second = await catalog.projection(temporary.sessionId);
      expect(second).toBe(first);

      await appendFile(temporary.path, line({
        type: "custom-title", customTitle: "Changed size", sessionId: temporary.sessionId,
      }));
      await catalog.refresh();
      const changed = await catalog.projection(temporary.sessionId);
      expect(changed).not.toBe(first);
    } finally {
      await rm(temporary.root, { recursive: true });
    }
  });

  it("refreshes and notifies after a watched project changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccodex-native-catalog-watch-"));
    const projects = join(root, "projects");
    const project = join(projects, "-synthetic-project");
    const sessionId = "watched-session";
    const path = join(project, `${sessionId}.jsonl`);
    await mkdir(project, { recursive: true });
    await writeFile(path, line(prompt(sessionId)));
    const catalog = new NativeSessionCatalog(projects);
    await catalog.refresh();
    let unsubscribe = () => {};
    try {
      const changed = new Promise<void>((resolveChange, reject) => {
        const timeout = setTimeout(() => reject(new Error("native catalog watch timed out")), 1_500);
        unsubscribe = catalog.watch(() => {
          clearTimeout(timeout);
          resolveChange();
        });
      });
      await appendFile(path, line({ type: "custom-title", customTitle: "Watched title", sessionId }));
      await changed;
      expect(catalog.get(sessionId)?.customTitle).toBe("Watched title");
    } finally {
      unsubscribe();
      await rm(root, { recursive: true });
    }
  });

  it("sees the first session of a machine where Claude has no projects directory yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "ccodex-native-catalog-fresh-"));
    const project = join(root, "projects", "-synthetic-project");
    const catalog = new NativeSessionCatalog(join(root, "projects"));
    await catalog.refresh();
    let unsubscribe = () => {};
    try {
      const changed = new Promise<void>((resolveChange, reject) => {
        const timeout = setTimeout(() => reject(new Error("native catalog watch timed out")), 1_500);
        unsubscribe = catalog.watch(() => {
          clearTimeout(timeout);
          resolveChange();
        });
      });
      await mkdir(project, { recursive: true });
      await writeFile(join(project, "first-session.jsonl"), line(prompt("first-session")));
      await changed;
      expect(catalog.get("first-session")).toBeDefined();
    } finally {
      unsubscribe();
      await rm(root, { recursive: true });
    }
  });
});
