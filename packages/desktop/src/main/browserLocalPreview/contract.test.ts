import { describe, expect, it } from "vitest";
import { browserLocalPreviewModule } from "./module.js";
import { createBrowserLocalPreview } from "./index.js";
import type { BrowserLocalPreview } from "./contract.js";

// 契约测试只依赖 module/contract 与公开入口；具体目录校验场景在
// packages/desktop/test/browserLocalPreview.test.ts 的运行时回归里覆盖。
describe("browser-local-preview contract", () => {
  it("declares its module manifest", () => {
    expect(browserLocalPreviewModule.id).toBe("browser-local-preview");
    expect(browserLocalPreviewModule.publicEntrypoints).toContain("contract.ts");
  });

  it("passes non-file navigation through unchanged", async () => {
    const preview: BrowserLocalPreview = createBrowserLocalPreview();
    await expect(preview.resolveNavigation("https://example.com/a?b=1")).resolves.toBe(
      "https://example.com/a?b=1",
    );
  });
});
