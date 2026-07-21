import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import ts from "typescript";

export const STORE_READS = new Set([
  "allThreadRecords",
  "eventHighWatermark",
  "findPendingRequestByClaudeId",
  "getGoal",
  "getPendingRequest",
  "getThreadRecord",
  "getTurn",
  "getTurnClaudeMessageUuid",
  "hasProcessedProviderEvent",
  "hasThread",
  "isThreadArchived",
  "listEventsAfter",
  "listPendingRequests",
  "listPendingThreadRemovals",
  "listProviderEvents",
  "listProviderItemCorrelations",
  "listThreads",
  "listTurns",
]);

export const STORE_INFRASTRUCTURE = new Set(["close"]);

export const HUB_PRODUCT_OUTPUT = new Set([
  "emit",
  "request",
  "suppress",
  "threadDeleted",
  "unsuppress",
]);

export const RUNTIME_FORBIDDEN_TYPES = new Set([
  "ClaudeThreadRecord",
  "HybridStore",
  "SubscriptionHub",
  "ThreadItem",
  "Turn",
]);

const PERSISTENCE_ADAPTER = "src/claude/session/repository.ts";
const OUTPUT_ADAPTER = "src/claude/session/outputAdapter.ts";
const CANONICAL_SESSION = "src/claude/session/session.ts";
const LEGACY_RUNTIME = "src/claude/sessionRuntime.ts";
const PROVIDER_RUNTIME = "src/claude/session/providerRuntime.ts";
const PROVIDER_PROJECTOR = "src/claude/session/providerProjector.ts";
const PROVIDER_RUNTIME_FACTORY = "src/claude/session/providerRuntimeFactory.ts";
const QUERY_RUNTIME = "src/claude/session/runtime.ts";
const LEGACY_RUNTIME_IMPORT = /(?:^|\/)sessionRuntime\.(?:js|ts)$/u;
const CODEX_PROTOCOL_IMPORT = /(?:^|\/)codex\/generated\//u;

const DUPLICATE_LIFECYCLE_MEMBERS = new Map([
  ["active", "active-turn-state"],
  ["activeTurnId", "active-turn-state"],
  ["stagedTurnIds", "active-turn-state"],
  ["compactionEffect", "compaction-state"],
  ["lifecycleQuiescent", "quiescence-state"],
  ["isLifecycleQuiescent", "quiescence-state"],
  ["acceptSessionLifecycle", "lifecycle-sync"],
]);

const RUNTIME_PRODUCT_MEMBERS = new Map([
  ["transportSettings", "applied-settings"],
  ["appliedGeneration", "applied-settings"],
  ["settingsApplication", "applied-settings"],
  ["sessionApprovedTools", "session-approvals"],
  ["ephemeralPreludeBatches", "ephemeral-replay"],
  ["noQueryOperations", "no-query-lifecycle"],
  ["suppressedGoalBlocks", "goal-projection"],
  ["providerError", "terminal-classification"],
  ["usageSnapshotGeneration", "usage-lifecycle"],
  ["goalCommandTokensObserved", "goal-usage"],
]);

function position(tree, node) {
  const point = tree.getLineAndCharacterOfPosition(node.getStart(tree));
  return { line: point.line + 1, column: point.character + 1 };
}

function namedOwner(node, tree) {
  if (ts.isPropertyDeclaration(node)) return memberName(node) ?? "<property>";
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return node.name?.getText(tree) ?? "<anonymous>";
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? "<anonymous>";
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    if (ts.isVariableDeclaration(node.parent)) return node.parent.name.getText(tree);
    if (ts.isPropertyDeclaration(node.parent)) return node.parent.name.getText(tree);
    return "<callback>";
  }
  return undefined;
}

function className(node) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent)) return parent.name?.text ?? "<class>";
  }
  return undefined;
}

function ownerName(node, tree, owners) {
  const local = owners.at(-1) ?? "<module>";
  const ownerClass = className(node);
  return ownerClass && !local.startsWith(`${ownerClass}.`) ? `${ownerClass}.${local}` : local;
}

function isThisMember(node, name) {
  return ts.isPropertyAccessExpression(node)
    && node.name.text === name
    && node.expression.kind === ts.SyntaxKind.ThisKeyword;
}

function isNamedReceiver(node, names) {
  return (ts.isIdentifier(node) && names.has(node.text))
    || (ts.isPropertyAccessExpression(node) && names.has(node.name.text));
}

function declaredName(node) {
  return ts.isIdentifier(node.name) ? node.name.text : undefined;
}

function memberName(node) {
  return node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))
    ? node.name.text
    : undefined;
}

function receiverNames(tree) {
  const storeTypes = new Set(["HybridStore"]);
  const hubTypes = new Set(["SubscriptionHub"]);
  const stores = new Set(["store"]);
  const hubs = new Set(["hub"]);

  const collectImports = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings
      && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const specifier of node.importClause.namedBindings.elements) {
        const imported = importedName(specifier);
        if (imported === "HybridStore") storeTypes.add(specifier.name.text);
        if (imported === "SubscriptionHub") hubTypes.add(specifier.name.text);
      }
    }
    ts.forEachChild(node, collectImports);
  };
  collectImports(tree);

  const collectDeclarations = (node) => {
    if ((ts.isPropertyDeclaration(node) || ts.isParameter(node) || ts.isVariableDeclaration(node))
      && node.type && ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)) {
      const name = declaredName(node);
      if (name && storeTypes.has(node.type.typeName.text)) stores.add(name);
      if (name && hubTypes.has(node.type.typeName.text)) hubs.add(name);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(tree);
  return { stores, hubs };
}

