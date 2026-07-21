import { open, stat } from "node:fs/promises";

export type BackgroundOutputReader = (
  path: string,
  offset: number,
  consume: (bytes: Buffer) => Promise<void>,
) => Promise<number>;

export async function readBackgroundOutput(
  path: string,
  offset: number,
  consume: (bytes: Buffer) => Promise<void>,
): Promise<number> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return offset;
  }
  let next = size < offset ? 0 : offset;
  if (size === next) return next;
  const file = await open(path, "r");
  try {
    while (next < size) {
      const buffer = Buffer.allocUnsafe(Math.min(65_536, size - next));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, next);
      if (bytesRead === 0) break;
      next += bytesRead;
      await consume(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
  return next;
}
