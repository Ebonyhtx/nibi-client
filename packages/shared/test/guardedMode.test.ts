import { describe, expect, it } from "vitest";
import {
  getNibiAgentAvailableModes,
  getNibiAgentModeSelectOptions,
  normalizeAvailableNibiMode,
} from "../src/nibi-agent-model-state.js";
import { submissionModeSchema } from "../src/nibi-protocol-v4/submission.js";
import { nibiSessionModeSchema } from "../src/nibi-protocol-legacy-types.js";
import { executionStateSchema, resolveExecutionState } from "../src/execution-state.js";

describe("guarded wire and mode catalog", () => {
  it("preserves guarded across independent Plan transitions and serialization", () => {
    const current = resolveExecutionState({ mode: "guarded", planEnabled: true });
    expect(executionStateSchema.parse(current)).toEqual({ mode: "guarded", planEnabled: true });
    expect(resolveExecutionState({ planEnabled: false }, current)).toEqual({
      mode: "guarded",
      planEnabled: false,
    });
  });
  it("round trips the opt-in value without changing the default", () => {
    expect(submissionModeSchema.parse("guarded")).toBe("guarded");
    expect(nibiSessionModeSchema.parse("guarded")).toBe("guarded");
    expect(normalizeAvailableNibiMode("guarded")).toBe("guarded");
    const ids = getNibiAgentAvailableModes().map((mode) => mode.id);
    expect(ids).toEqual(["build", "guarded", "plan", "yolo"]);
    expect(getNibiAgentModeSelectOptions().map((option) => option.value)).toEqual(ids);
    expect(submissionModeSchema.safeParse("unknown").success).toBe(false);
  });
  it("keeps historical edit valid without advertising it as a new choice", () => {
    expect(submissionModeSchema.parse("edit")).toBe("edit");
    expect(nibiSessionModeSchema.parse("edit")).toBe("edit");
    expect(normalizeAvailableNibiMode("edit")).toBe("edit");
    expect(getNibiAgentAvailableModes().some((mode) => mode.id === "edit")).toBe(false);
  });
});
