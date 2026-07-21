import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type Scenario = {
  id: string;
  tests: string[];
  gap: string | null;
  orderingAndCardinality: string[];
  reconnectRestart: string;
};

const readJson = (path: string) => JSON.parse(readFileSync(join(process.cwd(), path), "utf8"));
const matrix = readJson("contracts/lifecycle/v1/contract-matrix.v1.json") as {
  scenarios: Scenario[];
  supportedLifecycleRpc: string[];
  providerEventTypes: { topLevel: string[]; systemSubtypes: string[] };
};
const inventory = readJson("contracts/lifecycle/v1/test-inventory.v1.json") as {
  cases: Array<{ path: string; title: string; classification: string }>;
};
const goldens = readJson("contracts/lifecycle/v1/golden-traces.v1.json") as {
  main: Record<string, string[]>;
  child: Record<string, string[]>;
  ephemeral: Record<string, string[]>;
};

describe("lifecycle rewrite v1 contract freeze", () => {
  it("keeps every known scenario tied to an automated regression or explicit blocker", () => {
    expect(new Set(matrix.scenarios.map((scenario) => scenario.id)).size).toBe(matrix.scenarios.length);
    for (const scenario of matrix.scenarios) {
      expect(scenario.orderingAndCardinality.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.reconnectRestart, scenario.id).not.toBe("");
      expect(scenario.tests.length > 0 || scenario.gap !== null, scenario.id).toBe(true);
      for (const reference of scenario.tests) {
        const [path = "", title] = reference.split("#");
        const source = readFileSync(join(process.cwd(), path), "utf8");
        if (title) expect(source, reference).toContain(title);
      }
    }
  });

  it("freezes supported RPC/provider inputs and normalized main, child, and ephemeral traces", () => {
    expect(matrix.supportedLifecycleRpc).toContain("thread/backgroundTerminals/clean");
    expect(matrix.supportedLifecycleRpc).toContain("thread/inject_items");
    expect(matrix.providerEventTypes.topLevel).toEqual(expect.arrayContaining(["assistant", "user", "result", "stream_event"]));
    expect(matrix.providerEventTypes.systemSubtypes).toEqual(expect.arrayContaining([
      "compact_boundary", "task_notification", "session_state_changed", "permission_denied",
    ]));
    expect(Object.keys(goldens.main).length).toBeGreaterThan(0);
    expect(Object.keys(goldens.child)).toContain("subagent");
    expect(Object.keys(goldens.ephemeral)).toEqual(expect.arrayContaining(["side", "compact", "title"]));
  });

  it("classifies every inventoried case into exactly one migration category", () => {
    const allowed = new Set([
      "architecture-invariant",
      "external-contract",
      "provider-mapping",
      "old-implementation-detail",
    ]);
    expect(inventory.cases.length).toBeGreaterThan(100);
    for (const entry of inventory.cases) expect(allowed.has(entry.classification), `${entry.path}#${entry.title}`).toBe(true);
    expect(new Set(inventory.cases.map((entry) => `${entry.path}#${entry.title}`)).size).toBe(inventory.cases.length);
    expect(inventory.cases.filter((entry) => entry.classification === "architecture-invariant"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "tests/claude/session/mailbox.test.ts" }),
        expect.objectContaining({ path: "tests/claude/session/session.test.ts" }),
        expect.objectContaining({ path: "tests/claude/sessionRegistry.test.ts" }),
      ]));
  });
});
