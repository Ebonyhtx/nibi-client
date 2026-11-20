# vendor/freeall12-computer-use —— 规格与测试脚手架（第三方快照，勿作产品代码）

本目录是第三方逆向研究仓库 [freeall12/computer-use](https://github.com/freeall12/computer-use)（MIT）
的**逐字节快照**，只用于两件事：

1. **规格**：我们自研/桥接电脑操控引擎（`@zcode/zcode-cua` 的真实现）时，接口与行为以
   `schemas/computer-tools.json` + `docs/zcode-*.md` 为准。
2. **测试脚手架**：`reference/mock-broker.ts` 是一个行为准确的"假引擎"，用来在我们的宿主层
   还没接上真引擎时跑通契约（租约 / kill switch / 帧台账 / diff 基线 / 窗口相对派发 / 冷启动退避）。

取用纪律、上游提交与每个文件的 sha256 见 [PROVENANCE.md](./PROVENANCE.md)；许可全文见 [LICENSE](./LICENSE)。
**不要**直接 import 本目录的代码作为产品实现（它是参考实现，不是我们的实现）。
