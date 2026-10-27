/**
 * gen-ui-service 的契约面测试（架构门禁要求每个 managed 模块有 contract.test.ts）。
 *
 * 为什么单独一份而不是并进 adapters/*.test.ts：那些测的是**适配器行为**（读文件、持久化、
 * 广播），这一份测的是**契约本身**——通道名、模块声明、示例与类型同步。
 * 通道名进 RPC 注册表：它一变，已发布的 Host 就找不到这个服务（跨进程静默失配）。
 */
import { describe, expect, it } from "vitest";

import { IGenUiService } from "./contract.js";
import { exampleGenUiPrepare } from "./contract.example.js";
import { genUiServiceModule } from "./module.js";

describe("Gen UI 服务契约", () => {
  it("通道名稳定（改了等于让 Host 找不到服务）", () => {
    expect(IGenUiService.channelName).toBe("gen-ui");
  });

  it("模块声明与文件布局自洽", () => {
    expect(genUiServiceModule.id).toBe("gen-ui-service");
    expect(genUiServiceModule.provides).toContain("gen-ui-service");
    // contract.ts 必须是对外口子之一 —— 它就是契约面本身。
    expect(genUiServiceModule.publicEntrypoints).toContain("contract.ts");
  });

  it("依赖声明覆盖它真正用到的层（漏声明会让架构门禁判不出依赖方向）", () => {
    for (const dep of ["services", "shared", "rpc", "gen-ui-protocol", "mcp-apps-protocol"]) {
      expect(genUiServiceModule.requires).toContain(dep);
    }
  });

  it("示例请求与契约同步：作用域三键 + 观察者身份齐备", () => {
    // 示例就是文档里"照着抄这段"；缺字段等于给出会编译失败的示例。
    expect(typeof exampleGenUiPrepare.workspacePath).toBe("string");
    expect(typeof exampleGenUiPrepare.sessionId).toBe("string");
    expect(typeof exampleGenUiPrepare.path).toBe("string");
    // ownerWebContentsId 是"谁拥有这个沙箱"的凭据，不能省。
    expect(typeof exampleGenUiPrepare.ownerWebContentsId).toBe("number");
    expect(typeof exampleGenUiPrepare.instanceKey).toBe("string");
    expect(exampleGenUiPrepare.html).toContain("<div");
    // 路径指向 HTML 片段（契约：生成物是 HTML，不是任意文件）。
    expect(exampleGenUiPrepare.path.endsWith(".html")).toBe(true);
  });
});