function importedName(specifier) {
  return specifier.propertyName?.text ?? specifier.name.text;
}

function isRuntimeAdapter(tree, path) {
  if (path === CANONICAL_SESSION || path === LEGACY_RUNTIME) {
    return false;
  }
  if (path === PROVIDER_RUNTIME || path === PROVIDER_PROJECTOR
    || path === PROVIDER_RUNTIME_FACTORY || path === QUERY_RUNTIME) return true;
  return tree.statements.some((statement) =>
    ts.isImportDeclaration(statement)
    && statement.importClause?.namedBindings
    && ts.isNamedImports(statement.importClause.namedBindings)
    && statement.importClause.namedBindings.elements.some((specifier) =>
      importedName(specifier) === "ClaudeRuntime"));
}

export function scanSource(path, source) {
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const receivers = receiverNames(tree);
  const runtimeAdapter = isRuntimeAdapter(tree, path);
  const violations = [];
  const owners = [];

  const add = (rule, node, symbol) => {
    violations.push({
      rule,
      path,
      owner: ownerName(node, tree, owners),
      symbol,
      ...position(tree, node),
    });
  };

  const visit = (node) => {
    const ownName = namedOwner(node, tree);
    if (ownName) {
      const ownerClass = className(node);
      owners.push(ownerClass ? `${ownerClass}.${ownName}` : ownName);
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      if (path !== PERSISTENCE_ADAPTER
        && isNamedReceiver(receiver, receivers.stores)
        && !STORE_READS.has(method)
        && !STORE_INFRASTRUCTURE.has(method)) {
        add("direct-store-product-mutation", node.expression, method);
      }
      if (path !== OUTPUT_ADAPTER && HUB_PRODUCT_OUTPUT.has(method)
        && isNamedReceiver(receiver, receivers.hubs)) {
        add("direct-hub-product-output", node.expression, `hub.${method}`);
      }
      if (method === "synchronizeRecord") {
        add("runtime-record-synchronization", node.expression, "synchronizeRecord");
      }
    }

    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
      && LEGACY_RUNTIME_IMPORT.test(node.moduleSpecifier.text)) {
      add("legacy-lifecycle-import", node.moduleSpecifier, "sessionRuntime");
    }

    if (runtimeAdapter && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (CODEX_PROTOCOL_IMPORT.test(node.moduleSpecifier.text)) {
        add("runtime-codex-protocol-import", node.moduleSpecifier, node.moduleSpecifier.text);
      }
      if (node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const specifier of node.importClause.namedBindings.elements) {
          if (importedName(specifier) === "ClaudeSessionCommand") {
            add("runtime-lifecycle-command-channel", specifier, "ClaudeSessionCommand");
          }
        }
      }
    }

    if (runtimeAdapter
      && (ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))) {
      const name = memberName(node);
      const symbol = name && RUNTIME_PRODUCT_MEMBERS.get(name);
      if (symbol) add("runtime-product-state-owner", node, symbol);
    }

    if (path !== CANONICAL_SESSION
      && (ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node)
        || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node))) {
      const name = memberName(node);
      const symbol = name && DUPLICATE_LIFECYCLE_MEMBERS.get(name);
      if (symbol) add("duplicate-lifecycle-owner", node, symbol);
    }

    if (path === LEGACY_RUNTIME) {
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings
        && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const specifier of node.importClause.namedBindings.elements) {
          const name = importedName(specifier);
          if (RUNTIME_FORBIDDEN_TYPES.has(name)) {
            add("runtime-forbidden-import", specifier, name);
          }
        }
      }
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)
        && RUNTIME_FORBIDDEN_TYPES.has(node.typeName.text)) {
        add("runtime-forbidden-type-reference", node, node.typeName.text);
      }
      if (isThisMember(node, "store") || isThisMember(node, "hub")) {
        add("runtime-store-hub-access", node, node.name.text);
      }
    }

    ts.forEachChild(node, visit);
    if (ownName) owners.pop();
  };

  visit(tree);
  return violations;
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

export async function scanProject(root) {
  const files = await sourceFiles(join(root, "src/claude"));
  const violations = [];
  for (const file of files.sort()) {
    const path = relative(root, file);
    violations.push(...scanSource(path, await readFile(file, "utf8")));
  }
  return violations;
}

export function debtEntries(violations) {
  const counts = new Map();
  for (const violation of violations) {
    const key = [violation.rule, violation.path, violation.owner, violation.symbol].join("\0");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => {
    const [rule, path, owner, symbol] = key.split("\0");
    return { rule, path, owner, symbol, count };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function compareDebt(actual, expected) {
  const key = (entry) => [entry.rule, entry.path, entry.owner, entry.symbol].join("\0");
  const actualByKey = new Map(actual.map((entry) => [key(entry), entry]));
  const expectedByKey = new Map(expected.map((entry) => [key(entry), entry]));
  const added = actual.filter((entry) => entry.count !== expectedByKey.get(key(entry))?.count);
  const removed = expected.filter((entry) => entry.count !== actualByKey.get(key(entry))?.count);
  return { added, removed };
}
