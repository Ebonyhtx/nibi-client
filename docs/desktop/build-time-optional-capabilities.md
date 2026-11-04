# 桌面构建期可选能力

## 目标

三项能力由构建期配置决定是否启用，未配置时一律关闭：

| 能力 | 配置项 | 关闭时的行为 |
| --- | --- | --- |
| ARMS RUM 上报 | `NIBI_ARMS_RUM_ENDPOINT` | 主进程与渲染进程的 ARMS SDK 以 `enable: false` 初始化，不产生上报 |
| 事件上报（数仓） | `NIBI_TELEMETRY_REPORT_ENDPOINT` | 遥测事件在发送前直接返回 |
| 自动更新 | `NIBI_AUTO_UPDATE`（`1`、`true`、`yes` 为启用） | 与 Preview 形态相同，不检查、不下载更新 |

这样同一份源码可以产出“默认不上报、不自动更新”的构建，也可以产出启用这些能力的正式构建，
不需要在源码里写死上报地址。

**红线**：这两个上报端点必须是 **NIBI 自己的接收端**，或者为空（关闭）。不得填上游
（`zcode.z.ai` 及其 CDN/API 域名）或任何第三方代理；否则会把用户/设备数据发到我们不控制的服务。
默认构建（无环境变量、无私有默认配置）恒为空，因此默认关闭。

## 配置来源与优先级

1. 构建进程的环境变量。显式设置为空字符串表示关闭。
2. `config/private/build-defaults.json`。只存在于内部仓库，开源导出不包含。
3. 以上都没有时关闭。

## 所有者与数据流

```
环境变量 / config/private/build-defaults.json
        │ scripts/build-time-config.mjs（唯一解析入口）
        ▼
desktop tsup（main、host、preload）与 desktop vite（renderer）的 define
        │ __NIBI_ARMS_RUM_ENDPOINT__ / __NIBI_TELEMETRY_REPORT_ENDPOINT__ / __NIBI_AUTO_UPDATE_ENABLED__
        ▼
@nibi/shared env 常量 ── 运行时代码只读这些常量
```

- 未注入 define 的环境（测试、其他 bundle）得到关闭值；vitest 为测试注入一个**回环占位端点**
  （`http://127.0.0.1:9/...`，fetch 全部 mock），只为验证重试/请求头链路，不是可配置的上报地址。
- 自动更新在 Desktop Main 启动时判定：`NIBI_PRODUCT_FLAVOR === "production" && NIBI_AUTO_UPDATE_ENABLED`。
- Agent 的 OTLP 遥测沿用既有机制，由打包环境的 `NIBI_PACKAGED_AGENT_OTEL_*` 注入，不在本文件范围内。

## 验收

1. 以后若内部仓库提供私有默认配置，地址必须是 NIBI 自己的接收端；上游域名一律视为配置错误。
2. 没有私有默认配置、也没有环境变量时，三项均关闭。
3. 环境变量优先于私有默认配置，显式空字符串可以关闭单项能力。
4. 类型检查、Lint 与相关单测通过。
