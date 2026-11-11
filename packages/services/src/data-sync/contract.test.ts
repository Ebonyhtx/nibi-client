import { describe, expect, it } from "vitest";
import { dataSyncServiceModule } from "./module.js";

describe("data-sync-service contract", () => {
  it("declares the managed module manifest", () => {
    expect(dataSyncServiceModule.id).toBe("data-sync-service");
    expect(dataSyncServiceModule.publicEntrypoints).toEqual(["index.ts", "contract.ts", "node.ts"]);
    expect(dataSyncServiceModule.requires).toEqual(["services", "shared"]);
  });
});
