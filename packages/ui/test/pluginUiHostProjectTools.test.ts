import { describe, expect, it } from "vitest";
import { parseHostProjectToolCall } from "../src/plugin-ui/app/pluginUiHostProjectTools.js";

describe("面板云端保留工具名", () => {
  it("普通插件工具原样放行", () => {
    expect(parseHostProjectToolCall("panel_api", { path: "/state" })).toBeNull();
  });

  it("未知的 nibi_cloud_ 前缀直接报错，不转发给插件 server", () => {
    expect(parseHostProjectToolCall("nibi_cloud_delete_everything", {})).toEqual({
      error: "未知的云端操作：nibi_cloud_delete_everything",
    });
  });

  it("list 不需要参数", () => {
    expect(parseHostProjectToolCall("nibi_cloud_list", undefined)).toEqual({
      request: { action: "list" },
    });
  });

  it("create / join 去掉首尾空白并拒绝空值", () => {
    expect(parseHostProjectToolCall("nibi_cloud_create", { name: "  数模 A  " })).toEqual({
      request: { action: "create", name: "数模 A" },
    });
    expect(parseHostProjectToolCall("nibi_cloud_create", { name: "   " })).toEqual({
      error: "请填写项目名称",
    });
    expect(parseHostProjectToolCall("nibi_cloud_join", { inviteCode: "" })).toEqual({
      error: "请填写邀请码",
    });
  });

  it("version 只接受正整数版本号", () => {
    expect(parseHostProjectToolCall("nibi_cloud_version", { projectId: "p1", revision: 3 }))
      .toEqual({ request: { action: "version", projectId: "p1", revision: 3 } });
    for (const revision of [0, -1, 1.5, "2", null]) {
      expect(parseHostProjectToolCall("nibi_cloud_version", { projectId: "p1", revision }))
        .toEqual({ error: "版本号必须是正整数" });
    }
  });

  it("upload 的提交说明可选、会裁剪并截到 500 字", () => {
    expect(parseHostProjectToolCall("nibi_cloud_upload", { projectId: "p1" })).toEqual({
      request: { action: "upload", projectId: "p1" },
    });
    expect(
      parseHostProjectToolCall("nibi_cloud_upload", { projectId: "p1", message: "  初稿  " }),
    ).toEqual({ request: { action: "upload", projectId: "p1", message: "初稿" } });
    const long = parseHostProjectToolCall("nibi_cloud_upload", {
      projectId: "p1",
      message: "x".repeat(800),
    });
    expect(long && "request" in long && long.request.action === "upload"
      ? long.request.message?.length
      : null).toBe(500);
    expect(parseHostProjectToolCall("nibi_cloud_upload", { projectId: "p1", message: 3 })).toEqual({
      error: "提交说明必须是文本",
    });
  });

  it("status / pull 必须带项目 ID", () => {
    expect(parseHostProjectToolCall("nibi_cloud_status", {})).toEqual({
      error: "请填写项目 ID",
    });
    expect(parseHostProjectToolCall("nibi_cloud_pull", { projectId: " abc " })).toEqual({
      request: { action: "pull", projectId: "abc" },
    });
  });

  it("resolve 校验草稿版本号与逐文件选择", () => {
    expect(
      parseHostProjectToolCall("nibi_cloud_resolve", {
        projectId: " p1 ",
        revision: 5,
        choices: { "a.tex": "ours", "b.pdf": "theirs" },
      }),
    ).toEqual({
      request: {
        action: "resolve",
        projectId: "p1",
        revision: 5,
        choices: { "a.tex": "ours", "b.pdf": "theirs" },
      },
    });
    expect(
      parseHostProjectToolCall("nibi_cloud_resolve", { projectId: "p1", revision: 5 }),
    ).toEqual({ error: "choices 必须是逐文件选择对象" });
    expect(
      parseHostProjectToolCall("nibi_cloud_resolve", {
        projectId: "p1",
        revision: 5,
        choices: { "a.tex": "mine" },
      }),
    ).toEqual({ error: "冲突选择无效：a.tex" });
    expect(
      parseHostProjectToolCall("nibi_cloud_resolve", {
        projectId: "p1",
        revision: 5,
        choices: {},
      }),
    ).toEqual({ error: "至少选择一个文件" });
    expect(
      parseHostProjectToolCall("nibi_cloud_resolve", {
        projectId: "p1",
        revision: 0,
        choices: { "a.tex": "ours" },
      }),
    ).toEqual({ error: "草稿版本号必须是正整数" });
  });
});
