import { describe, expect, it } from "vitest";

import {
  WORKSPACE_OPEN_CONFIRM_ARG_PREFIX,
  WORKSPACE_OPEN_CONFIRM_RESULT_CHANNEL,
} from "./contract.js";
import { desktopWorkspaceOpenConfirmModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("desktop-workspace-open-confirm contract", () => {
  it("declares its module manifest", () => {
    expect(desktopWorkspaceOpenConfirmModule.id).toBe("desktop-workspace-open-confirm");
  });

  it("keeps the payload argument and result channel stable", () => {
    // main 与 preload 分属两个 bundle；这两个字面量是它们唯一的握手点，改名会静默丢决定。
    expect(WORKSPACE_OPEN_CONFIRM_ARG_PREFIX).toBe("--nibi-workspace-open-confirm=");
    expect(WORKSPACE_OPEN_CONFIRM_RESULT_CHANNEL).toBe("nibi:workspace-open-confirm-result");
  });
});
