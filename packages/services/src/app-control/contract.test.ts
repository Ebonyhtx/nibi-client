import { expect, it } from "vitest";
import {
  APP_CONTROL_METHOD_NAMES,
  APP_CONTROL_METHODS,
  AppControlError,
} from "./contract.js";
import { exampleListProjectsReply, exampleListProjectsRequest } from "./contract.example.js";

it("反向方法名是封闭集合，模型输入不能扩展", () => {
  expect([...APP_CONTROL_METHOD_NAMES]).toEqual([
    "appControl/listProjects",
    "appControl/openSession",
    "appControl/setSessionArchived",
    "appControl/setSessionPinned",
    "appControl/cancel",
    "appControl/sessionCreated",
  ]);
  expect(APP_CONTROL_METHODS.listProjects).toBe("appControl/listProjects");
});

it("请求信封只带可信调用方身份与工作区选择器", () => {
  expect(exampleListProjectsRequest.input).toEqual({});
  expect(exampleListProjectsRequest.callerSessionId).toBe("session_demo");
  expect(exampleListProjectsReply).toMatchObject({
    ok: true,
    result: { searchScope: { unavailableSources: [] } },
  });
});

it("错误保留稳定 code，不把内部错误文本带进模型面", () => {
  const error = new AppControlError("forbidden", "Target is outside the trusted scope");
  expect(error.code).toBe("forbidden");
  expect(error.name).toBe("AppControlError");
});