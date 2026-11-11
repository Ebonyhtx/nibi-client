import { describe, expect, it } from "vitest";
import { dataSyncModule } from "./module.js";

describe("data-sync UI contract", () => {
  it("declares the managed module manifest", () => {
    expect(dataSyncModule.id).toBe("data-sync");
    expect(dataSyncModule.publicEntrypoints).toEqual(["index.ts", "contract.ts"]);
    expect(dataSyncModule.requires).toEqual(["services", "settings-scope", "shared", "ui"]);
  });
});
