// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  getV4EditorId,
  regenerateV4EditorId,
  resetV4EditorIdCacheForTests,
} from "@/v4/editorIdentity.js";

describe("v4 editor identity", () => {
  afterEach(() => {
    resetV4EditorIdCacheForTests();
    try {
      sessionStorage.clear();
    } catch {
      // node 环境没有 sessionStorage。
    }
  });

  it("同一标签页内稳定，并写入 sessionStorage", () => {
    const first = getV4EditorId();
    expect(first).toMatch(/^editor-/);
    expect(getV4EditorId()).toBe(first);
    expect(sessionStorage.getItem("nibi-v4-editor-id:v1")).toBe(first);
  });

  it("prefers the persisted sessionStorage identity", () => {
    sessionStorage.setItem("nibi-v4-editor-id:v1", "editor-persisted");
    expect(getV4EditorId()).toBe("editor-persisted");
  });

  it("regenerate 会产生新的 editorId 并写回", () => {
    const first = getV4EditorId();
    const next = regenerateV4EditorId();
    expect(next).not.toBe(first);
    expect(getV4EditorId()).toBe(next);
    expect(sessionStorage.getItem("nibi-v4-editor-id:v1")).toBe(next);
  });
});
