import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputPath = join(root, "contracts/lifecycle/v1/test-inventory.v1.json");

const selectedFiles = new Set([
  "tests/gateway/goalRpc.test.ts",
  "tests/gateway/providerRateLimits.test.ts",
  "tests/gateway/subscriptions.test.ts",
  "tests/handoff/service.test.ts",
  "tests/store/sqliteStore.test.ts",
]);

const providerMappingFiles = new Set([
  "adapterVariants.test.ts",
  "hookMapper.test.ts",
  "inputMapper.test.ts",
  "modelCatalog.test.ts",
  "modelSelection.test.ts",
  "permissionPolicy.test.ts",
  "rateLimits.test.ts",
  "resultClassifier.test.ts",
  "sdkMessageInventory.test.ts",
  "toolMapper.test.ts",
]);

const implementationDetailFiles = new Set([
  "fileSnapshots.test.ts",
  "lifecycleSoak.test.ts",
  "transcriptBrancher.test.ts",
  "sqliteStore.test.ts",
]);

async function testFiles(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.(?:ts|mjs)$/u.test(entry.name) ? [path] : [];
  }));
  return files.flat();
}

function classification(path) {
  if (path.startsWith("tests/claude/session/") || path === "tests/claude/sessionRegistry.test.ts") {
    return "architecture-invariant";
  }
  const name = basename(path);
  if (implementationDetailFiles.has(name)) return "old-implementation-detail";
  if (providerMappingFiles.has(name)) return "provider-mapping";
  return "external-contract";
}

function rationale(path, kind) {
  if (kind === "architecture-invariant") {
    return "Freezes bounded mailbox, single-owner session routing, ordering, backpressure, and shutdown invariants required by the lifecycle rewrite.";
  }
  if (kind === "old-implementation-detail") {
    if (path.endsWith("sqliteStore.test.ts")) return "Freezes the current broad-record/SQLite implementation; retain as migration evidence, not reducer parity.";
    if (path.endsWith("transcriptBrancher.test.ts")) return "Exercises the current transcript helper rather than the public lifecycle surface.";
    if (path.endsWith("lifecycleSoak.test.ts")) return "Operational leak/soak guard; valuable hardening but not an observable trace contract.";
    return "Exercises an internal helper rather than an App/provider wire contract.";
  }
  if (kind === "provider-mapping") return "Freezes Claude SDK/control/tool input into normalized Codex semantics.";
  return "Freezes App-visible RPC, durable snapshot, event ordering/cardinality, or restart behavior.";
}

function testTitles(path, source) {
  const scriptKind = path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const titles = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const directIt = ts.isIdentifier(node.expression) && node.expression.text === "it";
      const eachIt = ts.isCallExpression(node.expression)
        && ts.isPropertyAccessExpression(node.expression.expression)
        && ts.isIdentifier(node.expression.expression.expression)
        && node.expression.expression.expression.text === "it"
        && node.expression.expression.name.text === "each";
      const title = node.arguments[0];
      if ((directIt || eachIt) && (ts.isStringLiteral(title) || ts.isNoSubstitutionTemplateLiteral(title))) {
        titles.push(title.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return titles;
}

const claudeFiles = await testFiles("tests/claude");
const files = [...claudeFiles, ...selectedFiles].sort();
const cases = [];
for (const path of files) {
  const source = await readFile(join(root, path), "utf8");
  const titles = testTitles(path, source);
  const kind = classification(path);
  for (const title of titles) cases.push({ path, title, classification: kind, rationale: rationale(path, kind) });
}

const inventory = {
  schemaVersion: 1,
  contractVersion: "lifecycle-v1",
  generatedBy: relative(root, fileURLToPath(import.meta.url)),
  scope: {
    included: [
      "all tests/claude/**/*.test.ts",
      ...[...selectedFiles].sort(),
    ],
    excluded: [
      "CLI/config/daemon/management/observability tests: packaging and process supervision are rewrite non-goals",
      "generic protocol cursor/error/stock parity tests: gateway compatibility remains unchanged but is outside Claude lifecycle ownership",
    ],
  },
  counts: Object.fromEntries([
    "architecture-invariant",
    "external-contract",
    "provider-mapping",
    "old-implementation-detail",
  ].map((kind) => [kind, cases.filter((entry) => entry.classification === kind).length])),
  cases,
};

const serialized = `${JSON.stringify(inventory, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8");
  if (current !== serialized) {
    console.error("Lifecycle test inventory is stale. Run: npm run contracts:lifecycle:inventory");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, serialized);
}
