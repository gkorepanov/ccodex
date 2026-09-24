import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const json = (path: string) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("upgrading from 0.4", () => {
  it("names this version where 0.4's setup looks before handing over to it", () => {
    expect(json("config/compatibility.json").productVersion).toBe(json("package.json").version);
  });
});
