import { expect, it } from "vitest";
import { parseClientConfigSnapshot } from "../src/clientConfig.js";

it("有效的空响应撤销公开配置，未知字段不会透传", () => {
  expect(parseClientConfigSnapshot({ code: 0, data: null })).toEqual({
    pluginStoreOrder: null,
    uiPluginRecommendations: [],
  });
  expect(
    parseClientConfigSnapshot({ code: 0, data: { configs: { privateField: "not public" } } }),
  ).toEqual({ pluginStoreOrder: null, uiPluginRecommendations: [] });
});

it("严格校验 envelope 并隔离坏的模式字段", () => {
  expect(() => parseClientConfigSnapshot({ code: 1001 })).toThrow(
    "Invalid public client config response",
  );
  expect(() => parseClientConfigSnapshot({ data: { configs: {} } })).toThrow();
  expect(
    parseClientConfigSnapshot({
      code: 0,
      data: {
        configs: {
          pluginStoreOrder: {
            code: { categoryOrder: 3 },
            work: { categoryOrder: ["finance"] },
          },
        },
      },
    }),
  ).toEqual({
    pluginStoreOrder: { work: { categoryOrder: ["finance"] } },
    uiPluginRecommendations: [],
  });
});

it("读取 UI 推荐且只保留插件和面板身份", () => {
  expect(
    parseClientConfigSnapshot({
      code: 0,
      data: {
        configs: {
          uiPluginRecommendations: [
            { pluginId: " panel@example ", surfaceId: " main ", resourceUri: "not trusted" },
          ],
        },
      },
    }).uiPluginRecommendations,
  ).toEqual([{ pluginId: "panel@example", surfaceId: "main" }]);
});

it.each([
  undefined,
  null,
  {},
  [],
  [{ pluginId: "p" }],
  [{ pluginId: "", surfaceId: "s" }],
  [{ pluginId: "p", surfaceId: 2 }],
])("无效或空推荐返回空列表：%j", (uiPluginRecommendations) => {
  const snapshot = parseClientConfigSnapshot({
    code: 0,
    data: { configs: { uiPluginRecommendations } },
  });
  expect(snapshot.uiPluginRecommendations).toEqual([]);
});
