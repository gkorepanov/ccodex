import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compareDebt, debtEntries, scanProject } from "./lib/one-writer-gate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ledgerPath = join(root, "contracts/architecture/one-writer-debt.v1.json");
const targetZero = process.argv.includes("--target-zero");
const updateLedger = process.argv.includes("--update-ledger");
const json = process.argv.includes("--json");
const violations = await scanProject(root);
const entries = debtEntries(violations);
const total = entries.reduce((sum, entry) => sum + entry.count, 0);

if (updateLedger) {
  const ledger = {
    schemaVersion: 1,
    architecture: "one-claude-session-writer",
    generatedBy: "scripts/check-one-writer-architecture.mjs --update-ledger",
    debtCount: total,
    entries,
  };
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  console.log(`Updated one-writer debt ledger: ${total} violations.`);
  process.exit(0);
}

if (targetZero) {
  if (json) console.log(JSON.stringify({ targetZero: true, debtCount: total, entries }, null, 2));
  else console.log(`One-writer target-zero: ${total === 0 ? "PASS" : `FAIL (${total} violations remain)`}.`);
  if (total !== 0) process.exitCode = 1;
  process.exit();
}

const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
const difference = compareDebt(entries, ledger.entries);
const exact = ledger.debtCount === total && difference.added.length === 0 && difference.removed.length === 0;
const report = {
  baselineMatch: exact,
  debtCount: total,
  targetZero: total === 0,
  addedOrChanged: difference.added,
  removedOrChanged: difference.removed,
};

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else if (exact) {
  console.log(`One-writer baseline: PASS with ${total} explicit debt violations; target-zero: ${total === 0 ? "PASS" : "FAIL"}.`);
} else {
  console.error(`One-writer baseline: FAIL (ledger ${ledger.debtCount}, actual ${total}).`);
  if (difference.added.length > 0) console.error("Added/changed:", JSON.stringify(difference.added, null, 2));
  if (difference.removed.length > 0) console.error("Removed/changed:", JSON.stringify(difference.removed, null, 2));
  console.error("After an intentional writer deletion, update the ledger explicitly with npm run architecture:baseline.");
}
if (!exact) process.exitCode = 1;

