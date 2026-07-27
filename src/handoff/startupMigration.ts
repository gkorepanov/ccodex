import type { ClaudeService } from "../claude/service.js";
import type { StockRpc } from "../gateway/stockRpc.js";
import { LineageStore, type LegacyBackendRef } from "./lineageStore.js";
import { HandoffStore } from "./store.js";

interface MigrationStock {
  initialize(): Promise<void>;
  request(method: string, params: unknown): Promise<unknown>;
}

interface MigrationClaude {
  readThread(threadId: string, includeTurns: boolean): unknown;
}

export interface HandoffPersistence {
  readonly operational: HandoffStore;
  readonly lineage: LineageStore;
}

function backendKey(ref: LegacyBackendRef): string {
  return `${ref.provider}:${ref.backendThreadId}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Opens the shared handoff database only after the daemon stock connection is
 * initialized. A legacy database is migrated only after every provider-owned
 * backend can be read through its official API.
 */
export async function initializeHandoffPersistence(
  path: string,
  stock: MigrationStock | StockRpc,
  claude: MigrationClaude | ClaudeService,
): Promise<HandoffPersistence> {
  await stock.initialize();

  let operational: HandoffStore | undefined;
  let lineage: LineageStore | undefined;
  try {
    operational = new HandoffStore(path);
    lineage = new LineageStore(path);
    if (lineage.needsLegacyMigration()) {
      const validated = new Set<string>();
      const failures: string[] = [];
      for (const ref of lineage.legacyBackendRefs()) {
        try {
          if (ref.provider === "stock") {
            await stock.request("thread/read", { threadId: ref.backendThreadId, includeTurns: false });
          } else {
            claude.readThread(ref.backendThreadId, false);
          }
          validated.add(backendKey(ref));
        } catch (error) {
          failures.push(`${backendKey(ref)} (${message(error)})`);
        }
      }
      if (failures.length > 0) {
        throw new Error(
          `Lineage migration blocked because provider backends could not be read: ${failures.join(", ")}. `
          + "The legacy handoff database was left intact.",
        );
      }
      lineage.finalizeLegacyMigration(validated);
    }
    return { operational, lineage };
  } catch (error) {
    lineage?.close();
    operational?.close();
    throw error;
  }
}
