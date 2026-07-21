import { createHash } from "node:crypto";
import type { Model } from "../codex/generated/v2/Model.js";
import type { ModelListParams } from "../codex/generated/v2/ModelListParams.js";
import type { ModelListResponse } from "../codex/generated/v2/ModelListResponse.js";
import type { ClaudeModelCatalog } from "../claude/modelCatalog.js";
import type { Logger } from "../observability/logger.js";
import type { StockRpc } from "./stockRpc.js";
import { CursorCodec, queryFingerprint } from "../protocol/cursor.js";
import { invalidParams } from "../protocol/errors.js";

interface HybridCursor {
  readonly version: string;
  readonly offset: number;
  readonly query: string;
}

async function stockModels(stock: StockRpc, includeHidden: boolean): Promise<Model[]> {
  const models: Model[] = [];
  let cursor: string | null = null;
  do {
    const result = await stock.request("model/list", {
      cursor,
      limit: 100,
      includeHidden,
    }) as ModelListResponse;
    models.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor);
  return models;
}

export async function mergedModelList(
  params: ModelListParams,
  stock: StockRpc,
  claude: ClaudeModelCatalog,
  logger: Logger,
  cursors: CursorCodec,
): Promise<ModelListResponse> {
  const includeHidden = params.includeHidden ?? false;
  const [stockCatalog, claudeCatalog] = await Promise.all([
    stockModels(stock, includeHidden),
    claude.list().catch((error: unknown) => {
      logger.warn("claude.models.unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }),
  ]);
  const catalog = [...stockCatalog, ...claudeCatalog];
  const version = createHash("sha256").update(catalog.map((model) => model.id).join("\0")).digest("hex").slice(0, 16);
  const query = queryFingerprint({ includeHidden });
  const cursor = cursors.decode<HybridCursor>("model", params.cursor);
  if (cursor && (!Number.isInteger(cursor.offset) || cursor.offset < 0 || cursor.version !== version || cursor.query !== query)) {
    throw invalidParams("Model catalog or pagination query changed; restart pagination.");
  }
  const offset = cursor?.offset ?? 0;
  const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
  const data = catalog.slice(offset, offset + limit);
  const nextOffset = offset + data.length;
  return {
    data,
    nextCursor: nextOffset < catalog.length ? cursors.encode("model", { version, offset: nextOffset, query }) : null,
  };
}
