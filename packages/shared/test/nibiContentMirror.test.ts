import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isNibiMirrorContentUrl,
  isNibiPrimaryContentUrl,
  nibiMirrorUrlForContent,
  setNibiMirrorOrigin,
} from "../src/nibiContentMirror.js";

const TEST_MIRROR = "https://mirror.example.test:8443";

// Mirror rewriting is deployment configuration; these tests pin the mapping
// rules with a test origin instead of a production host.
describe("content mirror URL mapping", () => {
  beforeEach(() => setNibiMirrorOrigin(TEST_MIRROR));
  afterEach(() => setNibiMirrorOrigin(""));

  it("maps api / dl hosts to the same path on the mirror", () => {
    expect(
      nibiMirrorUrlForContent("https://api.nibistudio.top/plugins/icons/x.png"),
    ).toBe(`${TEST_MIRROR}/plugins/icons/x.png`);
    expect(nibiMirrorUrlForContent("https://dl.nibistudio.top/plugins/x.zip")).toBe(
      `${TEST_MIRROR}/plugins/x.zip`,
    );
  });

  it("preserves path and query string", () => {
    const mapped = nibiMirrorUrlForContent(
      "https://api.nibistudio.top/api/v1/shares/x/artifacts/1?exp=1&sig=abc",
    );
    expect(mapped).toBe(`${TEST_MIRROR}/api/v1/shares/x/artifacts/1?exp=1&sig=abc`);
  });

  it("never rewrites third-party hosts", () => {
    expect(nibiMirrorUrlForContent("https://example.com/plugins/icons/x.png")).toBeNull();
    expect(nibiMirrorUrlForContent("https://cdn-zcode.z.ai/x.png")).toBeNull();
    expect(nibiMirrorUrlForContent("not a url")).toBeNull();
    expect(nibiMirrorUrlForContent("")).toBeNull();
  });

  it("recognizes primary and mirror hosts", () => {
    expect(isNibiPrimaryContentUrl("https://api.nibistudio.top/plugins/x")).toBe(true);
    expect(isNibiPrimaryContentUrl("https://dl.nibistudio.top/plugins/x")).toBe(true);
    expect(isNibiPrimaryContentUrl("https://api.nibistudio.top.evil.com/x")).toBe(false);
    expect(isNibiMirrorContentUrl(`${TEST_MIRROR}/plugins/x`)).toBe(true);
    expect(isNibiMirrorContentUrl("https://api.nibistudio.top/plugins/x")).toBe(false);
  });

  it("disables mirror rewriting when no origin is configured", () => {
    setNibiMirrorOrigin("");
    expect(nibiMirrorUrlForContent("https://api.nibistudio.top/plugins/x")).toBeNull();
    expect(isNibiMirrorContentUrl("https://mirror.example.test/plugins/x")).toBe(false);
  });
});
