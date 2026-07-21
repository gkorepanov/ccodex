import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { generateResponseItemSchema } from "./generate-response-item-schema.mjs";

const require = createRequire(import.meta.url);
const project = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const protocolVersion = project.dependencies["@openai/codex"];
const override = process.env.CODEX_SCHEMA_CODEX;
const packageJsonPath = require.resolve("@openai/codex/package.json");
const codexPackage = JSON.parse(readFileSync(packageJsonPath, "utf8"));
if (!override && codexPackage.version !== protocolVersion) {
  throw new Error(`Installed @openai/codex ${codexPackage.version} does not match pinned ${protocolVersion}`);
}
const codex = override
  ? { command: override, prefix: [] }
  : {
      command: process.execPath,
      prefix: [resolve(dirname(packageJsonPath), codexPackage.bin.codex)],
    };
const version = spawnSync(codex.command, [...codex.prefix, "--version"], { encoding: "utf8" });
if (version.status !== 0) process.exit(version.status ?? 1);
if (version.stdout.trim() !== `codex-cli ${protocolVersion}`) {
  throw new Error(`Schema binary '${version.stdout.trim()}' does not match pinned codex-cli ${protocolVersion}`);
}

const check = process.argv.includes("--check");
const temporary = check ? mkdtempSync(join(tmpdir(), "ccodex-protocol-")) : undefined;
const tsOut = temporary ? join(temporary, "ts") : resolve("src/codex/generated");
const jsonOut = temporary ? join(temporary, "json") : resolve("schemas/generated");

function files(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? files(root, join(prefix, entry.name))
      : [join(prefix, entry.name)])
    .sort();
}

try {
  rmSync(tsOut, { recursive: true, force: true });
  rmSync(jsonOut, { recursive: true, force: true });
  mkdirSync(tsOut, { recursive: true });
  mkdirSync(jsonOut, { recursive: true });

  for (const args of [
    ["app-server", "generate-ts", "--experimental", "--out", tsOut],
    ["app-server", "generate-json-schema", "--experimental", "--out", jsonOut],
  ]) {
    const result = spawnSync(codex.command, [...codex.prefix, ...args], { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  generateResponseItemSchema(
    join(jsonOut, "ClientRequest.json"),
    join(tsOut, "ResponseItemRuntimeSchema.ts"),
    protocolVersion,
  );

  if (check) {
    const committed = resolve("src/codex/generated");
    const expectedFiles = files(tsOut);
    const committedFiles = files(committed);
    if (JSON.stringify(expectedFiles) !== JSON.stringify(committedFiles)) {
      throw new Error("Generated Codex protocol file list drifted; run npm run generate:protocol");
    }
    for (const file of expectedFiles) {
      if (readFileSync(join(tsOut, file), "utf8") !== readFileSync(join(committed, file), "utf8")) {
        throw new Error(`Generated Codex protocol drifted at ${file}; run npm run generate:protocol`);
      }
    }
  }
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true });
}
