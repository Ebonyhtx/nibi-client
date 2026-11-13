# PROVENANCE —— freeall12/computer-use 快照

| 项 | 值 |
| --- | --- |
| 上游 | https://github.com/freeall12/computer-use |
| 提交 | `eb75db0783ccabb96d3bfae61cfa7aaf0fbf3a3c`（main，快照时间 2026-10-10） |
| 许可 | MIT（全文见同目录 LICENSE，© 2026 freeall12） |
| 取用方式 | 逐文件从 raw.githubusercontent.com 按上述提交抓取，**未做任何修改** |
| 为什么取 | 它是对**我们上游（ZCode）**电脑操控链路的第三方逆向成果（path:line 级证据），并附 cleanroom 参考实现 + 行为准确的 mock broker + 测试。我们要自研这一层（NIBI-Plugins 文档 §14.33–14.35），这批文件是**规格与测试脚手架**。 |
| 纪律 | 它的红线（不含任何专有源码/二进制/凭据）与我们的纪律一致：只放文档与 cleanroom 代码；不把本目录内容当上游代码。 |
| 升级 | 换提交时重跑同一抓取脚本、更新本表并重算 sha256；行为规格有变要同步 NIBI-Plugins 文档。 |

## 文件清单（sha256）

| 文件（本目录内） | 上游路径 | 字节 | sha256 |
| --- | --- | --- | --- |
| `docs/zcode-computer-use.md` | `agents/zcode/computer-use.md` | 12373 | `d737c0ee400bcc0db52c4d50a66d8cb81994216a4231b44e1a3c1aa80a9cd9ca` |
| `docs/zcode-evidence-inventory.md` | `agents/zcode/evidence/inventory.md` | 28968 | `76a32f9405599b2e9a6e7d97d51a4561c48417c9c7079e6b8dcbf6e2af07a1e3` |
| `docs/zcode-README.md` | `agents/zcode/README.md` | 5132 | `ae90c1813708935e04688ffa15c63cac551c2683bb45d5cc1afd4187066cf0b2` |
| `LICENSE` | `LICENSE` | 1066 | `eb28341645c08763517175e2e387e25c5ff7e542e70888f3fdea1f4426e9b196` |
| `reference/computer-use-client.ts` | `source/zcode/reference/computer-use-client.ts` | 26789 | `5332f6becc28220bed15e375819da0ef9fc0076191c13ff9b6b3c0b91cd1c2c2` |
| `reference/mock-broker.ts` | `source/zcode/reference/mock-broker.ts` | 17695 | `952a5900749648b6b3662cdd153691f3d472989cba302a5a8705a8c07ad8a91b` |
| `reference/test.mjs` | `source/zcode/reference/test.mjs` | 11217 | `a919a742bede9bbca83fe324f63844272cad7bf7211977c2444b756eb3e20d77` |
| `reusable/patterns.md` | `reusable/patterns.md` | 45836 | `36fee50f6ae11135b4f4c3d7cb921c4425a14c6c615e72f5e150a1c653bbe8a7` |
| `schemas/computer-tools.json` | `source/zcode/schemas/computer-tools.json` | 13114 | `d4f205d4b1cf3f5b6e977d1dcfb84492905789aef486544ea4cdfb56e10fb995` |

## 各文件用途

* `schemas/computer-tools.json` —— 14 个工具 + 对象面的规范化 schema（实现时的接口依据）。
* `reference/mock-broker.ts` —— **行为准确的宿主+Helper 模拟器**：租约、kill switch 两豁免、
  FrameRegistry（16 帧 + 32 墓碑）、snapshotCache diff 基线、窗口相对派发、`CUA_NOT_READY`
  冷启动退避、`broker_response_ambiguous`、子代理禁用。先拿它当"假引擎"跑通我们的宿主层。
* `reference/computer-use-client.ts` + `reference/test.mjs` —— cleanroom 客户端与对照测试。
* `docs/zcode-*.md` —— 上游实现事实档案（五层架构、工具面、安全五闸、错误码与重试、证据清单）。
* `reusable/patterns.md` —— P1–P24 设计模式与"最小可行架构"配方（后台定向输入四路线、Windows
  命名管道/注册表传输、租约与收据）。
