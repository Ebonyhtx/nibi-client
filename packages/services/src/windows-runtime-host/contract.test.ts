import { describe, expect, it } from "vitest";

import {
  WINDOWS_RUNTIME_HOST_EOF_GRACE_MS,
  WINDOWS_RUNTIME_HOST_STARTUP_TIMEOUT_MS,
} from "./contract.js";
import { windowsRuntimeHostModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。
describe("windows-runtime-host contract", () => {
  it("declares its module manifest", () => {
    expect(windowsRuntimeHostModule.id).toBe("windows-runtime-host");
    expect(windowsRuntimeHostModule.publicEntrypoints).toContain("index.ts");
    expect(windowsRuntimeHostModule.publicEntrypoints).toContain("contract.ts");
  });

  it("keeps the native EOF grace and startup budget explicit", () => {
    expect(WINDOWS_RUNTIME_HOST_EOF_GRACE_MS).toBe(1_800);
    expect(WINDOWS_RUNTIME_HOST_STARTUP_TIMEOUT_MS).toBe(10_000);
  });
});
