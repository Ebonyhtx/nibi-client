# 架构决策记录（ADR）索引

这里只放**已拍板、仍在影响代码**的决策。已被取代的 ADR 保留原文并标注 `Superseded`，不删除。

| ADR | 状态 | 决策 |
| --- | --- | --- |
| [0001](0001-store-listing-in-marketplace-catalog.md) | Accepted | 商店展示元数据放市场目录层，展示时目录优先、manifest 回退 |
| [0002](0002-plugin-store-style-deviation.md) | Accepted | 插件商店页面有意偏离 DESIGN.md 的克制风格（仅限商店界面） |
| [0003](0003-marketplace-source-removal-keeps-installed-plugins.md) | Accepted（2026-07-15） | 删除 Marketplace Source 时保留已安装插件 |
| [0004](0004-release-packaging-platform-contract.md) | Superseded（2026-11-15） | Release Candidate 由打包平台托管；GitLab runner 前提已不适用 |
| [0005](0005-persisted-data-versioning-and-brand-boundary.md) | Accepted（2026-11-06） | 持久化数据只在 NIBI 键空间内迁移；发布后键名与字段冻结 |

新增 ADR 用 `000N-<kebab-title>.md`，在本表补一行；状态变化时只改表格与文首状态，不改决策正文。
