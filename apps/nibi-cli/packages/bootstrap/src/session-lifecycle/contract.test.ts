import { describe, expect, it } from "vitest";

import { exampleSessionLifecycle } from "./contract.example.js";
import { cliSessionLifecycleModule } from "./module.js";

describe("cli-session-lifecycle contract", () => {
  it("declares its module manifest", () => {
    expect(cliSessionLifecycleModule).toEqual({
      id: "cli-session-lifecycle",
      requires: ["shared", "nibi-cli"],
      provides: ["cli-session-lifecycle"],
      publicEntrypoints: ["index.ts", "contract.ts"],
    });
  });

  it("ships the standard ensureReady/getState/stop sequence", async () => {
    const calls: string[] = [];
    const contract = {
      ensureReady: async (sessionId: string) => void calls.push(`ensure:${sessionId}`),
      getState: async (sessionId: string) => {
        calls.push(`state:${sessionId}`);
        return { sessionId, state: "ready" };
      },
      stop: async (sessionId: string) => void calls.push(`stop:${sessionId}`),
    };
    await exampleSessionLifecycle(contract as never);
    expect(calls).toEqual(["ensure:existing-session", "state:existing-session", "stop:existing-session"]);
  });
});
